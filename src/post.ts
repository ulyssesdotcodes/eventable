// livecodata post — table-driven TSL post-processing. The "post" view is
// hydra's sibling: a table of events placed on the loop by a 1-indexed `beat`
// column, folded into ONE running effect chain applied to the rendered scene,
// then evaluated to an immutable op list (see post-lang.ts). The scene is the
// implicit source and there is one output, so the code reads like hydra
// (`edges(0.2).bloom(1.2)`) with no routing. This module is pure — no GPU, no
// `three`; the node graph is built and rendered by post-scene.ts.

import { beatToFrame, beatsToFrames, frameToBeat } from './constants.js'
import {
  EASINGS, isBinding, isStreamingNode, evalExpr, substituteExpr,
  type Easings, type ExprNode,
} from './dsl.js'
import { contentSeqLen, transitionSpan, transitionAt, transitionWindowsIn, type TransitionWindow } from './hydra.js'
import { evalPostCode, chainSignature, type OpChain } from './post-lang.js'
import type { Row } from './lineage.js'

// One folded frame: the precompiled-state id (the chain's structural
// signature), the op list, and the latest value of each variable.
export interface PostFrame {
  stateId: string
  chain: OpChain
  vars: Record<string, unknown>
}

const POST_EVENTS = new Set(['setCode', 'add', 'remove', 'layer', 'transition', 'setVariable', 'pulse'])

export function isPostRow(row: Row | null | undefined): boolean {
  return row != null && typeof row.event === 'string' && POST_EVENTS.has(row.event)
}

export function postRows(rows: Row[] | null | undefined): Row[] {
  return (rows ?? []).filter(isPostRow)
}

// Place each row on the frame grid from its 1-indexed `beat` (frame stored on
// `index`) and sort by frame — like buildHydraIndex, so a beat past the loop's
// end lands the row in a later pass (the visualizer wraps the playhead).
export function buildPostIndex(rows: Row[] | null | undefined): Row[] {
  return postRows(rows)
    .map((row) => ({ ...row, index: beatToFrame((row.beat as number | undefined) ?? 1) }))
    .sort((a, b) => (a.index as number) - (b.index as number))
}

// The frames whose folded state must be precompiled: every event frame, plus
// each transition's window-END frame — usually the next setCode's frame (so
// already enumerated), except the same-beat/full-pass case, which lands a full
// pass (loopFrames) later. setProgram enumerates these; a warm-compile audit
// checks no other frame introduces a new state.
export function postStateFrames(index: Row[], loopFrames = 0): number[] {
  const seqLen = contentSeqLen(index, loopFrames)
  const frames = new Set<number>()
  for (let p = 0; p < index.length; p++) {
    const f = index[p].index as number
    frames.add(f)
    if (index[p].event === 'transition') {
      const span = transitionSpan(index, p, seqLen, loopFrames)
      if (span) frames.add(seqLen > 0 ? ((span.end % seqLen) + seqLen) % seqLen : span.end)
    }
  }
  return [...frames].sort((a, b) => a - b)
}

// A pulse's effective duration in beats: a positive `dur`, else the 1-beat
// default so a bare pulse still has extent. The single source of truth shared
// by pulseAt (playback) and postSpanWindows (the strip bar) so the two never
// drift.
const pulseDurBeats = (r: Row): number => (typeof r.dur === 'number' && r.dur > 0 ? r.dur : 1)

// The post table's strip bars — until-next windows for transitions (post has
// one chain, no per-output routing) plus each pulse's [beat, beat + dur) extent
// (mirroring pulseAt). setVariable rows carry no bar (a glide is an arrow, not a
// duration block — see postGlidePairs); a stray `dur` on any other event is
// ignored.
export function postSpanWindows(rows: Row[] | null | undefined, loopBeats = 0): TransitionWindow[] {
  const index = buildPostIndex((rows ?? []).map((row, i) => ({ ...row, __row: i })))
  const loopFrames = beatsToFrames(loopBeats)
  const windows = transitionWindowsIn([index], contentSeqLen(index, loopFrames), loopFrames)
  for (const r of index) {
    if (r.event !== 'pulse') continue
    const start = frameToBeat(r.index as number)
    windows.push({ row: (r as { __row: number }).__row, start, end: start + pulseDurBeats(r) })
  }
  return windows
}

export interface GlidePair {
  // The arriving (eased) setVariable row, and the previous same-name row it
  // glides from — the strip draws an on-arrival arrow (arrowhead at `row`) and
  // hover-links the pair.
  row: number
  from: number
}

