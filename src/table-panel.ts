// Table-panel model — the pure half of the table + graph panel; the DOM half is
// ui/table-panel.tsx. The tab strip mixes read-only cooked *views* with user
// *editable tables* (event-sourced via EditableTableStore); an editable table's
// `name·events` history folds into its tab as a sub-tab. Log tables
// (EditableTableStore.isLog) have no fold state worth showing, so they render
// through the plain read-only path under their bare name.

import { chartDataFor, numericColumns, resolveSpec, type ChartData } from './graph-panel.js'
import type { GraphSpec } from './dsl.js'
import { outViewName, type Table } from './dsl.js'
import type { Row } from './lineage.js'
import type { EditableTableStore, ColumnType, EditableColumn } from './editable-tables.js'
import type { EditorHost, EditTarget } from './editor-host.js'

export const MAX_ROWS = 1000
export const COLUMN_TYPES: ColumnType[] = ['number', 'string', 'boolean', 'code']

// Suffix of the injected read-only edit-history views (`foo·events`). Defined
// with the store (the cook worker names histories too); re-exported here for
// the panel-side consumers that import it from this module.
import { EVENTS_SUFFIX } from './editable-tables.js'
export { EVENTS_SUFFIX }

export interface TablePanelOptions {
  // The buffer behind a code-typed (or "=") cell: the panel promotes the app's
  // one CodeMirror into a facade, overlay or mobile popover for it. main.ts
  // owns the language ladder and what committing means.
  targetFor: (table: string, rowIndex: number, col: string, value: string) => EditTarget
  // The app's single roving editor — one host per view (see editor-host.ts).
  host: EditorHost
  // Loop length in beats, for the warp map's segment compile.
  loopBeats: () => number
  // Apply: commit the promoted editor's buffer if it's dirty, otherwise re-run
  // the program so un-applied store edits (a deleted row, a scrubbed number)
  // land. The header's Apply button and Ctrl-Enter both go here.
  onApply?: () => void
  // Fired when the shown tab changes (including the initial render), so this
  // replica can announce which table it has open.
  onSelectTable?: (name: string | null) => void
}

// A collaborator's presence: their color rings the tab they have open and
// outlines their last-edited cell. lastEdit.row is the storage index the
// store's set-cell events use.
export interface PeerPresence {
  client: string
  user: string
  color: string
  table: string | null
  lastEdit: { table: string; row: number; col: string } | null
}

export interface TablePanel {
  selectTable(name: string | null): void
  // Request `name` be shown once it exists among the tabs, overriding the
  // default tab choice. Unlike selectTable (a no-op if the table isn't present
  // yet), this remembers the wish and applies it when the table appears — used
  // to restore the last-shown tab on session resume, before the cook that
  // produces cooked-view tabs has run.
  restoreTable(name: string | null): void
  setTables(newStore: Map<string, Table>): void
  setGraphs(newSpecs: GraphSpec[] | null): void
  // idx is a *beat* — the unit of rows' `beat` column and the chart's x-axis.
  highlightIndex(idx: number): void
  highlightLineage(active: Map<string, Set<number>> | null): void
  resetAutoscroll(): void
  setPresence(peers: PeerPresence[]): void
}

export function viewersOf(peers: PeerPresence[], table: string): PeerPresence[] {
  return peers.filter((p) => p.table === table)
}

// One ring per viewing peer, stacked outward, in case several share a tab.
export function tabRingStyle(peers: PeerPresence[], table: string): string {
  return viewersOf(peers, table).map((p, i) => `0 0 0 ${(i + 1) * 2}px ${p.color}`).join(', ')
}

// Every peer whose last edit landed on this cell — two peers can share one,
// so this returns all of them.
export function lastEditors(peers: PeerPresence[], table: string, row: number, col: string): PeerPresence[] {
  return peers.filter((p) => p.lastEdit && p.lastEdit.table === table && p.lastEdit.row === row && p.lastEdit.col === col)
}

export function formatCell(col: string, value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'function') return value.name ? `ƒ ${value.name}` : 'ƒ'
  if (col === 'color' && typeof value === 'number') {
    return '0x' + value.toString(16).padStart(6, '0')
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(3)
  }
  if (typeof value === 'object') return previewJSON(value, 120)
  return String(value)
}

