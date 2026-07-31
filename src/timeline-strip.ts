// The timeline strip's pure model — geometry, grid, handle derivation, hit
// testing and drag math. No DOM; src/ui/timeline-strip.tsx is the view.
//
// Coordinate rules:
// beats are 1-indexed positions, the strip's px axis is 0..maxBeats elapsed
// beats, so beat b sits at elapsed (b - 1). The `timeline` table's own rows
// already live on this playback axis (identity); every other table's `beat`
// is a *source* beat, placed onto the axis through `placeBeat`.
//
// Sections (see timeline-sections.ts): one sectionLayout call per band, each
// laying out ONE table at the ONE pass playback is currently showing. The DOM
// stacks the bands, so nothing here knows how many there are — a section's
// lanes are only its own overlapping spans.

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

// The editable store row a handle writes through: `row` is a storage index
// into that table, exactly what store.setRow takes.
export interface HandleSource {
  table: string
  row: number
}

// Trace one of a section's rows back to the editable store row it came from
// (its lineage refs, resolved by the caller — this module stays store-
// agnostic), reporting that row's *stored* beat so sectionLayout can check
// nothing moved it. Undefined for a row with no editable, non-log origin.
export type ResolveSource = (row: Row) => (HandleSource & { beat: number }) | undefined

// A stored beat and a drawn beat count as the same position within this much —
// both sides are float arithmetic through the warp.
const BEAT_EPSILON = 1e-9

// One draggable descriptor. `row` (storage index) is the identity that
// survives re-sorting and re-derivation mid-drag.
export interface Handle {
  row: number
  kind: 'point' | 'span'
  // Playback-axis position (post placeBeat for non-timeline tables).
  beat: number
  // Far edge of a span — a stored-dur span keeps its length in the row's `dur`
  // column (a move never touches it); a fold window's edge is computed from
  // the neighbouring row instead.
  end?: number
  // The destination setCode a fold transition wipes toward: the view draws an
  // arrowhead to its point handle, hover-linking the pair. Absent on a wrap
  // tail and on inert transitions.
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
  // Which TIMELINE pass this placement belongs to, set (> 0) only past the
  // first — dragUpdate needs it to invert the right pass's warp. Omitted (not
  // just 0) for the common single-pass case, so existing handle-shape
  // assertions don't need to know about it.
  pass?: number
  // The store row a drag writes to, when this placement is still sitting on
  // that row's stored beat. Absent when a warp, a retime or a content-pass
  // wrap moved it: the handle is where playback shows the event, not where
  // the row says it is, so writing the drawn beat back would mean something
  // else.
  source?: HandleSource
}

// Which pass `beat` falls in, and its beat local to that pass — a beat past
// one `unit`-length pass wraps into the next rather than rendering off-strip.
// `maxPass` clamps to
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

// Which pass of each axis a section is showing. The two are INDEPENDENT:
// `content` is the visualizer's own pass, counted in SOURCE space, where
// a row whose beat runs past one loop length forms a later pass of its content
// (visualizer.ts's passOffset); `timeline` is playback's pass through a
// multi-pass warp, counted in PLAYBACK space, before the map is applied.
// Conflating them looks right with no timeline and mis-places everything under
// one — so rows are filtered by `content` BEFORE placeBeat and placements by
// `timeline` AFTER it.
export interface SectionPasses {
  content: number
  timeline: number
}

const PASS_ZERO: SectionPasses = { content: 0, timeline: 0 }

