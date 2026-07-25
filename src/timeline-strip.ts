// The timeline strip's pure model — geometry, grid, handle derivation, hit
// testing and drag math. No DOM; src/ui/timeline-strip.tsx is the view.
//
// Coordinate rules (see notes/timeline-strip-plan.md "Coordinate rules"):
// beats are 1-indexed positions, the strip's px axis is 0..maxBeats elapsed
// beats, so beat b sits at elapsed (b - 1). The `timeline` table's own rows
// already live on this playback axis (identity); every other table's `beat`
// is a *source* beat, placed onto the axis through `placeBeat`.
//
// Tracks (DAW-style): the strip can stack read-only bands under the open
// table's interactive one, one per cooked out view (stripLayout's `out`
// argument) — the rows playback will actually consume, any .retime() already
// baked in by the cook, placed through the APPLIED timeline so indicators sit
// where the visual changes will happen.

import type { Row } from './lineage.js'
import type { EditableColumn } from './editable-tables.js'
import { formatEditableCell } from './table-panel.js'
import { placeBeat, timelineSegments, buildTimeline, windowsFor, type Timeline, type TimelineSegment } from './timeline.js'
import { hydraTransitionWindows, type TransitionWindow } from './hydra.js'
import { postSpanWindows, postGlidePairs } from './post.js'
import { baubleTransitionWindows } from './bauble.js'

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

// The fold tables whose bars come from a fold window (a transition's until-next
// wipe width, or a post pulse's [beat, beat + dur) extent) rather than a `dur`
// column. A table absent here falls back to its `dur` (scene/origami/path keep
// their live-dur spans); a fold table's other events — and any stray `dur` on
// one — draw a point, never a misleading bar.
const FOLD_WINDOWS: Record<string, (rows: Row[], loopBeats?: number) => TransitionWindow[]> = {
  hydra: hydraTransitionWindows,
  post: postSpanWindows,
  bauble: baubleTransitionWindows,
}

// Fold tables whose eased keyframes glide from a previous row: the arriving
// row's point handle carries a `glideFrom` arrow (the view draws a connector,
// arrowhead on arrival, and hover-links the pair). Only post has an ease column.
const FOLD_GLIDES: Record<string, (rows: Row[]) => { row: number; from: number }[]> = {
  post: postGlidePairs,
}

export interface StripGeometry {
  width: number
  maxBeats: number
}

export function beatToX(geometry: StripGeometry, beat: number): number {
  const { width, maxBeats } = geometry
  if (!(maxBeats > 0)) return 0
  return ((beat - 1) / maxBeats) * width
}

export function xToBeat(geometry: StripGeometry, x: number): number {
  const { width, maxBeats } = geometry
  if (!(width > 0)) return 1
  return (x / width) * maxBeats + 1
}

export interface GridLine {
  beat: number
  x: number
  kind: 'minor' | 'major'
  // Present only on major ticks, and only when major ticks are far enough
  // apart to read — dropped wholesale (not thinned) once they'd collide.
  label?: string
}

const MAJOR_EVERY = 4
const MIN_LABEL_SPACING_PX = 24

export function gridLines(maxBeats: number, width: number): GridLine[] {
  if (!(maxBeats > 0) || !(width > 0)) return []
  const geometry: StripGeometry = { width, maxBeats }
  const pxPerBeat = width / maxBeats
  const showLabels = pxPerBeat * MAJOR_EVERY >= MIN_LABEL_SPACING_PX
  const lastBeat = Math.floor(maxBeats) + 1
  const lines: GridLine[] = []
  for (let beat = 1; beat <= lastBeat; beat++) {
    const major = (beat - 1) % MAJOR_EVERY === 0
    lines.push({
      beat,
      x: beatToX(geometry, beat),
      kind: major ? 'major' : 'minor',
      label: major && showLabels ? String(beat) : undefined,
    })
  }
  return lines
}