// A size-capped JSON preview: cells can carry megabyte objects (the compiled
// fold program rides every scene row), and a full stringify per rendered cell
// would freeze the panel.
function previewJSON(v: unknown, budget: number): string {
  if (typeof v === 'function') return 'ƒ'
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? String(v)
  const arr = Array.isArray(v)
  const parts: string[] = []
  for (const [k, x] of arr ? (v as unknown[]).entries() : Object.entries(v)) {
    if (budget <= 0) {
      parts.push('…')
      break
    }
    const piece = (arr ? '' : `${k}:`) + previewJSON(x, budget - 8)
    budget -= piece.length
    parts.push(piece)
  }
  return arr ? `[${parts.join(',')}]` : `{${parts.join(',')}}`
}

// A cell is "inert" when its column only has effect for certain events
// (col.usedBy) and the row's own discriminant — `event` if the table has one,
// else `type` — says otherwise; the panel dims it (still fully editable, see
// EditableCell in ui/table-panel.tsx). A blank/unknown discriminant, or a
// column with no usedBy (every user-added column included), is always live.
export function isCellInert(row: Row, col: EditableColumn, columns: EditableColumn[]): boolean {
  if (!col.usedBy) return false
  const discCol = columns.some((c) => c.name === 'event') ? 'event' : columns.some((c) => c.name === 'type') ? 'type' : null
  if (!discCol) return false
  const disc = row[discCol]
  return typeof disc === 'string' && disc !== '' && !col.usedBy.includes(disc)
}

export function formatEditableCell(type: ColumnType, value: unknown): string {
  if (value == null) return ''
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'number') {
    // An "=" expression cell is self-describing formula text.
    if (typeof value === 'string' && value.startsWith('=')) return value
    const n = Number(value)
    if (!Number.isFinite(n)) return ''
    return Number.isInteger(n) ? String(n) : n.toFixed(3)
  }
  return String(value)
}

// The tab strip's names: every cooked view plus every editable table; an
// editable table's `name·events` history folds into its own tab, not a
// top-level one.
export function allNames(views: Map<string, Table>, editableStore: EditableTableStore): string[] {
  const names: string[] = []
  for (const n of views.keys()) {
    if (n.endsWith(EVENTS_SUFFIX)) {
      const base = n.slice(0, -EVENTS_SUFFIX.length)
      if (editableStore.has(base)) {
        if (!names.includes(base)) names.push(base)
        continue
      }
    }
    if (!names.includes(n)) names.push(n)
  }
  for (const n of editableStore.listNames()) if (!names.includes(n)) names.push(n)
  return names
}

export function nextTableName(views: Map<string, Table>, editableStore: EditableTableStore): string {
  let i = 1
  while (views.has(`table${i}`) || editableStore.has(`table${i}`)) i++
  return `table${i}`
}

// Keep the current tab if it still exists, else prefer the scene event table
// ("three", or its legacy name "events"), else the last.
export function fallbackTab(names: string[], current: string | null): string | null {
  if (!names.length) return null
  if (current != null && names.includes(current)) return current
  for (const n of [outViewName('three'), 'three', 'events']) if (names.includes(n)) return n
  return names[names.length - 1]
}

// An explicit .graph() spec wins; otherwise data views auto-chart their numeric
// columns. Event-history, `code`, and log tables never auto-chart — their
// numeric seq/t columns aren't data to plot.
export function chartFor(
  name: string | null,
  views: Map<string, Table>,
  graphByName: Map<string, GraphSpec>,
  editableStore: EditableTableStore,
): ChartData | null {
  if (!name) return null
  let spec = graphByName.get(name)
  // slider/midi are flat per-id logs: numericColumns would merge every
  // id's column into one meaningless line, now that the sectioned timeline
  // pane shows the same data correctly grouped by id (pivotChannels).
  if (!spec && !name.endsWith(EVENTS_SUFFIX) && name !== 'code' && name !== 'slider' && name !== 'midi' && !editableStore.isLog(name)) {
    const t = views.get(name)
    // A timeline-schema view (an .outTimeline() result is cooked-only, so the
    // editableStore branch above never sees it) already gets the dedicated
    // warp map below the grid — merging its beats, offsets and rates into one
    // generic line on top of that is the same duplicate-visualization the
    // slider/midi exclusion prevents.
    if (t && t.rows.length && !isTimelineSchema(t.columns)) {
      const numericCols = numericColumns(t.rows, t.columns)
      if (numericCols.length) spec = { table: t, columns: numericCols, viewName: name }
    }
  }
  if (!spec) return null
  const { rows, cols } = resolveSpec(spec)
  return chartDataFor(rows, spec.table.columns, cols, name)
}

