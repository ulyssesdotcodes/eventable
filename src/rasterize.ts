// eventable rasterize — Houdini-style bake: expand sparse object events
// (create/update/color/destroy, keyed by `id`) into a dense frame-indexed
// cache, one row per alive object per frame, on the FRAMES_PER_BEAT grid.
// Timing fields (`beat`, `dur`) are in beats, 1-indexed (beat 1 = frame 0).
// The beat axis is absolute: events past the loop's end just bake further
// along the grid, and playback wraps the playhead into it in loop-length
// passes (see the scene visualizer in visualizer.ts).

import { withLineage, unionLineage, getLineage, type Row } from './lineage.js'
import { mixColor } from './color.js'
import { beatToFrame, beatsToFrames, frameToBeat } from './constants.js'
// dsl.ts imports rasterizeRows back; the cycle is benign — each side only
// calls the other at runtime, never during module evaluation.
import { EASINGS, isBinding, isStreamingNode, evalExpr, substituteExpr, getWarp } from './dsl.js'
import { sourceAt, type TimelineSegment } from './timeline.js'

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

// An `ease` cell holds a function from code or an easing NAME from a table
// cell — resolve both, so editable keyframes stop silently playing linear.
function easeFnOf(e: unknown): ((t: number) => number) | null {
  if (typeof e === 'function') return e as (t: number) => number
  if (typeof e === 'string' && e in EASINGS) return EASINGS[e as keyof typeof EASINGS]
  return null
}

interface SampledState {
  fields: Row
  sources: Row[]
  parts: Record<PartKind, (number | null)[]> | null
}

// Fields rasterize interprets itself. Anything else — a custom field, or a
// { $expr } streaming binding — is "extra": carried through to each baked row
// untouched, to be read (and bindings resolved) at playback. `loop` is the
// retired pass column: still reserved so old tables carrying one stay inert.
const RESERVED = new Set([
  'id', 'event', 'beat', 'loop', 'dur', 'ease', 'to', 'shape', 'color',
  'px', 'py', 'pz', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz', 'frame',
  // element handles: interpreted into vertColor/faceColor/edgeColor
  'vert', 'face', 'edge',
])

type PartKind = 'vert' | 'face' | 'edge'
const partKey = (e: Row): PartKind | null =>
  typeof e.vert === 'number' ? 'vert'
    : typeof e.face === 'number' ? 'face'
      : typeof e.edge === 'number' ? 'edge' : null