// Which previous same-name setVariable row each eased keyframe glides from —
// the pairing the strip renders as a connector arrow. Reuses varTracks (the
// grouping foldVars folds over) and trackSegment's curr→next adjacency: a NAMED
// ease glides from the previous keyframe in the name's frame-ordered track;
// blank/step rows glide from nothing. The first row's circular (loop-wrap) glide
// is omitted here — an arrow running the loop backward isn't drawn.
export function postGlidePairs(rows: Row[] | null | undefined): GlidePair[] {
  const index = buildPostIndex((rows ?? []).map((row, i) => ({ ...row, __row: i })))
  const rowOf = (r: Row): number => (r as { __row: number }).__row
  const pairs: GlidePair[] = []
  for (const track of varTracks(index).values()) {
    for (let k = 1; k < track.length; k++) {
      if (isNamedEase(track[k].ease)) pairs.push({ row: rowOf(track[k]), from: rowOf(track[k - 1]) })
    }
  }
  return pairs
}

// Split a chain string into its top-level op-call segments (balanced-paren
// aware, so dots inside args — decimals, nested calls — never split). The
// leading identifier of each segment names the op.
function splitOps(chain: string): string[] {
  const segs: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === '.' && depth === 0) { segs.push(chain.slice(start, i)); start = i + 1 }
  }
  segs.push(chain.slice(start))
  return segs.filter((s) => s.trim() !== '')
}

// Drop every op named `name` from a chain, then rejoin — the beat-time bypass
// behind the `remove` event. Dropping the first op is fine: the next op becomes
// top-level (implicit scene), which is still a valid chain.
function removeOp(chain: string, name: string): string {
  const nameOf = (s: string): string => s.match(/^\s*([\w$]+)/)?.[1] ?? ''
  return splitOps(chain).filter((s) => nameOf(s) !== name).join('.')
}

// Blend modes the `layer` event can pick, and whether each takes an amount.
// Only `blend` carries an amount in the op registry; the rest composite raw.
const LAYER_AMOUNT = new Set(['blend'])
const LAYER_MODES = new Set(['blend', 'add', 'mult', 'diff', 'mask'])

// A layer amount as a code fragment: a number is a literal; any other non-empty
// string is a per-frame props expression (hydra-identical).
function amountExpr(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  const s = typeof value === 'string' ? value.trim() : ''
  if (s === '') return '0.5'
  const n = Number(s)
  if (!Number.isNaN(n)) return String(n)
  return s.includes('=>') ? `(${s})` : `(p) => (${s})`
}

// Apply one chain-shape event — everything that mutates the chain string.
// setVariable/pulse/transition leave it unchanged (handled elsewhere).
function applyPostShape(code: string, row: Row): string {
  const c = typeof row.code === 'string' ? row.code.trim() : ''
  switch (row.event) {
    case 'setCode':
      return c
    case 'add':
      return c === '' ? code : code === '' ? c.replace(/^\./, '') : `${code}.${c.replace(/^\./, '')}`
    case 'remove':
      return code !== '' && typeof row.name === 'string' && row.name !== '' ? removeOp(code, row.name) : code
    case 'layer':
      if (c !== '') {
        const mode = typeof row.mode === 'string' && LAYER_MODES.has(row.mode) ? row.mode : 'blend'
        const amt = LAYER_AMOUNT.has(mode) ? `, ${amountExpr(row.value)}` : ''
        return `${code === '' ? 'scene()' : code}.${mode}(${c}${amt})`
      }
      return code
    default:
      return code
  }
}