// One draggable descriptor. `row` (storage index) is the identity that
// survives re-sorting and re-derivation mid-drag.
export interface Handle {
  row: number
  kind: 'point' | 'span'
  // Playback-axis position (post placeBeat for non-timeline tables).
  beat: number
  // Far edge of a span — a stored-dur span keeps its length in the row's `dur`
  // column (a pure move never touches it, an edge drag writes it back); a
  // `derived` span's edge is computed, not stored.
  end?: number
  // A derived (until-next) span whose length isn't a stored `dur` — the
  // `timeline` table's windows and a fold table's transition spans. An edge
  // drag can't write dur back: a start edge just moves the row, and an end
  // edge with an `endRow` moves that destination instead.
  derived?: boolean
  // The destination setCode a fold transition wipes toward: the view draws an
  // arrowhead to its point handle (hover-linking the pair) and an end drag
  // retargets THAT row's beat. Absent on a wrap tail and on inert transitions.
  endRow?: number
  // The previous same-name setVariable row an eased keyframe glides from: this
  // (point) handle is the arrival, and the view draws a connector arrow from
  // that row's point to here (arrowhead on arrival), hover-linking the pair.
  // Each point still drags itself — the arrow just follows.
  glideFrom?: number
  lane: number
  // A later placement of the same row (a loop event playing it more than
  // once) — draggable, but not the "primary" one a click should focus.
  ghost: boolean
  disabled: boolean
  // Set (> 0) when this placement wrapped past one pass's worth of beats —
  // an active timeline's span with loops > 1, or (with no timeline) the
  // GUI loop length — so later content forms another pass instead of
  // running off the strip. Omitted (not just 0) for the common unwrapped
  // case, so existing handle-shape assertions don't need to know about it.
  pass?: number
  // Index into stripLayout's `out.tracks` for a handle on a read-only out-view
  // band; absent on the open table's own (interactive) handles.
  track?: number
}

// Which pass `beat` falls in, and its beat local to that pass — a beat past
// one `unit`-length pass wraps into the next rather than rendering off-strip
// (notes/timeline-strip-plan.md "Beats past maxBeats"). `maxPass` clamps to
// an active timeline's actual loop count (so the map's shared terminal instant
// resolves to the last pass, not a phantom one after it); omitted when passes
// are unbounded (content run long with no timeline defined).
function wrapPass(beat: number, unit: number | undefined, maxPass?: number): { local: number; pass: number } {
  if (!(unit && unit > 0)) return { local: beat, pass: 0 }
  let pass = Math.max(0, Math.floor((beat - 1) / unit))
  if (maxPass !== undefined) pass = Math.min(pass, maxPass)
  return { local: beat - pass * unit, pass }
}

// Positional/bookkeeping columns the hover/drag readout skips: position is
// what the strip already shows visually (and as the unlabeled tag on the
// handle itself), so the readout is reserved for what identifies the row.
const POSITIONAL_COLS = new Set(['beat', 'dur', 'loop', 'disabled'])

// First non-blank line of a code cell, whitespace-collapsed and capped — a
// sketch identifies its row at a glance without flooding the readout.
function codeSnippet(code: string, max = 48): string {
  const line = code.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  const collapsed = line.replace(/\s+/g, ' ')
  return collapsed.length > max ? collapsed.slice(0, max - 1) + '…' : collapsed
}

// The row's *meaningful* columns, one readout line each (the view stacks
// them): what the row IS — its event kind (unlabeled, it's the identity), a
// code cell's first line, and the remaining non-blank values labeled by
// column — never its position (POSITIONAL_COLS), which the strip shows
// visually. Column order is the schema's, so each event type naturally leads
// with whatever its table puts first; capped at `max` lines.
export function meaningfulSummary(row: Row, columns: EditableColumn[], max = 4): string[] {
  const parts: string[] = []
  for (const c of columns) {
    if (parts.length >= max) break
    if (POSITIONAL_COLS.has(c.name)) continue
    const v = row[c.name]
    if (v == null || v === '' || v === false) continue
    if (c.name === 'event') parts.push(String(v))
    else if (c.type === 'code') parts.push(codeSnippet(String(v)))
    else parts.push(`${c.name} ${formatEditableCell(c.type, v)}`)
  }
  return parts
}