// Non-reserved fields visible at frame `i`: events at-or-before, last write wins.
// An event addressing ONE element speaks only for that element, so its columns
// stay out of the object's own state — otherwise painting a face by
// origami().faces() would stamp that table's whole vocabulary (plies, layer,
// sheetX, …) onto the paper itself.
function gatherExtra(events: Row[], i: number): Row {
  const extra: Row = {}
  for (const e of events) {
    if ((e.frame as number) > i || partKey(e)) continue
    for (const k in e) {
      if (!RESERVED.has(k)) extra[k] = e[k]
    }
  }
  return extra
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

// Resolve event timing to the frame grid: `beat` (1-indexed) → cache frame,
// `dur` (beats) → frames.
function toFrameEvent(e: Row): Row {
  const ev = { ...e }
  ev.frame = beatToFrame((e.beat as number | undefined) ?? 1)
  if (ev.dur != null) ev.dur = beatsToFrames(ev.dur as number)
  return ev
}

function buildTimelines(events: Row[]): Map<unknown, Row[]> {
  const map = new Map<unknown, Row[]>()
  for (const e of events) {
    if (e.id == null) continue
    if (!map.has(e.id)) map.set(e.id, [])
    map.get(e.id)!.push({ ...e })
  }
  for (const evs of map.values()) evs.sort((a, b) => (a.frame as number) - (b.frame as number))
  return map
}

// A `color` row carrying `face`/`edge` paints one element of the object, not
// the object — it must not reach the whole-object color, and vice versa.
// One element's pulse at frame i. With `dur` it fades toward `to` — or, unset,
// toward the object's own color — and RELEASES the element when it lands, so
// the paint hands back to whatever the shape would have drawn. Without `dur`
// it is a hard switch that holds: an element handle is not identity (for a
// folding paper, face 3 is different paper after the next fold), so a paint
// that never lets go bleeds onto the wrong element later.
function partPulseAt(colorEv: Row, objColor: number | null, i: number): number | null {
  const dur = colorEv.dur as number | undefined
  if (dur == null || dur <= 0) return colorEv.color as number | null
  const p = Math.min(1, Math.max(0, (i - (colorEv.frame as number)) / dur))
  if (p >= 1) return null
  const base = (colorEv.to as number | null | undefined) ?? objColor
  if (typeof colorEv.color !== 'number' || (base != null && typeof base !== 'number')) {
    return colorEv.color as number | null
  }
  const ease = easeFnOf(colorEv.ease)
  return mixColor(colorEv.color, base, ease ? ease(p) : p)
}

// Per-element colors at frame i, indexed by element number (null = unpainted).
function samplePartColors(
  events: Row[], createEv: Row, i: number,
): Record<PartKind, (number | null)[]> {
  const out: Record<PartKind, (number | null)[]> = { vert: [], face: [], edge: [] }
  const objColor = (createEv.color as number | null | undefined) ?? null
  for (const e of events) {
    if (e.event !== 'color' || (e.frame as number) > i) continue
    const kind = partKey(e)
    if (!kind) continue
    out[kind][e[kind] as number] = partPulseAt(e, objColor, i)
  }
  return out
}

// Element-color lists change only while a pulse is running, so hand the same
// array object back when a frame's is identical to the last — cook-transfer
// memoizes by identity, and this is what keeps a per-frame cache of per-face
// data from multiplying across the worker boundary.
function sharedIfSame(prev: (number | null)[] | undefined, next: (number | null)[]): (number | null)[] {
  if (!prev || prev.length !== next.length) return next
  for (let i = 0; i < next.length; ++i) if (prev[i] !== next[i]) return next
  return prev
}

// `color` events are a pulse/step, not a keyframe: a bare event is a hard
// switch (newest wins); with `dur` it decays back to `to` (or the base color).
function sampleColor(events: Row[], createEv: Row, i: number): { color: number | null; source: Row | null } {
  let colorEv: Row | null = null
  for (const e of events) {
    if (e.event === 'color' && (e.frame as number) <= i && !partKey(e)) colorEv = e
  }
  if (!colorEv) return { color: (createEv.color as number | null | undefined) ?? null, source: null }

  const dur = colorEv.dur as number | undefined
  if (dur == null || dur <= 0) return { color: colorEv.color as number | null, source: colorEv }

  const base = colorEv.to != null
    ? (colorEv.to as number | null)
    : ((createEv.color as number | null | undefined) ?? (colorEv.color as number | null))
  // The decay bit-mixes its endpoints, which an expression value can't ride —
  // a binding endpoint makes the event a plain step instead.
  if (typeof colorEv.color !== 'number' || (base != null && typeof base !== 'number')) {
    return { color: colorEv.color as number | null, source: colorEv }
  }
  const p = Math.min(1, Math.max(0, (i - (colorEv.frame as number)) / dur))
  const ease = easeFnOf(colorEv.ease)
  const eased = ease ? ease(p) : p
  return { color: mixColor(colorEv.color, base, eased), source: colorEv }
}

// Numeric fields that must NOT interpolate as tracks: timing bookkeeping,
// identity, and the colors (a packed 0xRRGGBB lerps as one integer, which
// bleeds channels; `color` also has its own pulse semantics).
const NO_TRACK = new Set(['frame', 'beat', 'loop', 'dur', 'id', 'color', 'backColor'])

function sampleObject(events: Row[], i: number, extent: number): SampledState | null {
  const createEv = events.find((e) => e.event === 'create')
  if (!createEv || i < (createEv.frame as number)) return null
  if (events.some((e) => e.event === 'destroy' && (e.frame as number) <= i)) return null

  const keyframes = events.filter((e) => e.event === 'create' || e.event === 'update')

  const fields: Row = { ...createEv }
  Object.assign(fields, gatherExtra(events, i))

  // Numeric fields are per-field TRACKS: each eases between the previous and
  // next keyframe that actually carry it, so keyframes omitting a field don't
  // interrupt its glide. An `ease` on the destination keyframe shapes that
  // segment. Expression ({ $expr }) values are first-class keyframe values on
  // every track: they hold streaming over their span (with per-frame
  // progress() substituted) and terminate numeric segments — numeric↔expr
  // transitions step, never lerp through the expression.
  const names = new Set<string>()
  for (const kf of keyframes) {
    for (const k in kf) {
      if (NO_TRACK.has(k)) continue
      const v = kf[k]
      if (typeof v === 'number' || isBinding(v)) names.add(k)
    }
  }
  const sources = new Set<Row>([createEv])
  for (const name of names) {
    let prev: Row | null = null
    let next: Row | null = null
    for (const kf of keyframes) {
      const v = kf[name]
      if (typeof v !== 'number' && !isBinding(v)) continue
      if ((kf.frame as number) <= i) prev = kf
      else {
        next = kf
        break
      }
    }
    if (!prev) continue
    sources.add(prev)
    const pv = prev[name]
    if (isBinding(pv)) {
      // progress() spans the keyframe's own `dur` (frames here) if set, else
      // its per-field segment to the next keyframe carrying this field, else
      // the object's remaining life (destroy frame or bake extent).
      const start = prev.frame as number
      const dur = typeof prev.dur === 'number' && prev.dur > 0 ? prev.dur : 0
      const destroy = events.find((e) => e.event === 'destroy')
      const end = dur > 0 ? start + dur
        : next ? (next.frame as number)
          : destroy ? (destroy.frame as number) : extent
      const u = end > start ? clamp01((i - start) / (end - start)) : 1
      const node = substituteExpr(pv.$expr, { progress: u })
      fields[name] = isStreamingNode(node) ? { $expr: node } : evalExpr(node, fields, i)
    } else if (next && typeof next[name] === 'number') {
      // 'step' is a HOLD keyframe: prev's value stays put until next's beat, then
      // jumps (next becomes prev at its own frame). Otherwise ease the segment.
      if (next.ease === 'step') {
        fields[name] = pv
      } else {
        const raw = (i - (prev.frame as number)) / ((next.frame as number) - (prev.frame as number))
        const ease = easeFnOf(next.ease)
        const t = ease ? ease(raw) : raw
        fields[name] = lerp(pv as number, next[name] as number, t)
      }
      sources.add(next)
    } else {
      fields[name] = pv
    }
  }

  const { color, source: colorSource } = sampleColor(events, createEv, i)
  fields.color = color
  if (colorSource) sources.add(colorSource)

  const parts = events.some((e) => e.event === 'color' && partKey(e))
    ? samplePartColors(events, createEv, i) : null
  return { fields, sources: [...sources], parts }
}

// ── The frame store ─────────────────────────────────────────────────────────
// A column of one object as a sparse list: `at[i]` is the frame its value
// starts on, `val[i]` the value there. Most columns of most objects never
// change at all — a static prop is one entry per column, and the crane's
// topology is one entry per element — so a per-frame bake would be storing the
// same value ~1,500 times over.
interface Track {
  at: number[]
  val: unknown[]
  // Set when the entries are KEYFRAMES the reader interpolates between; absent
  // when they are RUNS of an already-resolved per-frame bake, which hold their
  // value until the next one.
  keyed?: true
  // Easing INTO val[i], allocated only once a keyframe actually carries one.
  // On a real model none of them do, and a parallel array of 133,000
  // `undefined` was an eighth of the whole store.
  ease?: unknown[]
}

interface ObjectTracks {
  id: unknown
  born: number
  dies: number            // exclusive: the frame it stops being drawn
  cols: Record<string, Track>
  // resolved once: the union is per object, and rebuilding it on every sampled
  // frame dominated playback once a scene held hundreds of elements
  lineage: ReturnType<typeof getLineage>
  // A .retime()'d object is READ at a warped time rather than having its rows
  // moved, so it keeps its source beats and carries the map here — as segment
  // data, not a closure, since the store crosses to the worker.
  warp?: TimelineSegment[]
  // A lifecycle row that was NOT retimed speaks in playback time — a destroy
  // concatenated after a .retime() means "stop drawing this at beat 25", not
  // "at whatever source beat 25 happens to show". The warp decides which pose
  // an object wears, not whether it is there.
  diesPlay?: number
}

export interface FrameStore {
  objects: ObjectTracks[]
  maxFrame: number
}

// ── A mesh as buffers ───────────────────────────────────────────────────────
// Element rows describe a mesh one vertex, face, triangle and crease at a time,
// which is what makes it inspectable and joinable — and hopeless as a
// transport: a folded paper is a couple of thousand sibling objects, each
// materialised into a row on every frame, then gathered back out of hash maps
// by the renderer. The store compiles them ONCE into what a renderer actually
// wants. The rows stay in the table; nothing downstream has to walk them.
//
// Positions sit on one shared keyframe axis, so a frame is a single search and
// two lerps for the whole mesh rather than a search per column per element.
// Everything else is fixed topology as plain indices, which is what a corner
// of a triangle needs to know to find its vertex.
export interface MeshSlab {
  axis: Int32Array          // frames the positions are keyed on
  vpos: Float32Array        // axis.length blocks of nv * 3
  foff: Float32Array        // axis.length blocks of nf * 3 — the layer offset
  cornerVert: Int32Array    // 3 per triangle, in draw order
  cornerFace: Int32Array    // 1 per triangle
  endVert: Int32Array       // 2 per crease
  endFace: Int32Array       // 1 per crease, -1 where no face claims it
  nv: number
  nf: number
}

// An element row names which piece of the mesh it IS. `of` is what ties it to
// the mesh — a row without one is an ordinary object that happens to have a
// `face` column.
const elementOf = (r: Row): { kind: 'vert' | 'face' | 'tri' | 'edge'; i: number } | null => {
  if (r.of == null) return null
  // `tri` first: a triangle names the face it belongs to as well as itself
  for (const kind of ['tri', 'vert', 'face', 'edge'] as const) {
    if (typeof r[kind] === 'number') return { kind, i: r[kind] as number }
  }
  return null
}

// Value of a numeric column at a frame, holding the last keyframe and easing
// into the next — the same reading rowAt gives it, done for one column.
const valueAt = (t: Track | undefined, frame: number): number => {
  if (!t || !t.at.length) return 0
  let lo = 0, hi = t.at.length - 1, i = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (t.at[mid] <= frame) { i = mid; lo = mid + 1 } else hi = mid - 1
  }
  if (i < 0) return typeof t.val[0] === 'number' ? (t.val[0] as number) : 0
  const v = t.val[i]
  if (typeof v !== 'number') return 0
  const nx = t.val[i + 1]
  const span = i + 1 < t.at.length ? t.at[i + 1] - t.at[i] : 0
  if (typeof nx !== 'number' || span <= 0 || t.ease?.[i + 1] === 'step') return v
  const raw = Math.min(1, Math.max(0, (frame - t.at[i]) / span))
  const fn = easeFnOf(t.ease?.[i + 1])
  return v + (nx - v) * (fn ? fn(raw) : raw)
}