// Fold the event stream into the running chain string at `frame`. Returns null
// (post stage inactive → scene shows through) until the chain is non-empty.
// setVariable/pulse are handled separately (foldVars); this is chain shape only.
// A transition wipes from the chain at its beat to the chain at the next setCode
// ahead (its window end), revealing that destination mid-wipe via look-ahead —
// chain-shape events fold up to the furthest active window end.
function foldChain(index: Row[], frame: number, seqLen: number, loopFrames: number): string | null {
  const active: { before: string; mask: string; start: number; len: number; end: number; ease: unknown }[] = []
  let running = ''
  let codeAtF = ''
  for (let p = 0; p < index.length; p++) {
    const row = index[p]
    if (row.event === 'transition') {
      const span = transitionSpan(index, p, seqLen, loopFrames)
      if (span != null && transitionAt(frame, row.index as number, span.len, seqLen) != null) {
        active.push({
          before: running === '' ? 'scene()' : running,
          mask: typeof row.code === 'string' ? row.code.trim() : '',
          start: row.index as number, len: span.len, end: span.end, ease: row.ease,
        })
      }
    } else {
      running = applyPostShape(running, row)
    }
    if ((row.index as number) <= frame) codeAtF = running
  }
  if (codeAtF === '' && active.length === 0) return null
  // The "after": chain-shape folded up to the furthest active window end.
  const horizon = active.length ? Math.max(...active.map((a) => a.end)) : frame
  let after = ''
  for (const row of index) {
    if ((row.index as number) > horizon) break
    if (row.event !== 'transition') after = applyPostShape(after, row)
  }
  // Compose wipes innermost-first so nested transitions layer in beat order. The
  // mask rides in as a thunk so its progress() binds to THIS transition's window;
  // a blank mask is static black (fill(0)) — before holds until the window ends.
  let result = after === '' ? 'scene()' : after
  for (let i = active.length - 1; i >= 0; i--) {
    const tr = active[i]
    const maskBody = tr.mask !== '' ? tr.mask : 'fill(0)'
    result = `transition((${tr.before}), (${result}), () => (${maskBody}), ${tr.start}, ${tr.len}, ${seqLen}, ${JSON.stringify(tr.ease ?? null)})`
  }
  return result
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const easingOf = (name: unknown, fallback: keyof Easings): ((t: number) => number) =>
  EASINGS[(typeof name === 'string' && name in EASINGS ? name : fallback) as keyof Easings]

// A named ease (linear/easeIn/easeOut/easeInOut) glides the segment into a
// keyframe; anything else — blank, absent, or the explicit 'step' — holds and
// jumps on the beat.
const isNamedEase = (ease: unknown): boolean => typeof ease === 'string' && ease in EASINGS

// The active segment of a setVariable keyframe track (rows of one name in frame
// order) at `frame`: the holding keyframe `curr` whose value reigns up to the
// arriving keyframe `next` (null once past the last row when not looping), and
// `u` the 0→1 fraction across [curr, next]. Wrapped (seqLen>0) the track is
// circular — the last row's segment crosses the sequence boundary into the
// first, using the same wrapped-distance math transitions use.
function trackSegment(
  track: Row[], frame: number, seqLen: number,
): { curr: Row | null; next: Row | null; u: number } {
  const n = track.length
  const F = (r: Row): number => r.index as number
  if (seqLen > 0) {
    const wf = ((frame % seqLen) + seqLen) % seqLen
    let ci = -1
    for (let i = 0; i < n; i++) if (F(track[i]) <= wf) ci = i
    if (ci < 0) ci = n - 1
    const curr = track[ci]
    const next = track[(ci + 1) % n]
    const dist = ((F(next) - F(curr)) % seqLen + seqLen) % seqLen || seqLen
    const pos = ((wf - F(curr)) % seqLen + seqLen) % seqLen
    return { curr, next, u: clamp01(pos / dist) }
  }
  let ci = -1
  for (let i = 0; i < n; i++) if (F(track[i]) <= frame) ci = i
  if (ci < 0) return { curr: null, next: null, u: 1 }
  const curr = track[ci]
  if (ci === n - 1) return { curr, next: null, u: 1 }
  const next = track[ci + 1]
  const dist = F(next) - F(curr)
  return { curr, next, u: dist > 0 ? clamp01((frame - F(curr)) / dist) : 1 }
}

// The base value of one variable at `frame`, from its setVariable keyframe track.
// The arriving keyframe's `ease` shapes the segment into it: a named ease glides
// from the holding keyframe's value, arriving on the beat; step (blank/'step')
// holds and jumps. Numeric-only tracks come here (foldVars' fast path); tracks
// carrying `$expr` bindings go through baseComposite.
function baseValue(track: Row[], frame: number, seqLen: number): unknown {
  const { curr, next, u } = trackSegment(track, frame, seqLen)
  if (!curr) return undefined
  if (next && next !== curr && isNamedEase(next.ease)
    && typeof curr.value === 'number' && typeof next.value === 'number') {
    return curr.value + (next.value - curr.value) * easingOf(next.ease, 'linear')(u)
  }
  return curr.value
}

// A pulse's window at `frame`: `u` the 0→1 fraction over its `dur` (default 1
// beat, so a bare pulse still fires), and `env` the added-value envelope — a 1→0
// decay shaped by `ease` (default easeOut), or a full-value square GATE while
// ease is 'step'. env is 0 outside the window.
function pulseAt(r: Row, frame: number): { u: number; env: number } {
  const start = r.index as number
  const durFrames = Math.max(1, beatsToFrames(pulseDurBeats(r)))
  if (frame < start || frame >= start + durFrames) return { u: 0, env: 0 }
  const u = clamp01((frame - start) / durFrames)
  return { u, env: r.ease === 'step' ? 1 : 1 - easingOf(r.ease, 'easeOut')(u) }
}

// The summed contribution of one variable's active pulses at `frame`.
function pulseSum(pulses: Row[], frame: number): number {
  let sum = 0
  for (const r of pulses) {
    const { env } = pulseAt(r, frame)
    if (typeof r.value === 'number') sum += r.value * env
  }
  return sum
}

// A setVariable/pulse row's value with the row's own context substituted in:
// field() reads the row's columns (resolveBindings later sees the vars map as
// its row, which would read sibling variables instead), progress() the reign the
// caller passes as `u`. A still-streaming result stays a binding; otherwise the
// expression collapses to its value right here.
function resolvedValue(r: Row, u: number): unknown {
  const v = r.value
  if (!isBinding(v)) return v
  const node = substituteExpr(v.$expr, { progress: u, fields: r })
  return isStreamingNode(node) ? { $expr: node } : evalExpr(node, r, 0)
}

const litNode = (v: number): ExprNode => ({ k: 'lit', v })
const addNode = (a: ExprNode, b: ExprNode): ExprNode => ({ k: 'bin', op: 'add', a, b })
const nodeOf = (v: unknown): ExprNode | null =>
  typeof v === 'number' && Number.isFinite(v) ? litNode(v) : isBinding(v) ? v.$expr : null

// baseValue's sibling for tracks whose rows carry expressions: the holding
// keyframe's value resolves over its reign (progress() = the segment fraction);
// a named-ease glide to the arriving keyframe emits a per-frame lerp composite —
// u and the ease are known here, the endpoints resolve at the visualizer's
// resolveBindings — instead of degrading to a step.
function baseComposite(track: Row[], frame: number, seqLen: number): unknown {
  const { curr, next, u } = trackSegment(track, frame, seqLen)
  if (!curr) return undefined
  const currVal = resolvedValue(curr, u)
  if (!next || next === curr || !isNamedEase(next.ease)) return currVal
  const nextVal = resolvedValue(next, 0)
  const eased = easingOf(next.ease, 'linear')(u)
  if (typeof currVal === 'number' && typeof nextVal === 'number') {
    return currVal + (nextVal - currVal) * eased
  }
  const a = nodeOf(currVal)
  const b = nodeOf(nextVal)
  if (a && b) return { $expr: { k: 'call', fn: 'lerp', args: [a, b, litNode(eased)] } satisfies ExprNode }
  return currVal
}

// pulseSum's sibling for expression rows: each active expression pulse
// contributes a mul(pulseNode, lit(env)) term that stacks over any base.
function pulseParts(pulses: Row[], frame: number): { num: number; nodes: ExprNode[] } {
  let num = 0
  const nodes: ExprNode[] = []
  for (const r of pulses) {
    const { u, env } = pulseAt(r, frame)
    if (env === 0) continue
    const v = resolvedValue(r, u)
    if (typeof v === 'number') num += v * env
    else if (isBinding(v)) nodes.push({ k: 'bin', op: 'mul', a: v.$expr, b: litNode(env) })
  }
  return { num, nodes }
}

// Each setVariable name's keyframe track — its rows in buildPostIndex (frame)
// order. The one grouping foldVars folds base values over and postGlidePairs
// pairs glide arrows over, so the strip's pairing can't drift from playback's.
// Exported for the timeline pane's variables section (OQ5: post-only — hydra/
// bauble/particles fold setVariable last-write-wins, with no track to plot).
export function varTracks(index: Row[]): Map<string, Row[]> {
  const tracks = new Map<string, Row[]>()
  for (const row of index) {
    if (row.event === 'setVariable' && typeof row.name === 'string') {
      (tracks.get(row.name) ?? tracks.set(row.name, []).get(row.name)!).push(row)
    }
  }
  return tracks
}

// Fold every setVariable/pulse row into the variable map at `frame`: each name's
// keyframe track (base value) plus its active pulses. A setVariable track is the
// name's whole row set — later keyframes shape the segment the playhead is
// inside — while pulses stay windowed at/before frame. seqLen (the content
// cycle, >0 while looping) makes tracks circular so a named-ease first row
// glides across the loop boundary. Total when called ctx-free (cook/replay run
// it too): composites are constructed, never evaluated, here.
export function foldVars(index: Row[], frame: number, seqLen = 0): Record<string, unknown> {
  const sets = varTracks(index)
  const pulses = new Map<string, Row[]>()
  for (const row of index) {
    if (row.event === 'pulse' && typeof row.name === 'string' && (row.index as number) <= frame) {
      (pulses.get(row.name) ?? pulses.set(row.name, []).get(row.name)!).push(row)
    }
  }
  const vars: Record<string, unknown> = {}
  for (const name of new Set([...sets.keys(), ...pulses.keys()])) {
    const setRows = sets.get(name)
    const pulseRows = pulses.get(name)
    // Numeric-only names take the arithmetic path untouched; only a row carrying
    // a binding pays for the composite machinery.
    const hasExpr = (setRows?.some((r) => isBinding(r.value)) ?? false)
      || (pulseRows?.some((r) => isBinding(r.value)) ?? false)
    if (!hasExpr) {
      const base = setRows ? baseValue(setRows, frame, seqLen) : undefined
      const pulse = pulseRows ? pulseSum(pulseRows, frame) : 0
      if (typeof base === 'number' && Number.isFinite(base)) vars[name] = base + pulse
      else if (base !== undefined) vars[name] = base
      else if (pulseRows) vars[name] = pulse
      continue
    }
    const base = setRows ? baseComposite(setRows, frame, seqLen) : undefined
    const { num, nodes } = pulseRows ? pulseParts(pulseRows, frame) : { num: 0, nodes: [] }
    if (typeof base === 'number' && Number.isFinite(base)) {
      vars[name] = nodes.length ? { $expr: nodes.reduce(addNode, litNode(base + num)) } : base + num
    } else if (isBinding(base)) {
      let n = nodes.reduce(addNode, base.$expr)
      if (num !== 0) n = addNode(n, litNode(num))
      vars[name] = { $expr: n }
    } else if (base === undefined && pulseRows) {
      if (!nodes.length) {
        vars[name] = num
      } else {
        const head = num !== 0 ? addNode(litNode(num), nodes[0]) : nodes[0]
        vars[name] = { $expr: nodes.slice(1).reduce(addNode, head) }
      }
    } else if (base !== undefined) {
      // A non-numeric, non-expression base steps as-is; pulses can't ride it.
      vars[name] = base
    }
  }
  return vars
}

// The active program at (absolute) frame `f`: every event at/before it folds
// into one running chain, evaluated to an op list. The state id is its
// structural signature, so frames sharing structure share a precompiled graph.
// Returns null until the chain is non-empty — playback then leaves post inactive.
export function postFrameAt(index: Row[], f: number, loopFrames = 0): PostFrame | null {
  const frame = Math.floor(f)
  if (frame < 0) return null
  const seqLen = contentSeqLen(index, loopFrames)
  const codeStr = foldChain(index, frame, seqLen, loopFrames)
  if (codeStr == null) return null
  // Let a broken chain (syntax error, unknown op, a trailing line comment the
  // `return (...)` wrap can't close) throw. The cook compiles every state up
  // front, so the error surfaces to the user there rather than being swallowed.
  const chain = evalPostCode(codeStr)
  return { stateId: chainSignature(chain), chain, vars: foldVars(index, frame, seqLen) }
}

// The compiled chain source shown for one table row: the full fold sampled at
// that row's own frame — exactly what the runtime shows there (a transition
// row's popover includes the next setCode via look-ahead; the destination
// setCode row, a window end, shows the plain after chain). Powers the table
// panel's per-row popover; loopFrames defaults to unwrapped.
export function postCodeUpToRow(rows: Row[] | null | undefined, rowIndex: number, loopFrames = 0): string | null {
  const all = rows ?? []
  if (!isPostRow(all[rowIndex])) return null
  const index = buildPostIndex(all.map((row, i) => ({ ...row, __row: i })))
  const pos = index.findIndex((r) => (r as { __row?: number }).__row === rowIndex)
  if (pos < 0) return null
  return foldChain(index, index[pos].index as number, contentSeqLen(index, loopFrames), loopFrames)
}
