// eventable hydra — table-driven video synth (hydra-ts). The "hydra" view is a
// table of events placed on the loop by a 1-indexed `beat` column; sampling a
// frame folds every event at/before it, per `out` output, into one running
// sketch string plus the latest value of each setVariable. This module is pure;
// GPU rendering lives in hydra-scene.ts.

import { beatToFrame, beatsToFrames, frameToBeat, framesToBeats, FPS } from './constants.js'
import { isBinding, isStreamingNode, evalExpr, substituteExpr } from './dsl.js'
import type { Row } from './lineage.js'

export interface HydraFrame {
  code: string
  vars: Record<string, unknown>
}

const HYDRA_EVENTS = new Set(['setCode', 'setVariable', 'setSource', 'replace', 'append', 'layer', 'transition'])

export function isHydraRow(row: Row | null | undefined): boolean {
  return row != null && typeof row.event === 'string' && HYDRA_EVENTS.has(row.event)
}

export function hydraRows(rows: Row[] | null | undefined): Row[] {
  return (rows ?? []).filter(isHydraRow)
}

// Place each row on the frame grid from its 1-indexed `beat` (frame stored on
// `index`, the field hydraFrameAt samples against) and sort by frame. The beat
// axis is absolute: a beat past the loop's end lands the row in a later pass
// (the visualizer wraps the playhead into this grid — see visualizer.ts).
export function buildHydraIndex(rows: Row[] | null | undefined): Row[] {
  return hydraRows(rows)
    .map((row) => ({
      ...row,
      index: beatToFrame((row.beat as number | undefined) ?? 1),
    }))
    .sort((a, b) => (a.index as number) - (b.index as number))
}

// Strip a trailing `.out(...)` off a sketch, leaving the bare chain the
// meta-programming events extend or compose. Exported for the sibling `post`
// fold (src/post.ts), which reuses the same chain surgery.
const OUT_TAIL = /\.out\s*\([^)]*\)\s*;?\s*$/
export function chainOf(code: string): string {
  return code.replace(OUT_TAIL, '')
}

// Split a sketch into its head generator call (balanced parens) and the rest
// of the chain. Best-effort: a head with no call, or unbalanced parens, yields
// the whole string as the head. Exported for reuse by src/post.ts's setSource.
export function splitHead(code: string): [string, string] {
  const s = code.trimStart()
  let i = 0
  while (i < s.length && /[\w$]/.test(s[i])) i++
  if (s[i] !== '(') return [s, '']
  for (let depth = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')' && --depth === 0) { i++; break }
  }
  return [s.slice(0, i), s.slice(i)]
}

// Blend operators a `layer` event can pick via `mode`, mapped to whether each
// takes an amount. The keys double as the table's enum options.
const BLEND_OPS: Record<string, boolean> = {
  blend: true, add: true, mult: true, diff: false, layer: false, mask: false,
}
export const HYDRA_BLEND_MODES: string[] = Object.keys(BLEND_OPS)

function hasAmount(value: unknown): boolean {
  return (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.trim() !== '')
}

// Render a `layer` amount: numbers become literals; any other string is an
// expression evaluated per frame with `props` in scope.
function amountExpr(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  const s = typeof value === 'string' ? value.trim() : ''
  if (s === '') return '0.5'
  const n = Number(s)
  if (!Number.isNaN(n)) return String(n)
  return s.includes('=>') ? `(${s})` : `(props) => (${s})`
}

// The hydra output a row drives; a blank or malformed `out` cell means o0.
const OUTPUT_RE = /^o\d+$/
function outputOf(row: Row): string {
  const o = typeof row.out === 'string' ? row.out.trim() : ''
  return OUTPUT_RE.test(o) ? o : 'o0'
}

// The content cycle length in frames: playback wraps the playhead into
// [0, seqLen), each pass re-sampling [0, loopFrames), so an event beyond the
// loop lands in a later pass (see visualizer.ts). A 0/absent loopFrames means
// no loop — callers then treat transition windows as unwrapped.
export function contentSeqLen(index: Row[], loopFrames: number): number {
  if (!loopFrames || loopFrames <= 0) return 0
  const maxIndex = index.reduce((m, r) => Math.max(m, r.index as number), 0)
  return (Math.floor(maxIndex / loopFrames) + 1) * loopFrames
}