// One section's placements, at its current pass. The `timeline` table's own
// rows are until-next windows (windowsFor), already on the playback axis and
// already pass-local, so picking the current pass is their whole filter. Every
// other table's `beat` is a source beat: wrapped into its content pass first,
// then placed via placeBeat, then kept only if it lands in the current
// timeline pass. A fold table draws a transition as its fold window
// (FOLD_WINDOWS) — a wrapped window (its destination earlier in the loop)
// splits into two arcs; other tables fall back to their `dur` column.
function buildRaw(
  name: string, rows: Row[], columns: EditableColumn[], timelineRows: Row[], loopBeats: number | undefined,
  passes: SectionPasses, resolveSource?: ResolveSource,
): Handle[] {
  const raw: Handle[] = []

  if (name === 'timeline') {
    // windowsFor drops disabled rows (their window falls to their neighbors),
    // so they get no handle. These rows ARE the live store rows, so a
    // window's index is its storage index.
    for (const w of windowsFor(rows, loopBeats)) {
      if (w.lane !== passes.timeline) continue
      raw.push({
        row: w.row, kind: 'span', beat: w.beat, end: w.end, lane: 0,
        ghost: false, disabled: false, source: { table: name, row: w.row },
      })
    }
    return raw
  }

  const colNames = new Set(columns.map((c) => c.name))
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
    const src = wrapPass(beat, loopBeats)
    if (src.pass !== passes.content) continue
    const win = foldWindows?.get(i)
    const glideFrom = glides?.get(i)
    const dur = foldWindows
      ? (win ? win.end - win.start : undefined)
      : colNames.has('dur') ? num(row.dur) : undefined
    const disabled = row.disabled === true
    const store = resolveSource?.(row)
    // Drawn where the store row says it is → a drag can write the drawn beat
    // straight back; anywhere else the map moved it and it stays inert.
    const srcTag = (at: number): { source?: HandleSource } =>
      store && Math.abs(store.beat - at) < BEAT_EPSILON ? { source: { table: store.table, row: store.row } } : {}
    const placements = (segments.length ? placeBeat(segments, src.local) : [{ beat: src.local, stretch: 1 }])
      .map((p) => ({ ...wrapPass(p.beat, wrapUnit, maxPass), stretch: p.stretch }))
      .filter((p) => p.pass === passes.timeline)
    placements.forEach((p, idx) => {
      const common = {
        row: i, lane: 0, ghost: idx > 0, disabled,
        ...(p.pass > 0 ? { pass: p.pass } : {}),
      }
      if (dur === undefined) {
        raw.push({ ...common, kind: 'point', beat: p.local, ...srcTag(p.local), ...(glideFrom !== undefined ? { glideFrom } : {}) })
        return
      }
      const end = p.local + dur * p.stretch
      if (win && end > loopEnd + 1e-6) {
        // A wrapped fold window runs off the strip's end and re-enters at the
        // start: a tail arc to the loop's end (no arrowhead) and a head arc
        // from the start to the destination (arrowhead), reusing span machinery.
        raw.push({ ...common, kind: 'span', beat: p.local, end: loopEnd, ...srcTag(p.local) })
        raw.push({ ...common, kind: 'span', beat: 1, end: end - (wrapUnit as number), endRow: win.endRow, ...srcTag(1) })
        return
      }
      raw.push({
        ...common, kind: 'span', beat: p.local, end, ...srcTag(p.local),
        ...(win?.endRow !== undefined ? { endRow: win.endRow } : {}),
      })
    })
  }
  return raw
}

// Greedy interval packing within one section: spans overlapping in their
// [beat, end) range stack into sub-lanes (first-fit by start beat), while
// points sit at lane 0. Writes each handle's packed `lane` back and returns
// how many lanes the section needs.
function packLanes(handles: Handle[]): number {
  const spans = handles
    .filter((h) => h.kind === 'span')
    .sort((a, b) => a.beat - b.beat || (a.end ?? a.beat) - (b.end ?? b.beat) || a.row - b.row)
  const ends: number[] = []
  for (const h of spans) {
    let s = ends.findIndex((e) => e <= h.beat)
    if (s < 0) { s = ends.length; ends.push(0) }
    ends[s] = h.end ?? h.beat
    h.lane = s
  }
  return Math.max(1, ends.length)
}

