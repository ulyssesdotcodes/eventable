// eventable rasterize — Houdini-style bake: expand sparse object events
// (create/update/color/destroy, keyed by `id`) into a dense frame-indexed
// cache, one row per alive object per frame, on the FRAMES_PER_BEAT grid.
// Timing fields (`beat`, `dur`) are in beats, 1-indexed (beat 1 = frame 0).
// The beat axis is absolute: events past the loop's end just bake further
// along the grid, and playback wraps the playhead into it in loop-length
// passes (see the scene visualizer in visualizer.ts).

import { withLineage, unionLineage, type Row } from './lineage.js'
import { mixColor } from './color.js'
import { beatToFrame, beatsToFrames } from './constants.js'
// dsl.ts imports rasterizeRows back; the cycle is benign — each side only
// calls the other at runtime, never during module evaluation.
import { EASINGS, isBinding, isStreamingNode, evalExpr, substituteExpr } from './dsl.js'

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
  parts: { face: (number | null)[]; edge: (number | null)[] } | null
}

// Fields rasterize interprets itself. Anything else — a custom field, or a
// { $expr } streaming binding — is "extra": carried through to each baked row
// untouched, to be read (and bindings resolved) at playback. `loop` is the
// retired pass column: still reserved so old tables carrying one stay inert.
const RESERVED = new Set([
  'id', 'event', 'beat', 'loop', 'dur', 'ease', 'to', 'shape', 'color',
  'px', 'py', 'pz', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz', 'frame',
  // sub-object handles: interpreted into faceColor/edgeColor, never carried
  'face', 'edge',
])

// Non-reserved fields visible at frame `i`: events at-or-before, last write wins.
function gatherExtra(events: Row[], i: number): Row {
  const extra: Row = {}
  for (const e of events) {
    if ((e.frame as number) > i) continue
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
const partKey = (e: Row): 'face' | 'edge' | null =>
  typeof e.face === 'number' ? 'face' : typeof e.edge === 'number' ? 'edge' : null

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
): { face: (number | null)[]; edge: (number | null)[] } {
  const out = { face: [] as (number | null)[], edge: [] as (number | null)[] }
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
// A column of one object, run-length encoded: `at[i]` is the frame its value
// starts on, `val[i]` the value it holds until the next run. Most columns of
// most objects never change at all — a static prop is one run per column, and
// even the crane holds 15 of its 35 columns constant for the whole folding —
// so the dense bake was storing the same value ~1,500 times over.
interface Track {
  at: number[]
  val: unknown[]
}

interface ObjectTracks {
  id: unknown
  born: number
  dies: number            // exclusive: the frame it stops being drawn
  cols: Record<string, Track>
  sources: Row[]
}

export interface FrameStore {
  objects: ObjectTracks[]
  maxFrame: number
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

// Value of a track at a whole frame: the last run starting at or before it.
const runAt = (t: Track, frame: number): { i: number; v: unknown } | null => {
  let lo = 0, hi = t.at.length - 1, found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (t.at[mid] <= frame) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  return found < 0 ? null : { i: found, v: t.val[found] }
}

export function buildFrameStore(
  eventRows: Row[] | null | undefined, maxBeats?: number,
): FrameStore {
  const events = (eventRows ?? []).map(toFrameEvent)
  // Bake out to the largest event frame, or at least the last frame a
  // `maxBeats` loop samples (its span EXCLUSIVE — frame span belongs to the
  // next pass, and pad frames reaching it would spuriously add one). How the
  // extent chops into passes is playback's concern.
  const maxFrame = Math.max(
    maxBeats != null ? Math.max(0, beatsToFrames(maxBeats) - 1) : 0,
    events.reduce((m, e) => Math.max(m, (e.frame as number) ?? 0), 0),
  )
  const objects: ObjectTracks[] = []
  for (const evs of buildTimelines(events).values()) {
    const o: ObjectTracks = {
      id: evs[0].id, born: -1, dies: maxFrame + 1, cols: {}, sources: [],
    }
    const seenSource = new Set<Row>()
    let parts: { face: (number | null)[]; edge: (number | null)[] } = { face: [], edge: [] }
    for (let frame = 0; frame <= maxFrame; frame++) {
      const s = sampleObject(evs, frame, maxFrame)
      if (!s) {
        if (o.born >= 0 && o.dies > maxFrame) o.dies = frame
        continue
      }
      if (o.born < 0) o.born = frame
      for (const r of s.sources) if (!seenSource.has(r)) { seenSource.add(r); o.sources.push(r) }
      // `beat` is the sparse keyframe field and `loop` the retired pass column;
      // the store is keyed by frame.
      const { beat: _beat, loop: _loop, ...fields } = s.fields
      if (s.parts) {
        parts = {
          face: sharedIfSame(parts.face, s.parts.face),
          edge: sharedIfSame(parts.edge, s.parts.edge),
        }
        if (parts.face.length) fields.faceColor = parts.face
        if (parts.edge.length) fields.edgeColor = parts.edge
      }
      for (const k in fields) pushRun(o.cols, k, frame, fields[k])
    }
    if (o.born >= 0) objects.push(o)
  }
  return { objects, maxFrame }
}

// Rebuild a dense row per object per frame — what `.rasterize()` hands a user
// program, and the shape every consumer outside playback still expects.
export function storeRows(store: FrameStore): Row[] {
  const out: Row[] = []
  for (let frame = 0; frame <= store.maxFrame; frame++) {
    for (const o of store.objects) {
      const row = rowAt(o, frame)
      if (row) out.push(row)
    }
  }
  return out
}

function rowAt(o: ObjectTracks, frameFloat: number): Row | null {
  const f0 = Math.floor(frameFloat)
  if (f0 < o.born || f0 >= o.dies) return null
  const frac = frameFloat - f0
  const row: Row = {}
  for (const k in o.cols) {
    const t = o.cols[k]
    const hit = runAt(t, f0)
    if (!hit) continue
    let v = hit.v
    if (frac > 0 && INTERP_FIELDS.has(k) && typeof v === 'number') {
      // the next whole frame's value, which is this run's unless one starts on it
      const nx = t.at[hit.i + 1] === f0 + 1 ? t.val[hit.i + 1] : v
      if (typeof nx === 'number' && nx !== v) v = v + (nx - v) * frac
    }
    row[k] = v
  }
  row.frame = frameFloat
  row.id = o.id
  return withLineage(row, unionLineage(o.sources))
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
      o = { id: r.id, born: frame, dies: Number.MAX_SAFE_INTEGER, cols: {}, sources: [] }
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