// A transition's wipe window: its length in frames, the end frame E (the NEXT
// setCode's frame), and `endPos` — that setCode's index in `scope` (-1 for the
// no-forward-setCode fallback below). "Next" scans `scope` (the fold-ordered
// rows the wipe lives in — one hydra output, or the whole post/bauble table)
// forward from the transition at `pos`, wrapping the content cycle. With a loop
// (seqLen > 0) a same-frame destination yields a zero raw distance → one full
// pass (loopFrames). With no loop (seqLen 0) the scan stays unwrapped: the
// nearest setCode strictly ahead, or a one-beat fallback when none. Null when
// the scope holds no setCode at all — the wipe is inert.
export function transitionSpan(
  scope: Row[], pos: number, seqLen: number, loopFrames: number,
): { end: number; len: number; endPos: number } | null {
  const T = scope[pos].index as number
  if (seqLen > 0) {
    const n = scope.length
    for (let k = 1; k <= n; k++) {
      const endPos = (pos + k) % n
      if (scope[endPos].event === 'setCode') {
        const end = scope[endPos].index as number
        return { end, len: ((end - T) % seqLen + seqLen) % seqLen || loopFrames, endPos }
      }
    }
    return null
  }
  let end = Infinity
  let endPos = -1
  let any = false
  for (let i = 0; i < scope.length; i++) {
    if (scope[i].event !== 'setCode') continue
    any = true
    const s = scope[i].index as number
    if (s > T && s < end) { end = s; endPos = i }
  }
  if (!any) return null
  if (!Number.isFinite(end)) return { end: T + beatsToFrames(1), len: beatsToFrames(1), endPos: -1 }
  return { end, len: end - T, endPos }
}

// One transition row's window on the timeline strip, in beats: the fold's own
// until-next window (transitionSpan), so a strip span can never disagree with
// where playback wipes. `start` is the transition's beat, `end` its true
// extent (start + the window's beats — a wrapped window ends past the loop),
// and `endRow` the destination setCode's storage row (absent for the inert
// no-destination fallback). Non-transition events have no window — the strip
// draws them as points.
export interface TransitionWindow {
  row: number
  start: number
  end: number
  endRow?: number
}

// Walk each fold scope (hydra: one per `out`; post/bauble: the whole table)
// for its transitions' until-next windows, mapping frames back to beats and
// the destination's scope slot back to its storage row (tagged `__row` by the
// per-table wrappers below). Shared so the three folds derive strip spans
// identically.
export function transitionWindowsIn(scopes: Row[][], seqLen: number, loopFrames: number): TransitionWindow[] {
  const windows: TransitionWindow[] = []
  for (const scope of scopes) {
    for (let p = 0; p < scope.length; p++) {
      if (scope[p].event !== 'transition') continue
      const span = transitionSpan(scope, p, seqLen, loopFrames)
      if (!span) continue
      const start = frameToBeat(scope[p].index as number)
      windows.push({
        row: (scope[p] as { __row: number }).__row,
        start,
        end: start + framesToBeats(span.len),
        ...(span.endPos >= 0 ? { endRow: (scope[span.endPos] as { __row: number }).__row } : {}),
      })
    }
  }
  return windows
}

// The hydra table's transition strip-spans, scoped per `out` like the fold
// itself. `loopBeats` (0 → unwrapped) sets the content cycle transitions wrap.
export function hydraTransitionWindows(rows: Row[] | null | undefined, loopBeats = 0): TransitionWindow[] {
  const index = buildHydraIndex((rows ?? []).map((row, i) => ({ ...row, __row: i })))
  const loopFrames = beatsToFrames(loopBeats)
  const seqLen = contentSeqLen(index, loopFrames)
  const groups = new Map<string, Row[]>()
  for (const row of index) {
    const out = outputOf(row)
    const g = groups.get(out)
    if (g) g.push(row)
    else groups.set(out, [row])
  }
  return transitionWindowsIn([...groups.values()], seqLen, loopFrames)
}