export interface StripLayout {
  // Every placement's handle, packed lanes written back.
  handles: Handle[]
  // Sub-lane bands this section needs — overlapping spans only.
  laneCount: number
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

// One section's band: the handles for `name`'s rows at the pass playback is
// showing, and the sub-lanes they pack into. `timelineRows` is whichever warp
// the section's rows are subject to — the APPLIED cook's for a cooked out
// view (the rows playback actually consumes), the live store rows for a
// section being edited. `resolveSource` decides draggability per row (see
// Handle.source); omit it for a read-only section.
export function sectionLayout(
  name: string, rows: Row[], columns: EditableColumn[], timelineRows: Row[], loopBeats?: number,
  passes: SectionPasses = PASS_ZERO, resolveSource?: ResolveSource,
): StripLayout {
  const handles = buildRaw(name, rows, columns, timelineRows, loopBeats, passes, resolveSource)
  return { handles, laneCount: packLanes(handles) }
}

export interface CoverageBand {
  p0: number
  p1: number
  lane: number
  kind?: TimelineSegment['kind']
}

// One tinted band per compiled segment, its beats mapped from the extended
// playback axis (see timeline.ts's compile) onto its own pass's local
// 0..span axis and tagged with which pass that is — mirrors sectionLayout's
// timeline-pass wrap, so a consumer draws the current pass by filtering
// `band.lane === passes.timeline`. A window that spans a pass boundary (a row
// in an earlier pass whose next row is a later one) tints by its p0's pass;
// the common case, a pass filled by its own rows, keeps p0 and p1 in one.
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

// Wide enough that a fingertip, not just a mouse cursor, can land on a
// handle: a point is grabbable across its whole neighbourhood, and a span a
// little past either edge.
const EDGE_TOLERANCE_PX = 12

interface Candidate {
  row: number
  priority: number
  dist: number
}

// A later candidate only replaces the best one so far if it's a strictly
// higher-priority tier, or a closer match within the same tier.
function better(prev: Candidate | null, next: Candidate): Candidate {
  if (!prev || next.priority > prev.priority || (next.priority === prev.priority && next.dist < prev.dist)) return next
  return prev
}

// Which handle's row sits under a pointer at (x, lane) — a point handle (a
// precise target) beats a span's body (a broad one) at the same spot.
export function hitTest(handles: Handle[], geometry: StripGeometry, x: number, lane: number): number | null {
  let best: Candidate | null = null

  for (const h of handles) {
    if (h.lane !== lane) continue
    const startX = beatToX(geometry, h.beat)
    if (h.kind === 'span' && h.end !== undefined) {
      const endX = beatToX(geometry, h.end)
      if (x >= startX - EDGE_TOLERANCE_PX && x <= endX + EDGE_TOLERANCE_PX) {
        best = better(best, { row: h.row, priority: 1, dist: Math.min(Math.abs(x - startX), Math.abs(x - endX)) })
      }
    } else if (Math.abs(x - startX) <= EDGE_TOLERANCE_PX) {
      best = better(best, { row: h.row, priority: 2, dist: Math.abs(x - startX) })
    }
  }
  return best ? best.row : null
}

// hitTest only identifies a row, not which physical Handle answered it — a row
// played by a loop event has one ghost per placement, each at its own x, and a
// drag needs the actual placement grabbed (its beat/lane) to compute dBeats
// against. Re-scans just that row's candidates; the common case (one
// placement) short-circuits without the scan.
export function resolveHandle(handles: Handle[], geometry: StripGeometry, row: number, x: number, lane: number): Handle | undefined {
  const candidates = handles.filter((h) => h.row === row && h.lane === lane)
  if (candidates.length <= 1) return candidates[0]
  let best: Handle | undefined
  let bestDist = Infinity
  for (const h of candidates) {
    const dist = Math.abs(x - beatToX(geometry, h.beat))
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
// own beat) lands exactly on the snap grid. Snapping the raw delta itself would only land on-grid when
// the handle's starting position already was.
export function snapDelta(anchor: number, dBeats: number, opts: { mode?: SnapMode } = {}): number {
  return snap(anchor + dBeats, opts) - anchor
}

export interface DragOptions {
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

// Whole-row moves only: a span's length (`dur`) is untouched by a move, so its
// window keeps the same duration wherever it lands. (Edge resize is not a
// gesture here — a cooked band's stored duration isn't the dragged row's to
// resize, and on the warp band an edge belongs to a neighbouring row.)
export function dragUpdate(handle: Handle, dBeats: number, opts: DragOptions = {}): DragResult {
  const { row, beat, pass } = handle
  // A wrapped placement's `beat` is local to its own pass (wrapPass) —
  // sourceBeatAt needs that pass back to re-derive the right extended-axis
  // point, the same `loop` argument buildTimeline's own multi-pass playback
  // uses.
  const toSource = (b: number): number => (opts.timeline?.active ? opts.timeline.sourceBeatAt(b, pass ?? 0) : b)
  return { row, values: { beat: toSource(Math.max(1, beat + dBeats)) } }
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