// Applies an in-progress drag's not-yet-committed values to one row before
// handle derivation, so every placement of that row (a loop event's ghosts
// included) recomputes from the dragged position — merging at the Handle
// level instead would miss ghosts, since they're re-derived from the row via
// placeBeat, not copied from the primary handle.
export function withPreview(rows: Row[], preview: { row: number; values: Record<string, unknown> } | null): Row[] {
  if (!preview) return rows
  const row = rows[preview.row]
  if (!row) return rows
  const next = rows.slice()
  next[preview.row] = { ...row, ...preview.values }
  return next
}

// A handle tagged with the pass group it belongs to, before sub-lane packing
// resolves its final `lane`. The `group` is internal — stripped from the
// public Handle stripLayout returns.
type RawHandle = Handle & { group: number }

// Every placement's raw handle plus how many pass groups the strip spans.
// The `timeline` table's own rows are until-next windows (windowsFor), already
// on the playback axis; every other table's `beat` is a source beat placed via
// placeBeat, wrapping past one pass into a "pass n" badge. A fold table draws a
// transition as its fold window (FOLD_WINDOWS) — a wrapped window (its
// destination earlier in the loop) splits into two arcs; other tables fall
// back to their `dur` column. An active timeline's passes are the groups —
// except under `flat` (an out-view track band), where every pass shares one
// group (the band stays compact) and only the "pass n" badge marks the wrap.
function buildRaw(
  name: string, rows: Row[], columns: EditableColumn[], timelineRows: Row[], loopBeats?: number,
  flat = false,
): { raw: RawHandle[]; groupCount: number } {
  const colNames = new Set(columns.map((c) => c.name))
  const raw: RawHandle[] = []

  if (name === 'timeline') {
    // windowsFor drops disabled rows (their window falls to their neighbors),
    // so they get no handle. Its spans are derived: an edge belongs to the
    // neighbouring row, never a stored dur.
    for (const w of windowsFor(rows, loopBeats)) {
      raw.push({ row: w.row, kind: 'span', beat: w.beat, end: w.end, lane: w.lane, group: w.lane, ghost: false, disabled: false, derived: true })
    }
    const groupCount = raw.reduce((m, h) => Math.max(m, h.group + 1), buildTimeline(timelineRows, loopBeats).loops)
    return { raw, groupCount }
  }

  const segments = timelineSegments(timelineRows, loopBeats)
  const timeline = segments.length ? buildTimeline(timelineRows, loopBeats) : null
  const wrapUnit = timeline ? timeline.beats : loopBeats
  const maxPass = timeline ? Math.max(0, timeline.loops - 1) : undefined
  const loopEnd = wrapUnit && wrapUnit > 0 ? wrapUnit + 1 : Infinity
  const foldWindows = FOLD_WINDOWS[name]
    ? new Map(FOLD_WINDOWS[name](rows, loopBeats).map((w) => [w.row, w]))
    : null
  const glides = FOLD_GLIDES[name]
    ? new Map(FOLD_GLIDES[name](rows).map((g) => [g.row, g.from]))
    : null
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const beat = num(row.beat)
    if (beat === undefined) continue
    const win = foldWindows?.get(i)
    const glideFrom = glides?.get(i)
    const dur = foldWindows
      ? (win ? win.end - win.start : undefined)
      : colNames.has('dur') ? num(row.dur) : undefined
    const disabled = row.disabled === true
    const placements = segments.length ? placeBeat(segments, beat) : [{ beat, stretch: 1 }]
    placements.forEach((p, idx) => {
      const w = wrapPass(p.beat, wrapUnit, maxPass)
      const group = timeline && !flat ? w.pass : 0
      const common = {
        row: i, group, lane: group, ghost: idx > 0, disabled,
        ...(w.pass > 0 ? { pass: w.pass } : {}),
      }
      if (dur === undefined) {
        raw.push({ ...common, kind: 'point', beat: w.local, ...(glideFrom !== undefined ? { glideFrom } : {}) })
        return
      }
      const end = w.local + dur * p.stretch
      if (win && end > loopEnd + 1e-6) {
        // A wrapped fold window runs off the strip's end and re-enters at the
        // start: a tail arc to the loop's end (no arrowhead) and a head arc
        // from the start to the destination (arrowhead), reusing span machinery.
        raw.push({ ...common, kind: 'span', beat: w.local, end: loopEnd, derived: true })
        raw.push({ ...common, kind: 'span', beat: 1, end: end - (wrapUnit as number), derived: true, endRow: win.endRow })
        return
      }
      raw.push({
        ...common, kind: 'span', beat: w.local, end,
        ...(win ? { derived: true as const, ...(win.endRow !== undefined ? { endRow: win.endRow } : {}) } : {}),
      })
    })
  }
  return { raw, groupCount: timeline && !flat ? timeline.loops : 1 }
}