// Is a wipe starting at frame `start` and lasting `len` frames active at
// `frame`, and how far through (0 → 1)? Distance is forward-wrapped over the
// content cycle so a window re-runs each pass and wrapped windows work when the
// playhead re-samples [0, loopFrames).
export function transitionAt(frame: number, start: number, len: number, seqLen: number): number | null {
  const dist = seqLen > 0 ? ((frame - start) % seqLen + seqLen) % seqLen : frame - start
  return dist >= 0 && dist < len ? dist / len : null
}

// The window bounds a transition exposes to its mask sketch, in `props.time`
// (seconds) units, plus the clamped 0 → 1 `transitionPos(t)` helper.
function transitionWindow(startFrame: number, windowFrames: number): { start: number; end: number; posFn: string } {
  const start = startFrame / FPS
  const dur = windowFrames / FPS
  return {
    start,
    end: start + dur,
    posFn: `(t) => Math.min(Math.max((t - ${start}) / ${dur}, 0), 1)`,
  }
}

// A setVariable value with its own row substituted in for field() reads —
// resolveBindings later sees the vars map as the row, which would read a
// sibling variable instead. A still-streaming value stays a binding.
function rowScopedValue(row: Row): unknown {
  const v = row.value
  if (!isBinding(v)) return v
  const node = substituteExpr(v.$expr, { fields: row })
  return isStreamingNode(node) ? { $expr: node } : evalExpr(node, row, 0)
}

// Apply one code-shape event — everything that mutates the running sketch
// string — returning the new code. setVariable/transition leave it unchanged.
function applyHydraShape(code: string | null, row: Row, output: string): string | null {
  switch (row.event) {
    case 'setCode':
      return typeof row.code === 'string' ? row.code : code
    case 'setSource':
      // Swap the head generator, keeping every effect (and .out()) after it.
      if (code != null && typeof row.code === 'string' && row.code.trim() !== '')
        return `${chainOf(row.code.trim())}${splitHead(code)[1]}`
      return code
    case 'replace':
      // Literal substring swap over the whole current sketch.
      if (code != null && typeof row.find === 'string' && row.find !== '')
        return code.split(row.find).join(row.value == null ? '' : String(row.value))
      return code
    case 'append':
      if (code != null && typeof row.code === 'string' && row.code.trim() !== '')
        return `${chainOf(code)}${row.code.trim()}.out(${output})`
      return code
    case 'layer':
      if (code != null && typeof row.code === 'string' && row.code.trim() !== '') {
        const mode = typeof row.mode === 'string' && row.mode in BLEND_OPS ? row.mode : 'blend'
        const amt = BLEND_OPS[mode] && hasAmount(row.value) ? `, ${amountExpr(row.value)}` : ''
        return `${chainOf(code)}.${mode}(${chainOf(row.code.trim())}${amt}).out(${output})`
      }
      return code
    default:
      return code
  }
}