// Compile one mesh's element objects into buffers. Topology is whatever the
// elements last say it is — the emitters state it once and never restate it,
// which is what lets a corner index mean the same paper for the whole timeline.
function buildSlab(elements: ObjectTracks[]): MeshSlab | null {
  const of: Record<'vert' | 'face' | 'tri' | 'edge', Map<number, ObjectTracks>> = {
    vert: new Map(), face: new Map(), tri: new Map(), edge: new Map(),
  }
  const at = new Set<number>()
  for (const o of elements) {
    for (const kind of ['tri', 'vert', 'face', 'edge'] as const) {
      const t = o.cols[kind]
      if (!t || typeof t.val[0] !== 'number') continue
      of[kind].set(t.val[0] as number, o)
      break
    }
    for (const c of ['px', 'py', 'pz', 'ox', 'oy', 'oz']) {
      const t = o.cols[c]
      if (t) for (const f of t.at) at.add(f)
    }
  }
  if (!of.tri.size) return null
  const axis = Int32Array.from(at.size ? [...at].sort((a, b) => a - b) : [0])
  const nv = Math.max(0, ...of.vert.keys()) + (of.vert.size ? 1 : 0)
  const nf = Math.max(0, ...of.face.keys()) + (of.face.size ? 1 : 0)

  const vpos = new Float32Array(axis.length * nv * 3)
  const foff = new Float32Array(axis.length * nf * 3)
  for (let k = 0; k < axis.length; ++k) {
    for (const [i, o] of of.vert) {
      const b = (k * nv + i) * 3
      vpos[b] = valueAt(o.cols.px, axis[k])
      vpos[b + 1] = valueAt(o.cols.py, axis[k])
      vpos[b + 2] = valueAt(o.cols.pz, axis[k])
    }
    for (const [i, o] of of.face) {
      const b = (k * nf + i) * 3
      foff[b] = valueAt(o.cols.ox, axis[k])
      foff[b + 1] = valueAt(o.cols.oy, axis[k])
      foff[b + 2] = valueAt(o.cols.oz, axis[k])
    }
  }

  // draw order is the element numbering, so what is drawn never depends on the
  // order rows happened to arrive in
  const tris = [...of.tri.keys()].sort((a, b) => a - b)
  const cornerVert = new Int32Array(tris.length * 3)
  const cornerFace = new Int32Array(tris.length)
  tris.forEach((ti, n) => {
    const c = of.tri.get(ti)!.cols
    cornerFace[n] = (c.face?.val[0] as number) ?? 0
    cornerVert[n * 3] = (c.v0?.val[0] as number) ?? 0
    cornerVert[n * 3 + 1] = (c.v1?.val[0] as number) ?? 0
    cornerVert[n * 3 + 2] = (c.v2?.val[0] as number) ?? 0
  })
  // a crease is drawn on the layer of a face that owns it, as before: the first
  // triangle in draw order that names one of its ends
  const faceOfVert = new Int32Array(nv).fill(-1)
  for (let n = tris.length - 1; n >= 0; --n) {
    for (let c = 0; c < 3; ++c) faceOfVert[cornerVert[n * 3 + c]] = cornerFace[n]
  }
  const edges = [...of.edge.keys()].sort((a, b) => a - b)
  const endVert = new Int32Array(edges.length * 2)
  const endFace = new Int32Array(edges.length)
  edges.forEach((ei, n) => {
    const c = of.edge.get(ei)!.cols
    const a = (c.a?.val[0] as number) ?? 0, b = (c.b?.val[0] as number) ?? 0
    endVert[n * 2] = a
    endVert[n * 2 + 1] = b
    endFace[n] = faceOfVert[a] >= 0 ? faceOfVert[a] : faceOfVert[b]
  })
  return { axis, vpos, foff, cornerVert, cornerFace, endVert, endFace, nv, nf }
}