// Greedy interval packing: within each pass group, spans overlapping in their
// [beat, end) range stack into sub-lanes (first-fit by start beat), while
// points and empty groups sit at the group's base sub-lane. Groups lay out
// contiguously in pass order, so pass g owns lanes [base[g], base[g + 1]).
// Writes each handle's packed `lane` back and returns the layout.
function packLanes(raw: RawHandle[], groupCount: number): { base: number[]; laneCount: number } {
  const perGroup: RawHandle[][] = Array.from({ length: groupCount }, () => [])
  for (const h of raw) if (h.group >= 0 && h.group < groupCount) perGroup[h.group].push(h)
  const base: number[] = []
  let cursor = 0
  for (let g = 0; g < groupCount; g++) {
    base[g] = cursor
    const spans = perGroup[g]
      .filter((h) => h.kind === 'span')
      .sort((a, b) => a.beat - b.beat || (a.end ?? a.beat) - (b.end ?? b.beat) || a.row - b.row)
    const ends: number[] = []
    for (const h of spans) {
      let s = ends.findIndex((e) => e <= h.beat)
      if (s < 0) { s = ends.length; ends.push(0) }
      ends[s] = h.end ?? h.beat
      h.lane = cursor + s
    }
    for (const h of perGroup[g]) if (h.kind !== 'span') h.lane = cursor
    cursor += Math.max(1, ends.length)
  }
  return { base, laneCount: Math.max(1, cursor) }
}

// A cooked out view rendered as its own read-only band: `name` is the
// consumer kind ('three', 'hydra', …) — also the FOLD_WINDOWS/FOLD_GLIDES
// key — and `rows` the applied cook's rows for it, any .retime() already
// baked in.
export interface OutTrack {
  name: string
  rows: Row[]
}

// One horizontal band of a multi-track strip: the open table's interactive
// band first (when a table is open), then one band per out view with any
// handles. `track` indexes the OutTrack a non-interactive band renders,
// matching its handles' own `track` tag.
export interface StripTrack {
  name: string
  base: number
  end: number
  interactive: boolean
  track?: number
}

export interface StripLayout {
  // Every placement's public handle, packed lanes written back.
  handles: Handle[]
  // Total lane bands the strip needs — packed sub-lanes included.
  laneCount: number
  // The first lane of each of the INTERACTIVE band's passes; pass g spans
  // [passBase[g], passBase[g + 1]). Length is the pass count, so
  // passBase.length > 1 means a multi-pass strip; empty means no open table.
  passBase: number[]
  // The bands stacked top to bottom; a single-table strip is one interactive
  // band spanning every lane.
  tracks: StripTrack[]
}

// Minimal column specs inferred from cooked rows, which carry no editable
// schema: every key seen with a non-null value, `event` hoisted first so
// readouts lead with the row's identity. Enough for meaningfulSummary and
// buildRaw's dur detection — never for editing.
export function columnsFromRows(rows: Row[]): EditableColumn[] {
  const seen = new Map<string, EditableColumn['type']>()
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (v == null || seen.has(k)) continue
      seen.set(k, typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : k === 'code' ? 'code' : 'string')
    }
  }
  const columns = [...seen].map(([name, type]) => ({ name, type }))
  const ev = columns.findIndex((c) => c.name === 'event')
  if (ev > 0) columns.unshift(...columns.splice(ev, 1))
  return columns
}