// A table with a code-typed column renders as the editor list (one card per
// row: its non-code cells columnar, its code editor underneath) instead of the
// grid. Shared with RowInfo's per-row trigger (today a hardcoded
// bauble/post/hydra ternary) so the two tests can't drift apart.
export function hasCodeColumn(columns: EditableColumn[]): boolean {
  return columns.some((c) => c.type === 'code')
}

// Whether a card shows an editor for this code cell: text always does, and an
// empty one only when its column is live for the row's event — that's where
// code goes (an empty setCode row), while a pulse row's empty code cell would
// just be a box nobody can fill.
export function showsCodeEditor(row: Row, col: EditableColumn, columns: EditableColumn[]): boolean {
  const v = row[col.name]
  return (v != null && String(v) !== '') || !isCellInert(row, col, columns)
}

// Column names schemas.timeline declares (dsl.ts) — checked by name, not by a
// literal table name, since a timeline warp can be authored under any name
// (only .retime()'s argument or the "timeline" convention name it).
const TIMELINE_SCHEMA_COLS = ['beat', 'event', 'from', 'to', 'outFrom', 'outTo', 'rate', 'loop']

function isTimelineSchema(columnNames: string[]): boolean {
  const set = new Set(columnNames)
  return TIMELINE_SCHEMA_COLS.every((c) => set.has(c))
}

// The table pane's bottom slot, below the grid: a timeline-schema table gets a
// passive warp map (timelineSegments -> drawSeriesChart); anything else,
// nothing. 'slider'/'midi' are panel-only synthetic views spliced in by
// tablesForDisplay (main.ts), never real editableStore tables.
export function showsWarpMap(
  name: string | null,
  views: Map<string, Table>,
  editableStore: EditableTableStore,
): boolean {
  if (!name || name === 'slider' || name === 'midi') return false
  const data = editableStore.get(name)
  const columnNames = data ? data.columns.map((c) => c.name) : (views.get(name)?.columns ?? [])
  return isTimelineSchema(columnNames)
}

// Display order only: sorted by `beat` (stable) when the table has one. The
// returned values are always real storage indices — never display positions —
// so row edits are unaffected by sorting.
export function displayOrder(rows: Row[], columns: EditableColumn[]): number[] {
  const order = rows.map((_row, i) => i)
  if (columns.some((c) => c.name === 'beat')) {
    order.sort((a, b) => (Number(rows[a].beat) || 0) - (Number(rows[b].beat) || 0))
  }
  return order
}

// Keyboard-focus a single editable cell, keyed by storage row index + column
// name. Navigation moves through the *displayed* rows (`order`, from
// displayOrder, already filtered to the visible ones) so up/down follow what
// the eye sees, while left/right walk the column list.
export interface CellFocus {
  row: number
  col: string
}

export type FocusDir = 'up' | 'down' | 'left' | 'right'

// The cell an arrow-key press moves to, or null when the move would leave the
// grid (the caller then keeps the current focus). `order` is the visible rows'
// storage indices in display order.
export function moveFocus(
  order: number[],
  columns: EditableColumn[],
  focus: CellFocus,
  dir: FocusDir,
): CellFocus | null {
  const pos = order.indexOf(focus.row)
  const cIdx = columns.findIndex((c) => c.name === focus.col)
  if (pos < 0 || cIdx < 0) return null
  if (dir === 'up' || dir === 'down') {
    const nextPos = pos + (dir === 'down' ? 1 : -1)
    if (nextPos < 0 || nextPos >= order.length) return null
    return { row: order[nextPos], col: focus.col }
  }
  const nextIdx = cIdx + (dir === 'right' ? 1 : -1)
  if (nextIdx < 0 || nextIdx >= columns.length) return null
  return { row: focus.row, col: columns[nextIdx].name }
}

// The last row whose `indexCol` value is at or before the playhead beat `idx`
// (-1 when the playhead sits before every row).
export function activeRowIndex(rows: Row[], indexCol: string, idx: number): number {
  let activeIdx = -1
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][indexCol] as number) <= idx) activeIdx = i
    else break
  }
  return activeIdx
}