// Fold one output's events (already sorted, filtered to this output) into its
// running code string; setVariable folds into the shared `vars`. A transition
// wipes from the code at its beat to the code at the next setCode ahead (its
// window end E), revealing that destination mid-wipe via look-ahead: code-shape
// events fold up to the furthest active window's E, while setVariable stays at
// the playhead. Returns null until a setCode establishes some code.
function foldOutput(
  rows: Row[], frame: number, output: string,
  vars: Record<string, unknown>, seqLen: number, loopFrames: number,
): string | null {
  for (const row of rows) {
    if ((row.index as number) > frame) break
    if (row.event === 'setVariable' && typeof row.name === 'string') vars[row.name] = rowScopedValue(row)
  }
  // Walk the whole scope in fold order: snapshot each active transition's
  // "before" and track the running code at the playhead. A wrapped window can
  // be active while its transition row sits past the playhead (an early
  // next-pass frame), so this doesn't stop at the playhead.
  const active: { before: string; mask: string; start: number; len: number; end: number }[] = []
  let running: string | null = null
  let codeAtF: string | null = null
  for (let p = 0; p < rows.length; p++) {
    const row = rows[p]
    if (row.event === 'transition') {
      if (running != null) {
        const span = transitionSpan(rows, p, seqLen, loopFrames)
        if (span != null && transitionAt(frame, row.index as number, span.len, seqLen) != null) {
          active.push({
            before: chainOf(running),
            mask: typeof row.code === 'string' ? row.code.trim() : '',
            start: row.index as number, len: span.len, end: span.end,
          })
        }
      }
    } else {
      running = applyHydraShape(running, row, output)
    }
    if ((row.index as number) <= frame) codeAtF = running
  }
  // The "after": code-shape folded up to the furthest active window end (the
  // playhead when nothing is wiping), so the destination shows through.
  const horizon = active.length ? Math.max(...active.map((a) => a.end)) : frame
  let after: string | null = null
  for (const row of rows) {
    if ((row.index as number) > horizon) break
    if (row.event !== 'transition') after = applyHydraShape(after, row, output)
  }
  const base = after ?? codeAtF
  if (base == null) return null

  // Apply the wipes from the innermost (latest) out: each earlier transition
  // blends its frozen "before" over the wipe that follows it, so nested
  // transitions compose in beat order.
  let result = chainOf(base)
  for (let i = active.length - 1; i >= 0; i--) {
    const t = active[i]
    const { start, end, posFn } = transitionWindow(t.start, t.len)
    if (t.mask !== '') {
      // Composite before (mask black) under after (mask white) through the
      // mask's luminance, binding transitionStart/End/Pos around the user's
      // mask sketch.
      const mask = `((transitionStart, transitionEnd, transitionPos) => (${chainOf(t.mask)}))(${start}, ${end}, ${posFn})`
      result = `${t.before}.layer((${result}).mask(${mask}))`
    } else {
      result = `${t.before}.blend((${result}), (props) => (${posFn})(props.time))`
    }
  }
  // Terminate on the `out` column's output, so a setCode's code never needs
  // its own `.out(...)` (an explicit one is normalised to the column's choice).
  return `${result}.out(${output})`
}

// The active sketch at (absolute) frame `f`: every event at/before it folds
// in, one running code string per output, concatenated. Sampling a frame in a
// later pass of the loop is just sampling further along the grid, so earlier
// passes fold in full for free. Returns null until some output reaches a
// setCode — playback then falls back to showing the raw scene.
export function hydraFrameAt(index: Row[], f: number, loopFrames = 0): HydraFrame | null {
  const frame = Math.floor(f)
  if (frame < 0) return null
  const seqLen = contentSeqLen(index, loopFrames)
  // Fold each output's stream independently; concatenate in output-name order
  // for a deterministic program.
  const groups = new Map<string, Row[]>()
  for (const row of index) {
    const out = outputOf(row)
    const g = groups.get(out)
    if (g) g.push(row)
    else groups.set(out, [row])
  }
  const vars: Record<string, unknown> = {}
  const codes: string[] = []
  for (const out of [...groups.keys()].sort()) {
    const code = foldOutput(groups.get(out)!, frame, out, vars, seqLen, loopFrames)
    if (code != null) codes.push(code)
  }
  return codes.length === 0 ? null : { code: codes.join('\n'), vars }
}

// The compiled sketch shown for one table row: the full fold sampled at that
// row's own frame — exactly what the runtime shows there. So a transition row's
// popover shows the composite including the next setCode (look-ahead), and the
// destination setCode row's popover (a window end, end-exclusive) shows the
// plain after program. Powers the table panel's per-row "compiled code"
// popover; loopFrames defaults to unwrapped when the panel has no loop handy.
export function hydraCodeUpToRow(rows: Row[] | null | undefined, rowIndex: number, loopFrames = 0): string | null {
  const all = rows ?? []
  if (!isHydraRow(all[rowIndex])) return null
  // Tag rows with their original position so the target is findable after the
  // frame sort.
  const index = buildHydraIndex(all.map((row, i) => ({ ...row, __row: i })))
  const pos = index.findIndex((r) => (r as { __row?: number }).__row === rowIndex)
  if (pos < 0) return null
  return hydraFrameAt(index, index[pos].index as number, loopFrames)?.code ?? null
}