// The strip's handles and the lane layout they pack into. The open table
// (`name` — pass '' for none) keeps today's interactive behavior: passes as
// lane groups, placed through the LIVE timeline rows. `out` stacks a read-only
// band per cooked view under it, placed through `out.timelineRows` — the
// APPLIED cook's, the ones playback actually warps by — with passes kept flat
// (badges, not lanes) so each band stays compact. Coverage shading and pass
// labels key off passBase so a pass's tint spans exactly its sub-lanes.
export function stripLayout(
  name: string, rows: Row[], columns: EditableColumn[], timelineRows: Row[], loopBeats?: number,
  out?: { tracks: OutTrack[]; timelineRows: Row[] },
): StripLayout {
  const handles: Handle[] = []
  const tracks: StripTrack[] = []
  let passBase: number[] = []
  let cursor = 0
  if (name !== '') {
    const { raw, groupCount } = buildRaw(name, rows, columns, timelineRows, loopBeats)
    const { base, laneCount } = packLanes(raw, groupCount)
    passBase = base
    handles.push(...raw.map(({ group: _group, ...h }) => h))
    tracks.push({ name, base: 0, end: laneCount, interactive: true })
    cursor = laneCount
  }
  for (const [i, t] of (out?.tracks ?? []).entries()) {
    const built = buildRaw(t.name, t.rows, columnsFromRows(t.rows), out!.timelineRows, loopBeats, true)
    // A multi-pass warp folds every pass onto the same flat band, so later
    // passes usually duplicate an earlier placement exactly — keep the first
    // (packLanes would stack identical spans into phantom sub-lanes); the
    // interactive band is where passes genuinely stack.
    const seen = new Set<string>()
    const raw = built.raw.filter((h) => {
      const key = `${h.row}:${h.beat}:${h.end ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    // An empty band still renders (its rows place nowhere under the current
    // warp) — band presence must match the caller's track list, which is
    // also what widens the transport.
    const { laneCount } = packLanes(raw, 1)
    for (const h of raw) h.lane += cursor
    handles.push(...raw.map(({ group: _group, ...h }) => ({ ...h, track: i })))
    tracks.push({ name: t.name, base: cursor, end: cursor + laneCount, interactive: false, track: i })
    cursor += laneCount
  }
  return { handles, laneCount: Math.max(1, cursor), passBase, tracks }
}

export interface CoverageBand {
  p0: number
  p1: number
  lane: number
  kind?: TimelineSegment['kind']
}

// One tinted band per compiled segment, its beats mapped from the extended
// playback axis (see timeline.ts's compile) onto its own pass's local
// 0..span axis and tagged with which lane that pass is — mirrors stripLayout's
// content-row wrap. A window that spans a pass boundary (a row in an earlier
// pass whose next row is a later one) tints the band by its p0's lane; the
// common case, a pass filled by its own rows, keeps p0 and p1 in one lane.
export function coverageBands(timelineRows: Row[], loopBeats?: number): CoverageBand[] {
  const timeline = buildTimeline(timelineRows, loopBeats)
  if (!timeline.active) return []
  const span = timeline.beats
  const maxLane = Math.max(0, timeline.loops - 1)
  return timelineSegments(timelineRows, loopBeats).map((seg) => {
    const lane = span > 0 ? Math.min(maxLane, Math.max(0, Math.floor((seg.p0 - 1) / span))) : 0
    const off = lane * span
    return { p0: seg.p0 - off, p1: seg.p1 - off, lane, kind: seg.kind }
  })
}

// Which storage rows of the `timeline` table have drifted from the applied
// cook (the strip's dashed-outline "pending" style). v1 only covers this
// table: its store rows and the applied cook's `table("timeline")` rows line
// up index-for-index once disabled rows are excluded (ensure()'s
// visibleRows filters the same way before a program ever sees them), so a
// straight positional comparison works without needing row identity carried
// through the cook.
export function pendingTimelineRows(rows: Row[], appliedRows: Row[]): Set<number> {
  const pending = new Set<number>()
  let pos = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.disabled === true) continue
    const applied = appliedRows[pos]
    pos++
    if (!applied || num(row.beat) !== num(applied.beat) || num(row.loop) !== num(applied.loop)) pending.add(i)
  }
  return pending
}

export type HitPart = 'start' | 'end' | 'body'

export interface HitResult {
  row: number
  part: HitPart
}

// Wide enough that a fingertip can land on a span's edge to resize it, not
// just a mouse cursor — the edge shows a resize cursor on hover, so the
// larger zone is self-correcting for the mouse.
const EDGE_TOLERANCE_PX = 12

// Which handle (and which part of it) sits under a pointer at `(x, lane)`.
// Edges win over body within EDGE_TOLERANCE_PX; among body hits a point
// handle (a precise target) wins over a span's body (a broad one) at the
// same spot. Null means background — the strip's view treats that as inert
// (it no longer scrubs).
interface Candidate {
  result: HitResult
  priority: number
  dist: number
}

// A later candidate only replaces the best one so far if it's a strictly
// higher-priority tier, or a closer match within the same tier.
function better(prev: Candidate | null, next: Candidate): Candidate {
  if (!prev || next.priority > prev.priority || (next.priority === prev.priority && next.dist < prev.dist)) return next
  return prev
}

export function hitTest(handles: Handle[], geometry: StripGeometry, x: number, lane: number): HitResult | null {
  let best: Candidate | null = null

  for (const h of handles) {
    if (h.lane !== lane) continue
    const startX = beatToX(geometry, h.beat)
    if (h.kind === 'span' && h.end !== undefined) {
      const endX = beatToX(geometry, h.end)
      const dStart = Math.abs(x - startX)
      const dEnd = Math.abs(x - endX)
      if (dStart <= EDGE_TOLERANCE_PX) best = better(best, { result: { row: h.row, part: 'start' }, priority: 2, dist: dStart })
      if (dEnd <= EDGE_TOLERANCE_PX) best = better(best, { result: { row: h.row, part: 'end' }, priority: 2, dist: dEnd })
      if (x >= startX && x <= endX) {
        best = better(best, { result: { row: h.row, part: 'body' }, priority: 1, dist: Math.min(dStart, dEnd) })
      }
    } else if (Math.abs(x - startX) <= EDGE_TOLERANCE_PX) {
      best = better(best, { result: { row: h.row, part: 'body' }, priority: 1.5, dist: Math.abs(x - startX) })
    }
  }
  return best ? best.result : null
}

// hitTest only identifies a row+part, not which physical Handle answered it —
// a row played by a loop event has one ghost per placement, each at its own
// x, and a drag needs the actual placement grabbed (its beat/end/lane) to
// compute dBeats against. Re-scans just that row's candidates by the same
// edge-vs-body distance hitTest itself used; the common case (one placement)
// short-circuits without the scan.
export function resolveHandle(handles: Handle[], geometry: StripGeometry, hit: HitResult, x: number, lane: number): Handle | undefined {
  const candidates = handles.filter((h) => h.row === hit.row && h.lane === lane)
  if (candidates.length <= 1) return candidates[0]
  let best: Handle | undefined
  let bestDist = Infinity
  for (const h of candidates) {
    const target = hit.part === 'end' ? (h.end ?? h.beat) : h.beat
    const dist = Math.abs(x - beatToX(geometry, target))
    if (dist < bestDist) { bestDist = dist; best = h }
  }
  return best
}

export type SnapMode = 'quarter' | 'coarse' | 'free'

// Quarter-beat by default, whole beats under 'coarse' (Shift), unsnapped
// under 'free' (Alt) — always clamped to the first beat.
export function snap(beat: number, opts: { mode?: SnapMode } = {}): number {
  const mode = opts.mode ?? 'quarter'
  const snapped = mode === 'coarse' ? Math.round(beat) : mode === 'free' ? beat : Math.round(beat * 4) / 4
  return Math.max(1, snapped)
}

// Snaps a drag delta so the point it actually moves (`anchor` — the handle's
// own beat for a move/start drag, its end for an end drag) lands exactly on
// the snap grid. Snapping the raw delta itself would only land on-grid when
// the handle's starting position already was.
export function snapDelta(anchor: number, dBeats: number, opts: { mode?: SnapMode } = {}): number {
  return snap(anchor + dBeats, opts) - anchor
}

export interface DragOptions {
  // Minimum span (beats) a 'start'/'end' drag may shrink a span to.
  minSpan?: number
  // Set when dragging a non-'timeline' table's handle under an active
  // timeline: inverts the playback-axis drop position back to the row's
  // stored source beat via sourceBeatAt, so storage matches where the
  // handle visually landed.
  timeline?: Timeline
}

export interface DragResult {
  row: number
  values: Record<string, unknown>
}

const DEFAULT_MIN_SPAN = 0.25

// The drag reuses hitTest's `part` vocabulary directly: a handle's body is
// dragged by moving it, an edge ('start'/'end') by resizing that edge.
export function dragUpdate(handle: Handle, part: HitPart, dBeats: number, opts: DragOptions = {}): DragResult {
  const minSpan = opts.minSpan ?? DEFAULT_MIN_SPAN
  const { row, beat, end, pass, derived, endRow } = handle
  // A wrapped placement's `beat`/`end` are local to its own pass (wrapPass) —
  // sourceBeatAt needs that pass back to re-derive the right extended-axis
  // point, the same `loop` argument buildTimeline's own multi-pass playback
  // uses.
  const toSource = (b: number): number => (opts.timeline?.active ? opts.timeline.sourceBeatAt(b, pass ?? 0) : b)

  if (part === 'body') {
    // A span's length (`dur`) is untouched by a pure move, so its window
    // keeps the same duration wherever it lands.
    const nextBeat = Math.max(1, beat + dBeats)
    return { row, values: { beat: toSource(nextBeat) } }
  }

  // A derived span has no stored dur to resize. Its end edge belongs to the
  // destination setCode (a fold transition's `endRow`): dragging it moves THAT
  // row's beat. Every other edge just moves this row — the window recomputes.
  if (derived) {
    if (part === 'end' && endRow !== undefined) {
      const nextEnd = Math.max((end ?? beat) + dBeats, beat + minSpan)
      return { row: endRow, values: { beat: toSource(nextEnd) } }
    }
    const nextBeat = Math.max(1, beat + dBeats)
    return { row, values: { beat: toSource(nextBeat) } }
  }

  if (part === 'start') {
    const fixedEnd = end ?? beat
    const nextBeat = Math.max(1, Math.min(beat + dBeats, fixedEnd - minSpan))
    if (end !== undefined) {
      return { row, values: { beat: toSource(nextBeat), dur: toSource(fixedEnd) - toSource(nextBeat) } }
    }
    return { row, values: { beat: toSource(nextBeat) } }
  }

  // part === 'end'
  const nextEnd = Math.max((end ?? beat) + dBeats, beat + minSpan)
  return { row, values: { dur: toSource(nextEnd) - toSource(beat) } }
}

// Whether a drag's payload actually changes the stored row — a gesture that
// snaps back to where it started (or a sub-threshold press that never became
// a drag) must commit nothing.
export function valuesDiffer(row: Row, values: Record<string, unknown>): boolean {
  return Object.entries(values).some(([k, v]) => row[k] !== v)
}

// Pointerdown-to-drag movement threshold, squared to skip a sqrt per move.
export function exceedsDragThreshold(dx: number, dy: number, thresholdPx = 3): boolean {
  return dx * dx + dy * dy > thresholdPx * thresholdPx
}