// Fields eased between whole frames; everything else steps. The runs hold the
// exact per-frame values either way — this only decides what a FRACTIONAL
// frame does, so playback stays smooth when the playhead crosses frames slower
// than one per render.
const INTERP_FIELDS = new Set(['px', 'py', 'pz', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'])

const pushRun = (cols: Record<string, Track>, key: string, frame: number, value: unknown): void => {
  let t = cols[key]
  if (!t) { t = { at: [], val: [] }; cols[key] = t }
  if (t.at.length && t.val[t.val.length - 1] === value) return
  t.at.push(frame)
  t.val.push(value)
}

// Columns a track never holds: identity, the sparse beat grid, and `ease`,
// which shapes a segment rather than being one.
const RESERVED_TRACK = new Set(['id', 'event', 'beat', 'loop', 'frame', 'ease'])

// Most objects are plain keyframes: a position that eases, a topology column
// that never changes. Those need no per-frame bake at all — keep the keyframes
// and interpolate on read, which is both what playback wants and what stops a
// scene of thousands of elements costing objects × frames to build.
//
// An object is only densified when something about it can change on a frame no
// event names: a streaming { $expr } or a colour pulse decaying. A function
// `ease` goes that way too — resolving it at bake time is what lets it close
// over anything, since the store crosses to the worker as data. Everything
// else takes this path.
function keyframeObject(evs: Row[], maxFrame: number): ObjectTracks | null {
  const createEv = evs.find((e) => e.event === 'create')
  if (!createEv) return null
  for (const e of evs) {
    if (e.event === 'color' || typeof e.ease === 'function') return null
    for (const k in e) if (isBinding(e[k])) return null
  }
  const destroy = evs.find((e) => e.event === 'destroy')
  const warp = evs.map(getWarp).find(Boolean)
  const unwarpedDeath = warp && destroy && !getWarp(destroy)
  const o: ObjectTracks = {
    id: evs[0].id,
    born: createEv.frame as number,
    // `dies` is compared against the frame the object is READ at, which for a
    // warped one is a source frame — and the store's extent is in playback
    // frames, a different axis. Only a real destroy bounds it.
    dies: destroy && !unwarpedDeath ? (destroy.frame as number)
      : warp ? Infinity : maxFrame + 1,
    cols: {},
    lineage: unionLineage(evs),
    ...(warp ? { warp } : {}),
    ...(unwarpedDeath ? { diesPlay: destroy.frame as number } : {}),
  }
  const key = (k: string, frame: number, v: unknown, ease: unknown): void => {
    let t = o.cols[k]
    if (!t) { t = { at: [], val: [], keyed: true }; o.cols[k] = t }
    // Restating a NUMBER means "hold here", so it earns its keyframe. Restating
    // anything else cannot: nothing interpolates through it. Every update row
    // repeats its `of`, which is a quarter of the crane's store on its own.
    if (t.at.length && t.val[t.val.length - 1] === v && typeof v !== 'number') return
    if (ease !== undefined && !t.ease) t.ease = new Array(t.at.length).fill(undefined)
    if (t.ease) t.ease[t.at.length] = ease
    t.at.push(frame)
    t.val.push(v)
  }
  // A create row's fields hold from its frame on, even where a later keyframe
  // never mentions them again; `color` is one of them, since with no colour
  // events there is no pulse to resolve. `vert`/`face`/`edge` are ordinary
  // columns here — they name this element's own identity, not a handle into
  // another object, which is only how a `color` row reads them.
  for (const e of evs) {
    if (e.event !== 'create' && e.event !== 'update') continue
    for (const k in e) {
      if (RESERVED_TRACK.has(k)) continue
      key(k, e.frame as number, e[k], e.ease)
    }
  }
  // the densified path resolves these for every object, so state them here too
  // rather than let an object's columns depend on which path it took
  if (!o.cols.color) key('color', o.born, null, undefined)
  key('event', o.born, 'create', undefined)
  return o
}

// Value of a track at a whole frame: the last entry starting at or before it.
const runAt = (t: Track, frame: number): { i: number; v: unknown } | null => {
  let lo = 0, hi = t.at.length - 1, found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (t.at[mid] <= frame) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  return found < 0 ? null : { i: found, v: t.val[found] }
}

// Every element becomes part of its mesh's buffers instead of an object of its
// own. The mesh keeps their lineage, so the table still lights up the rows the
// paper came from, and it is one object per frame instead of thousands.
function foldElementsIntoMeshes(objects: ObjectTracks[]): ObjectTracks[] {
  const byMesh = new Map<unknown, ObjectTracks[]>()
  const kept: ObjectTracks[] = []
  for (const o of objects) {
    const of = o.cols.of?.val[0]
    if (of == null || !elementOf(rowOfCreate(o))) { kept.push(o); continue }
    const at = byMesh.get(of)
    if (at) at.push(o)
    else byMesh.set(of, [o])
  }
  for (const mesh of kept) {
    const elements = byMesh.get(mesh.id)
    if (!elements) continue
    const slab = buildSlab(elements)
    if (!slab) continue
    mesh.cols.slab = { at: [mesh.born], val: [slab], keyed: true }
    mesh.lineage = unionLineage(
      [mesh, ...elements].map((o) => withLineage({} as Row, o.lineage)))
    byMesh.delete(mesh.id)
  }
  // elements whose mesh never appeared keep their rows, so a table that names
  // no mesh still shows something rather than silently emptying
  for (const orphans of byMesh.values()) kept.push(...orphans)
  return kept
}

// The columns an object states once, as a row — enough to ask what it is.
const rowOfCreate = (o: ObjectTracks): Row => {
  const r: Row = {}
  for (const k in o.cols) r[k] = o.cols[k].val[0]
  return r
}

export function buildFrameStore(
  eventRows: Row[] | null | undefined, maxBeats?: number,
): FrameStore {
  const events = (eventRows ?? []).map(toFrameEvent)
  // Bake out to the largest event frame, or at least the last frame a
  // `maxBeats` loop samples (its span EXCLUSIVE — frame span belongs to the
  // next pass, and pad frames reaching it would spuriously add one). How the
  // extent chops into passes is playback's concern.
  // A warped object's own frames are SOURCE frames — it is shown over its
  // warp's out-range instead, which is what the extent has to cover. Take the
  // source extent of one and playback wraps into passes that replay the whole
  // window again, once per pass of source it never actually reaches.
  const extentOf = (e: Row): number => {
    const warp = getWarp(e)
    if (!warp?.length) return (e.frame as number) ?? 0
    return beatToFrame(warp.reduce((m, seg) => Math.max(m, seg.p1), 0)) - 1
  }
  const maxFrame = Math.max(
    maxBeats != null ? Math.max(0, beatsToFrames(maxBeats) - 1) : 0,
    events.reduce((m, e) => Math.max(m, extentOf(e)), 0),
  )
  const objects: ObjectTracks[] = []
  for (const evs of buildTimelines(events).values()) {
    const keyed = keyframeObject(evs, maxFrame)
    if (keyed) { objects.push(keyed); continue }
    const warp = evs.map(getWarp).find(Boolean)
    const o: ObjectTracks = {
      id: evs[0].id, born: -1, dies: maxFrame + 1, cols: {}, lineage: [],
      ...(warp ? { warp } : {}),
    }
    const seenSource = new Set<Row>()
    let parts: Record<PartKind, (number | null)[]> = { vert: [], face: [], edge: [] }
    for (let frame = 0; frame <= maxFrame; frame++) {
      const s = sampleObject(evs, frame, maxFrame)
      if (!s) {
        if (o.born >= 0 && o.dies > maxFrame) o.dies = frame
        continue
      }
      if (o.born < 0) o.born = frame
      for (const r of s.sources) seenSource.add(r)
      // `beat` is the sparse keyframe field and `loop` the retired pass column;
      // the store is keyed by frame.
      const { beat: _beat, loop: _loop, ...fields } = s.fields
      if (s.parts) {
        parts = {
          vert: sharedIfSame(parts.vert, s.parts.vert),
          face: sharedIfSame(parts.face, s.parts.face),
          edge: sharedIfSame(parts.edge, s.parts.edge),
        }
        if (parts.vert.length) fields.vertColor = parts.vert
        if (parts.face.length) fields.faceColor = parts.face
        if (parts.edge.length) fields.edgeColor = parts.edge
      }
      for (const k in fields) pushRun(o.cols, k, frame, fields[k])
    }
    o.lineage = unionLineage([...seenSource])
    if (o.born >= 0) objects.push(o)
  }
  return { objects: foldElementsIntoMeshes(objects), maxFrame }
}

// The mesh's elements as rows again, at one frame. Playback never asks — it
// hands the buffers to the renderer whole — but a reader that wants the paper
// one vertex at a time (the inspector, `.rasterize()`) gets the same rows the
// table has, with this frame's geometry filled in.
export function elementRowsAt(slab: MeshSlab, of: unknown, frameFloat: number): Row[] {
  const { axis, vpos, foff, cornerVert, cornerFace, endVert, endFace, nv, nf } = slab
  let lo = 0, hi = axis.length - 1, i = 0
  while (lo <= hi) {
    const m = (lo + hi) >> 1
    if (axis[m] <= frameFloat) { i = m; lo = m + 1 } else hi = m - 1
  }
  const j = Math.min(i + 1, axis.length - 1)
  const span = axis[j] - axis[i]
  const u = span > 0 ? Math.min(1, Math.max(0, (frameFloat - axis[i]) / span)) : 0
  const at = (a: Float32Array, n: number, e: number, c: number): number => {
    const p = (i * n + e) * 3 + c, q = (j * n + e) * 3 + c
    return a[p] + (a[q] - a[p]) * u
  }
  const out: Row[] = []
  for (let v = 0; v < nv; ++v) {
    out.push({ id: `${String(of)}:v${v}`, of, frame: frameFloat, vert: v,
      px: at(vpos, nv, v, 0), py: at(vpos, nv, v, 1), pz: at(vpos, nv, v, 2) })
  }
  for (let f = 0; f < nf; ++f) {
    out.push({ id: `${String(of)}:f${f}`, of, frame: frameFloat, face: f,
      ox: at(foff, nf, f, 0), oy: at(foff, nf, f, 1), oz: at(foff, nf, f, 2) })
  }
  for (let t = 0; t < cornerFace.length; ++t) {
    out.push({ id: `${String(of)}:t${t}`, of, frame: frameFloat, tri: t, face: cornerFace[t],
      v0: cornerVert[t * 3], v1: cornerVert[t * 3 + 1], v2: cornerVert[t * 3 + 2] })
  }
  for (let e = 0; e < endFace.length; ++e) {
    out.push({ id: `${String(of)}:e${e}`, of, frame: frameFloat, edge: e,
      a: endVert[e * 2], b: endVert[e * 2 + 1] })
  }
  return out
}

// Rebuild a dense row per object per frame — what `.rasterize()` hands a user
// program, and the shape every consumer outside playback still expects. A mesh
// expands back into its elements here: the buffers are a transport, not a
// different kind of scene.
export function storeRows(store: FrameStore): Row[] {
  const out: Row[] = []
  for (let frame = 0; frame <= store.maxFrame; frame++) {
    for (const o of store.objects) {
      const row = rowAt(o, frame)
      if (!row) continue
      const { slab, ...rest } = row
      out.push(slab ? rest : row)
      // `row.frame` is the SOURCE frame — the same one rowAt read the object's
      // own tracks at — which is not `frame` once the object is retimed.
      if (slab) out.push(...elementRowsAt(slab as MeshSlab, row.id, row.frame as number))
    }
  }
  return out
}

function rowAt(o: ObjectTracks, playFrame: number): Row | null {
  // A warped object is asked what it looked like at the SOURCE time this
  // playback time shows — its lifetime, its keyframes and its slab are all in
  // source frames, so the map applies once, here, and nothing downstream has
  // to know. Where a remap has to pick a value wherever two segments meet, a
  // warp just evaluates: sourceAt returns one number.
  if (o.diesPlay != null && playFrame >= o.diesPlay) return null
  const frameFloat = o.warp
    ? beatToFrame(sourceAt(o.warp, frameToBeat(playFrame)))
    : playFrame
  const f0 = Math.floor(frameFloat)
  if (f0 < o.born || f0 >= o.dies) return null
  const frac = frameFloat - f0
  const row: Row = {}
  for (const k in o.cols) {
    const t = o.cols[k]
    const hit = runAt(t, f0)
    if (!hit) continue
    let v = hit.v
    if (t.keyed) {
      // keyframes: interpolate across the whole segment to the next one
      const j = hit.i + 1
      const nx = t.val[j]
      if (typeof v === 'number' && typeof nx === 'number' && !NO_TRACK.has(k)) {
        const span = t.at[j] - t.at[hit.i]
        const ease = t.ease?.[j]
        if (span > 0 && ease !== 'step') {
          const raw = Math.min(1, Math.max(0, (frameFloat - t.at[hit.i]) / span))
          const fn = easeFnOf(ease)
          v = v + (nx - v) * (fn ? fn(raw) : raw)
        }
      }
    } else if (frac > 0 && INTERP_FIELDS.has(k) && typeof v === 'number') {
      // densified: the next whole frame's value, if a run starts on it
      const nx = t.at[hit.i + 1] === f0 + 1 ? t.val[hit.i + 1] : v
      if (typeof nx === 'number' && nx !== v) v = v + (nx - v) * frac
    }
    row[k] = v
  }
  row.frame = frameFloat
  row.id = o.id
  return withLineage(row, o.lineage)
}

export function rasterizeRows(eventRows: Row[] | null | undefined, maxBeats?: number): Row[] {
  return storeRows(buildFrameStore(eventRows, maxBeats))
}

export type FrameIndex = FrameStore

/**
 * Index a scene table for the playhead. Takes either the SPARSE event rows
 * (schemas.scene) or a table already densified by `.rasterize()` — a program
 * may name its own "scene" view — and stores both as runs.
 */
export function buildFrameIndex(rows: Row[] | null | undefined, maxBeats?: number): FrameStore {
  const dense = (rows ?? []).some((r) => r.frame != null && r.beat == null)
  return dense ? storeFromRows(rows ?? []) : buildFrameStore(rows, maxBeats)
}

// Densified rows are already one sample per frame; run-length them directly
// rather than re-deriving anything.
function storeFromRows(rows: Row[]): FrameStore {
  const byId = new Map<unknown, ObjectTracks>()
  const last = new Map<ObjectTracks, number>()
  let maxFrame = 0
  for (const r of rows) {
    const frame = (r.frame as number | undefined) ?? 0
    if (frame > maxFrame) maxFrame = frame
    let o = byId.get(r.id)
    if (!o) {
      o = { id: r.id, born: frame, dies: Number.MAX_SAFE_INTEGER, cols: {}, lineage: [] }
      byId.set(r.id, o)
    }
    last.set(o, frame)
    for (const k in r) {
      if (k === 'frame' || k === 'id') continue
      pushRun(o.cols, k, frame, r[k])
    }
  }
  // a densified object that stops appearing has been destroyed there
  for (const [o, lastFrame] of last) o.dies = lastFrame < maxFrame ? lastFrame + 1 : maxFrame + 1
  return { objects: [...byId.values()], maxFrame }
}

/** State at a (possibly fractional) frame: one row per object alive there. */
export function sampleFrame(store: FrameStore, frameFloat: number): Row[] {
  if (frameFloat < 0 || Math.floor(frameFloat) > store.maxFrame) return []
  const out: Row[] = []
  for (const o of store.objects) {
    const row = rowAt(o, frameFloat)
    if (row) out.push(row)
  }
  return out
}
