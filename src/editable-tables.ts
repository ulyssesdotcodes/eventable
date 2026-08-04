// Event-sourced user tables: what's stored is never a table but an
// append-only log of change events; the visible table is a fold of them.
// Every table — including the program itself, stored as a table named
// "code" — rides ONE shared log, and that log is the unit a session
// persists and multiplayer syncs.

import { compareEvents, createEventLog, eventKey, type EventLog, type EventMigration, type StampedEvent } from './event-log.js'
import { buildBranchTree, branchEvents, APPLY_KIND, type ApplyNode, type BranchTree } from './branches.js'
import { postVarDecls } from './post-lang.js'
import type { Row } from './lineage.js'

// The pseudo-table Apply pulses, peer-join/leave and session markers ride.
export const ACTIVITY_TABLE = 'activity'

// Suffix of a table's read-only edit-history view (`foo·events`) — the name
// its log wears in the panel and the table() name a program reads it under.
// Lives here (table-panel.ts re-exports it) so the cook worker can name
// histories without pulling in panel code.
export const EVENTS_SUFFIX = '·events'

// 'a' prefix keeps apply ids distinguishable from replica ids in log dumps.
function mintApplyId(): string {
  return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export type ColumnType = 'number' | 'string' | 'boolean' | 'code' | 'enum'

// Language of a 'code' column's cells. 'dsl'/'hydra'/'post'/'expr' are JS and
// get language service support (each with its own ambient surface — 'expr' is
// the "=" cell surface of bare sources and math fns); 'bauble' is Janet, so
// the editor opens those cells with the service off (see editor-support.ts)
// rather than offering JS completions on lisp.
export type CodeLanguage = 'dsl' | 'hydra' | 'bauble' | 'post' | 'expr'

// A column spec as passed to editable(name, schema). A string array is
// shorthand for an enum over those values; enum columns are code-only — the
// "+ column" UI never creates one. `usedBy` names the event/type values (the
// row's `event` or `type` column) the column has effect for — omit it for a
// column that's always live (see EditableColumn.usedBy).
export type ColumnSpec =
  | ColumnType
  | readonly string[]
  | { type: ColumnType; options?: readonly string[]; language?: CodeLanguage; usedBy?: readonly string[] }
export type Schema = Record<string, ColumnSpec>

/**
 * The session bookmark recorded on Apply. `at` is the log length then —
 * refolding that prefix reconstructs every table's state. `tables` (per-table
 * event counts) is kept for display/serialization; replay uses `at`, which
 * stays correct across renames/removes.
 */
export interface SessionRun {
  at: number
  tables: Record<string, number>
}

const tableEventCounts = (tables: Map<string, TableState>): Record<string, number> =>
  Object.fromEntries([...tables].map(([name, t]) => [name, t.events.length]))

// "Clear" marker on the activity table — a marker, not a deletion: history is
// untouched, but deriveRunsFromCode() won't resurrect runs from before it.
export const CLEAR_RUNS_KIND = 'clear-runs'

export interface EditableColumn {
  name: string
  type: ColumnType
  options?: string[] // 'enum' columns: the allowed values
  language?: CodeLanguage // 'code' columns; absent means the DSL
  // Event/type values the column has effect for (row discriminant: `event` if
  // the table has one, else `type`) — the table panel dims cells whose row's
  // discriminant isn't in it (see isCellInert in table-panel.ts). Absent means
  // universal: always live. Every user-added column is universal.
  usedBy?: readonly string[]
}

export interface EditableTableData {
  columns: EditableColumn[]
  rows: Row[]
  events: Row[] // edit history, as display rows for the read-only `name·events` table
}

// Line-mute switch: a row with `disabled` checked is hidden from the program
// (ensure()'s return) but stays in the table for re-enabling. Deliberately an
// ordinary column, not provenance, so it rides every existing mechanism for free.
export const DISABLED_COL = 'disabled'

function visibleRows(t: TableState): Row[] {
  return t.rows.filter((r) => r[DISABLED_COL] !== true)
}

export function defaultFor(type: ColumnType, options?: string[]): unknown {
  switch (type) {
    case 'number': return 0
    case 'boolean': return false
    case 'enum': return options?.[0] ?? ''
    default: return ''
  }
}

/** A cell holding expression text — "=slider('h').mul(2)" — evaluated by the cook (see expr-cell.ts). */
export const isExprCellText = (v: unknown): v is string => typeof v === 'string' && v.startsWith('=')

// The "=" cell checker is injected, not imported: this module deliberately
// stays off the DSL's import graph (see SLIDERS_COLUMNS), and expr-cell.ts
// registers on load. Unregistered, an "=" string stays what it always was — a
// wrong-typed value in a number column.
export interface ExprCellCheck {
  valid: boolean
  streaming: boolean
}
let exprCellCheck: ((text: string) => ExprCellCheck) | null = null
export function registerExprCellCheck(fn: (text: string) => ExprCellCheck): void {
  exprCellCheck = fn
}

// Streaming results are invalid here: a { $expr } binding in these columns
// would NaN rasterize's frame math and silently drop rows from the timeline
// strip. A constant expression is a plain number by cook time, so it passes.
const TIMING_COLUMNS = new Set(['beat', 'dur', 'loop'])

// hydra/bauble events whose fold splices a plain string into the number-typed
// `value` column (replace's substitute text; bauble's tile/slice/combine/
// duplicate params) — legitimate there, unlike e.g. radial, whose fold is
// number-only.
const STRING_VALUE_EVENTS = new Set(['replace', 'tile', 'slice', 'combine', 'duplicate'])

/**
 * Blank/unset cells always pass: event tables are deliberately sparse, so only
 * a non-blank wrong-typed value (or an enum value outside its options) is
 * worth flagging. In number columns an "=" expression cell is valid when it
 * compiles and evaluates to an Expr or a number — except streaming results in
 * timing columns (see TIMING_COLUMNS). `event` is the row's own event/type
 * value, for the handful of events that legitimately hold a string in `value`
 * (see STRING_VALUE_EVENTS); omit it where no row is at hand.
 */
export function cellValid(value: unknown, col: EditableColumn, event?: string): boolean {
  if (value === '' || value == null) return true
  switch (col.type) {
    case 'number': {
      if (isExprCellText(value)) {
        const check = exprCellCheck?.(value)
        if (!check?.valid) return false
        return !(check.streaming && TIMING_COLUMNS.has(col.name))
      }
      if (typeof value === 'number' && Number.isFinite(value)) return true
      return col.name === 'value' && typeof value === 'string' && event != null && STRING_VALUE_EVENTS.has(event)
    }
    case 'boolean': return typeof value === 'boolean'
    case 'enum': return typeof value === 'string' && !!col.options?.includes(value)
    default: return true
  }
}

export function invalidColumns(row: Row, columns: EditableColumn[]): string[] {
  const event = typeof row.event === 'string' ? row.event : typeof row.type === 'string' ? row.type : undefined
  const bad = columns.filter((c) => !cellValid(row[c.name], c, event)).map((c) => c.name)
  const flag = (name: string): void => {
    if (columns.some((c) => c.name === name) && !bad.includes(name)) bad.push(name)
  }
  // Row-level rules single cells can't express: replace events splice
  // String(row.value) into sketch code (hydra.ts/bauble.ts), and a color
  // pulse (dur set) bit-mixes its value — neither can hold an expression.
  if (row.event === 'replace' && isExprCellText(row.value)) flag('value')
  if (isExprCellText(row.color) && ((typeof row.dur === 'number' && row.dur > 0) || isExprCellText(row.dur))) flag('color')
  return bad
}

// Per-row provenance, parallel to `rows`. code: originated from a program seed;
// dirty: user-edited or user-added, so a re-seed must NOT overwrite it; slot:
// index in the seed list — the identity a re-seed aligns to (-1 for user rows).
// varName: derived from a val() call in the nearest code row above — owned by
// that call: the row is deleted when the call is, even if edited.
interface RowMeta {
  code: boolean
  dirty: boolean
  slot: number
  varName?: string
}

const userMeta = (): RowMeta => ({ code: false, dirty: true, slot: -1 })
const seedMeta = (slot: number): RowMeta => ({ code: true, dirty: false, slot })

// One table's folded state. Columns aren't stored as one list — see
// effectiveColumns() — so a column's provenance (program-declared vs.
// user-touched) survives the fold.
interface TableState {
  // Columns from genuine table-panel actions (touching a declared column
  // "claims" it). Never mutated by a program's editable() call.
  userColumns: EditableColumn[]
  // Removed via the table panel — excluded even if still declared, so a
  // removal sticks across the program's next Apply.
  removedColumns: Set<string>
  // Most recently declared schema; null when no program ever declared one.
  declared: EditableColumn[] | null
  rows: Row[]
  rowMeta: RowMeta[]
  events: Row[]
  // Created by a program editable() declaration. Only such tables get
  // re-seeded and pruned by retainDeclared — a user's "+ table" never is.
  codeCreated: boolean
  // The last seed verbatim — the diff baseline so an unchanged seed appends
  // nothing (like an unchanged schema). null until a program has seeded.
  lastSeed: Row[] | null
  // Seed slots whose code row the user deleted — tombstoned so a re-seed
  // doesn't bring the row back.
  removedSlots: Set<number>
  // A pure record() event stream — no rows/columns of its own; the table
  // panel shows it read-only instead of offering row/column editing.
  log: boolean
}

// Declared supplies the columns and their order, but a userColumns entry for
// the same name wins (an explicit user edit beats what the program says);
// user-only columns are appended after.
function mergeColumns(userColumns: EditableColumn[], declared: EditableColumn[]): EditableColumn[] {
  const userByName = new Map(userColumns.map((c) => [c.name, c]))
  const declaredNames = new Set(declared.map((c) => c.name))
  const merged = declared.map((c) => userByName.get(c.name) ?? c)
  for (const c of userColumns) if (!declaredNames.has(c.name)) merged.push(c)
  return merged
}

// The one place a table's current columns are computed — there is no stored
// `columns` field anywhere else.
function effectiveColumns(t: TableState): EditableColumn[] {
  const cols = t.declared ? mergeColumns(t.userColumns, t.declared) : t.userColumns
  return t.removedColumns.size ? cols.filter((c) => !t.removedColumns.has(c.name)) : cols
}

// Display form of an event: the table name is implicit in which events-table
// it appears in, so it's dropped.
function eventRow(e: StampedEvent): Row {
  const { table: _table, ...rest } = e
  return rest
}

/**
 * Rebuild a row to match `columns`, keeping matching data, defaulting the
 * rest. Exported for the cook worker (see cook-service.ts).
 */
export function conformRow(row: Row, columns: EditableColumn[]): Row {
  const next: Row = {}
  for (const c of columns) next[c.name] = c.name in row ? row[c.name] : defaultFor(c.type, c.options)
  return next
}

// A create/declare-schema event's `columns`, tolerant of legacy shapes (older
// sessions stored the raw schema object, not the column array). Anything else
// reads as no columns, so a session's table data always loads.
function eventColumns(raw: unknown): EditableColumn[] {
  if (Array.isArray(raw)) return raw.map((c) => ({ ...(c as EditableColumn) }))
  if (raw && typeof raw === 'object') return schemaColumns(raw as Schema)
  return []
}

// A malformed or legacy `rows` field must never throw the fold that loads
// the rest of the session.
function eventRows(raw: unknown): Row[] {
  return Array.isArray(raw) ? (raw as Row[]) : []
}

/** Normalize an editable() schema into the column-list form events carry. */
export function schemaColumns(schema: Schema): EditableColumn[] {
  return Object.entries(schema).map(([name, spec]) => {
    if (Array.isArray(spec)) return { name, type: 'enum', options: [...spec] }
    if (typeof spec === 'object') {
      const s = spec as { type: ColumnType; options?: readonly string[]; language?: CodeLanguage; usedBy?: readonly string[] }
      return {
        name,
        type: s.type,
        ...(s.options ? { options: [...s.options] } : {}),
        ...(s.language && s.type === 'code' ? { language: s.language } : {}),
        ...(s.usedBy ? { usedBy: [...s.usedBy] } : {}),
      }
    }
    return { name, type: spec as ColumnType }
  })
}

// The "sliders" definition table a define-slider event targets. Columns mirror
// schemas.sliders in dsl.ts (kept local so this module stays off the DSL's
// import graph).
const SLIDERS_TABLE = 'sliders'
const DEFINE_SLIDER_KIND = 'define-slider'
const SLIDERS_COLUMNS: EditableColumn[] = schemaColumns({
  name: 'string', min: 'number', max: 'number', default: 'number', disabled: 'boolean',
})

// ── Serialized-schema migrations ─────────────────────────────────────────────
// Append here — never edit or reorder — when the persisted event shape changes
// (see EventMigration); the fold only ever sees current-shape events.

// v1 → v2: create/declare-schema `columns` used to be the raw schema object
// ({ name: type }); normalize to the column array the fold reads.
function migrateColumnsToArray(events: StampedEvent[]): StampedEvent[] {
  return events.map((e) => {
    if (e.kind !== 'create' && e.kind !== 'declare-schema') return e
    const cols = e.columns
    if (!cols || Array.isArray(cols) || typeof cols !== 'object') return e
    return { ...e, columns: schemaColumns(cols as Schema) }
  })
}

// v2 → v3: the post view's event names changed — 'chain' → 'setCode', 'set' →
// 'setVariable'. Post tables are recognized by an `event` enum whose options
// include 'chain' (unique to the post schema) and followed through renames,
// so particles tables (whose enum also has 'set') are left alone. Rewrites
// the enum options plus every persisted place a row's `event` value lives.
function migratePostEventNames(events: StampedEvent[]): StampedEvent[] {
  const rename = (v: unknown): unknown => (v === 'chain' ? 'setCode' : v === 'set' ? 'setVariable' : v)
  const renameRows = (raw: unknown): unknown =>
    Array.isArray(raw) ? raw.map((r) => (r && typeof r === 'object' ? { ...r, event: rename((r as Row).event) } : r)) : raw
  const isPostEventCol = (c: unknown): c is EditableColumn =>
    !!c && (c as EditableColumn).name === 'event' && ((c as EditableColumn).options?.includes('chain') ?? false)
  const post = new Set<string>()
  return events.map((e) => {
    const table = typeof e.table === 'string' ? e.table : ''
    if (e.kind === 'create' || e.kind === 'declare-schema') {
      const cols = e.columns
      if (!Array.isArray(cols) || !cols.some(isPostEventCol)) {
        if (e.kind === 'declare-schema') post.delete(table)
        return e
      }
      post.add(table)
      return {
        ...e,
        columns: cols.map((c) => (isPostEventCol(c) ? { ...c, options: c.options!.map((o) => rename(o) as string) } : c)),
        ...(Array.isArray(e.rows) ? { rows: renameRows(e.rows) } : {}),
      }
    }
    if (!post.has(table)) return e
    switch (e.kind) {
      case 'rename-table':
        post.delete(table)
        if (typeof e.to === 'string') post.add(e.to)
        return e
      case 'remove-table':
        post.delete(table)
        return e
      case 'seed-rows':
        return { ...e, rows: renameRows(e.rows) }
      case 'set-cell':
        return e.col === 'event' ? { ...e, value: rename(e.value) } : e
      case 'set-row': {
        const values = e.values
        return values && typeof values === 'object' && 'event' in values
          ? { ...e, values: { ...(values as Row), event: rename((values as Row).event) } }
          : e
      }
      default:
        return e
    }
  })
}

// v3 → v4: the column-naming unification. Four tables each kept a legacy name
// for a field every other table spells the common way. Rename each, scoped to
// the tables shaped like the schema it targets (recognized by a create/
// declare-schema's columns — or, for sliders, a define-slider event) and
// followed through rename-table:
//   origami   `at`  time column  → `beat`
//   scene     `type` discriminant → `event` (+ the 'color' event rasterize folds)
//   particles `set`  event value  → `setVariable`
//   sliders   `id`   name column  → `name`
// The define-slider fold already reads its wire `id` into the `name` column, so
// those events pass through untouched; only the sliders table's create/seed/edit
// events carry the old column name. Runs after migratePostEventNames, so a
// post table's own `set`→`setVariable` is already done and particles (whose
// enum has the unique `spawn`) is the only remaining `set`.
type RenameKind = 'origami' | 'scene' | 'particles' | 'sliders'

// The column whose NAME changes (particles renames a VALUE, not a column).
const RENAMED_COLUMN: Partial<Record<RenameKind, readonly [from: string, to: string]>> = {
  origami: ['at', 'beat'], scene: ['type', 'event'], sliders: ['id', 'name'],
}

function classifyColumns(cols: EditableColumn[]): RenameKind | null {
  const has = (n: string): EditableColumn | undefined => cols.find((c) => c.name === n)
  if (has('at') && (has('step') || has('p1') || has('move'))) return 'origami'
  const type = has('type')
  if (type?.options && ['create', 'update', 'destroy'].every((o) => type.options!.includes(o))) return 'scene'
  const event = has('event')
  if (event?.options?.includes('spawn') && event.options.includes('set')) return 'particles'
  if (has('id') && has('min') && has('max') && has('default')) return 'sliders'
  return null
}

function renameKey(row: unknown, from: string, to: string): unknown {
  if (!row || typeof row !== 'object' || !(from in row)) return row
  const { [from]: v, ...rest } = row as Row
  return { ...rest, [to]: v }
}

function migrateColumnNaming(events: StampedEvent[]): StampedEvent[] {
  const kinds = new Map<string, RenameKind>()
  const migrateCols = (cols: EditableColumn[], kind: RenameKind): EditableColumn[] => cols.map((c) => {
    const ren = RENAMED_COLUMN[kind]
    if (ren && c.name === ren[0]) {
      const next: EditableColumn = { ...c, name: ren[1] }
      // scene: surface the 'color' event rasterize already folds
      return kind === 'scene' && next.options && !next.options.includes('color')
        ? { ...next, options: next.options.flatMap((o) => (o === 'destroy' ? ['color', 'destroy'] : [o])) }
        : next
    }
    return kind === 'particles' && c.name === 'event' && c.options
      ? { ...c, options: c.options.map((o) => (o === 'set' ? 'setVariable' : o)) }
      : c
  })
  const migrateRow = (row: unknown, kind: RenameKind): unknown => {
    const ren = RENAMED_COLUMN[kind]
    const r = ren ? renameKey(row, ren[0], ren[1]) : row
    return kind === 'particles' && r && typeof r === 'object' && (r as Row).event === 'set'
      ? { ...(r as Row), event: 'setVariable' }
      : r
  }
  return events.map((e) => {
    const table = typeof e.table === 'string' ? e.table : ''
    if (e.kind === 'define-slider') { kinds.set(table, 'sliders'); return e }
    if (e.kind === 'create' || e.kind === 'declare-schema') {
      const cols = e.columns
      const kind = Array.isArray(cols) ? classifyColumns(cols as EditableColumn[]) : null
      if (!kind) { if (e.kind === 'declare-schema') kinds.delete(table); return e }
      kinds.set(table, kind)
      return {
        ...e,
        columns: migrateCols(cols as EditableColumn[], kind),
        ...(Array.isArray(e.rows) ? { rows: e.rows.map((r) => migrateRow(r, kind)) } : {}),
      }
    }
    const kind = kinds.get(table)
    if (!kind) return e
    const ren = RENAMED_COLUMN[kind]
    switch (e.kind) {
      case 'rename-table':
        kinds.delete(table)
        if (typeof e.to === 'string') kinds.set(e.to, kind)
        return e
      case 'remove-table':
        kinds.delete(table)
        return e
      case 'seed-rows':
        return Array.isArray(e.rows) ? { ...e, rows: e.rows.map((r) => migrateRow(r, kind)) } : e
      case 'set-cell':
        if (kind === 'particles') return e.col === 'event' && e.value === 'set' ? { ...e, value: 'setVariable' } : e
        return ren && e.col === ren[0] ? { ...e, col: ren[1] } : e
      case 'set-row':
        return { ...e, values: migrateRow(e.values, kind) }
      case 'rename-column': {
        if (!ren) return e
        const col = e.col === ren[0] ? ren[1] : e.col
        const to = e.to === ren[0] ? ren[1] : e.to
        return col === e.col && to === e.to ? e : { ...e, col, to }
      }
      default:
        return e
    }
  })
}

const EDITABLE_MIGRATIONS: EventMigration[] = [migrateColumnsToArray, migratePostEventNames, migrateColumnNaming]

// Re-drive a code-created table's rows from a fresh seed: a pristine code row
// (code && !dirty) takes the new seed value at its slot; a dirty row stays as-is.
// Alignment is by slot, not position, so user-added rows interleaved among the
// seed don't drag values out of step, and a deleted slot stays deleted.
function reseedRows(t: TableState, seed: Row[]): void {
  const cols = effectiveColumns(t)
  const nextRows: Row[] = []
  const nextMeta: RowMeta[] = []
  const consumed = new Set<number>()
  for (let i = 0; i < t.rows.length; i++) {
    const meta = t.rowMeta[i]
    if (!meta.code) {
      nextRows.push(t.rows[i])
      nextMeta.push(meta)
      continue
    }
    consumed.add(meta.slot)
    if (meta.dirty) {
      nextRows.push(t.rows[i])
      nextMeta.push(meta)
    } else if (meta.slot < seed.length) {
      nextRows.push(conformRow(seed[meta.slot], cols))
      nextMeta.push(seedMeta(meta.slot))
    }
    // else: a pristine code row whose slot the shrunk seed no longer covers — dropped.
  }
  // Append new (non-tombstoned) seed slots as fresh code rows.
  for (let slot = 0; slot < seed.length; slot++) {
    if (consumed.has(slot) || t.removedSlots.has(slot)) continue
    nextRows.push(conformRow(seed[slot], cols))
    nextMeta.push(seedMeta(slot))
  }
  t.rows = nextRows
  t.rowMeta = nextMeta
}

// ── val() rows: post code cells materialize their variables ──────────────────
// A post-language code cell's val("name", value) calls own the "setVariable" rows
// immediately after it: created with the declared value (at the cell's beat),
// value-tracked while pristine, kept through user edits, and deleted — edited
// or not — when the call is deleted. Pure fold logic keyed on the events that
// change code, so every replica and replay derives the same rows.

function reconcileVarRows(t: TableState, i: number): void {
  const cols = effectiveColumns(t)
  const codeCol = cols.find((c) => c.name === 'code')
  if (codeCol?.language !== 'post') return
  const row = t.rows[i]
  if (!row || t.rowMeta[i].varName != null) return
  const decls = postVarDecls(typeof row.code === 'string' ? row.code : '')
  let end = i + 1
  while (end < t.rows.length && t.rowMeta[end].varName != null) end++
  const existing = new Map<string, number>()
  for (let k = i + 1; k < end; k++) existing.set(t.rowMeta[k].varName!, k)
  const nextRows: Row[] = []
  const nextMeta: RowMeta[] = []
  for (const d of decls) {
    const at = existing.get(d.name)
    if (at !== undefined) {
      if (!t.rowMeta[at].dirty) t.rows[at].value = d.value
      nextRows.push(t.rows[at])
      nextMeta.push(t.rowMeta[at])
    } else {
      const beat = typeof row.beat === 'number' ? row.beat : 1
      nextRows.push(conformRow({ beat, event: 'setVariable', name: d.name, value: d.value }, cols))
      nextMeta.push({ code: false, dirty: false, slot: -1, varName: d.name })
    }
  }
  t.rows.splice(i + 1, end - (i + 1), ...nextRows)
  t.rowMeta.splice(i + 1, end - (i + 1), ...nextMeta)
}

// Reconcile every code row — for the whole-table events (create, seed-rows,
// declare-schema). Derived rows reconcile is skipped over as it goes.
function deriveVarRows(t: TableState): void {
  for (let i = 0; i < t.rows.length; i++) {
    if (t.rowMeta[i].varName == null) reconcileVarRows(t, i)
  }
}

// Defensive (events may come from storage): unknown tables/columns/rows are
// ignored rather than thrown.
function applyEvent(tables: Map<string, TableState>, e: StampedEvent): void {
  const name = e.table as string
  if (e.kind === 'create') {
    if (tables.has(name)) return
    const columns = eventColumns(e.columns)
    // A DSL-originated create seeds `declared`; a table-panel create seeds
    // `userColumns` directly — no program declares it.
    const declared = e.declared === true ? columns : null
    const seed = eventRows(e.rows)
    const t: TableState = {
      userColumns: declared ? [] : columns, removedColumns: new Set(), declared,
      rows: [], rowMeta: [], events: [eventRow(e)], log: e.log === true,
      codeCreated: e.declared === true, lastSeed: e.declared === true ? seed.map((r) => ({ ...r })) : null,
      removedSlots: new Set(),
    }
    t.rows = seed.map((r) => conformRow(r, effectiveColumns(t)))
    t.rowMeta = seed.map((_r, i) => (t.codeCreated ? seedMeta(i) : userMeta()))
    tables.set(name, t)
    deriveVarRows(t)
    return
  }
  // A code-declared slider (expr.slider / a post cell's slider()): ensure the
  // definitions table exists and upsert the row keyed by name — the fold keeps
  // one row per name however many declarations (reruns, peers, several code
  // sites) land, and the last declaration in log order wins its range. The wire
  // event still carries the name as `id`; the folded column is `name`.
  if (e.kind === DEFINE_SLIDER_KIND) {
    const id = e.id != null ? String(e.id) : ''
    if (!id) return
    let t = tables.get(name)
    if (!t) {
      t = {
        userColumns: SLIDERS_COLUMNS.map((c) => ({ ...c })), removedColumns: new Set(),
        declared: null, rows: [], rowMeta: [], events: [], codeCreated: false,
        lastSeed: null, removedSlots: new Set(), log: false,
      }
      tables.set(name, t)
    }
    t.events.push(eventRow(e))
    const min = typeof e.min === 'number' ? e.min : 0
    const max = typeof e.max === 'number' ? e.max : 1
    const i = t.rows.findIndex((r) => r.name === id)
    if (i >= 0) {
      // Only the declared range — default/disabled and any extra columns are
      // the row's own state.
      t.rows[i].min = min
      t.rows[i].max = max
      t.rowMeta[i].dirty = true
    } else {
      t.rows.push(conformRow({ name: id, min, max, default: min }, effectiveColumns(t)))
      t.rowMeta.push(userMeta())
    }
    return
  }
  const t = tables.get(name)
  if (!t) return
  t.events.push(eventRow(e))
  switch (e.kind) {
    case 'declare-schema': {
      t.declared = eventColumns(e.columns)
      t.rows = t.rows.map((r) => conformRow(r, effectiveColumns(t)))
      deriveVarRows(t)
      break
    }
    case 'seed-rows': {
      const seed = eventRows(e.rows)
      t.lastSeed = seed.map((r) => ({ ...r }))
      reseedRows(t, seed)
      deriveVarRows(t)
      break
    }
    case 'replace-table': {
      const columns = eventColumns(e.columns)
      // Wholesale replacement, so the pasted shape wins outright: it claims
      // every column (a declared one the paste dropped is removed, as if by
      // hand) and its rows are the user's, tombstoning the seed slots they
      // displace exactly as deleting those rows would.
      for (const meta of t.rowMeta) if (meta.code) t.removedSlots.add(meta.slot)
      t.userColumns = columns
      t.removedColumns = new Set((t.declared ?? []).map((c) => c.name).filter((n) => !columns.some((c) => c.name === n)))
      const cols = effectiveColumns(t)
      t.rows = eventRows(e.rows).map((r) => conformRow(r, cols))
      t.rowMeta = t.rows.map(() => userMeta())
      deriveVarRows(t)
      break
    }
    case 'add-column': {
      const col = e.col as string
      if (!col || effectiveColumns(t).some((c) => c.name === col)) break
      t.userColumns.push({ name: col, type: e.type as ColumnType })
      t.removedColumns.delete(col)
      t.rows = t.rows.map((r) => conformRow(r, effectiveColumns(t)))
      break
    }
    case 'remove-column': {
      const col = e.col as string
      t.userColumns = t.userColumns.filter((c) => c.name !== col)
      t.removedColumns.add(col)
      t.rows = t.rows.map((r) => conformRow(r, effectiveColumns(t)))
      break
    }
    case 'rename-column': {
      const col = e.col as string, to = e.to as string
      const before = effectiveColumns(t)
      const existing = before.find((c) => c.name === col)
      if (!existing || !to || before.some((c) => c.name === to)) break
      const owned = t.userColumns.find((c) => c.name === col)
      if (owned) owned.name = to
      // Renaming a declared-only column "claims" it (whole column, so options/
      // language survive); the old declared name may reappear as a fresh column.
      else t.userColumns.push({ ...existing, name: to })
      t.rows.forEach((r) => { r[to] = r[col]; delete r[col] })
      t.rows = t.rows.map((r) => conformRow(r, effectiveColumns(t)))
      break
    }
    case 'set-column-type': {
      const col = e.col as string, type = e.type as ColumnType
      const owned = t.userColumns.find((c) => c.name === col)
      if (owned) owned.type = type
      // Retyping a declared-only column "claims" it, same as a rename above.
      else if (effectiveColumns(t).some((c) => c.name === col)) t.userColumns.push({ name: col, type })
      break
    }
    case 'add-row': {
      const row: Row = {}
      for (const c of effectiveColumns(t)) row[c.name] = defaultFor(c.type, c.options)
      t.rows.push(row)
      t.rowMeta.push(userMeta())
      break
    }
    case 'remove-row': {
      const i = e.row as number
      if (i >= 0 && i < t.rows.length) {
        // Tombstone a code row's slot so a later re-seed doesn't resurrect it.
        const meta = t.rowMeta[i]
        if (meta.code) t.removedSlots.add(meta.slot)
        t.rows.splice(i, 1)
        t.rowMeta.splice(i, 1)
        // A removed code row takes its val()-derived rows with it.
        if (meta.varName == null) {
          while (i < t.rows.length && t.rowMeta[i].varName != null) {
            t.rows.splice(i, 1)
            t.rowMeta.splice(i, 1)
          }
        }
      }
      break
    }
    case 'duplicate-row': {
      const i = e.row as number
      const row = t.rows[i]
      // The copy takes user identity — a re-seed won't overwrite or drop it.
      // It lands after the source's val()-derived run, and derives its own.
      if (row) {
        let at = i + 1
        if (t.rowMeta[i].varName == null) {
          while (at < t.rows.length && t.rowMeta[at].varName != null) at++
        }
        t.rows.splice(at, 0, { ...row })
        t.rowMeta.splice(at, 0, userMeta())
        reconcileVarRows(t, at)
      }
      break
    }
    case 'set-cell': {
      const row = t.rows[e.row as number]
      if (row) {
        row[e.col as string] = e.value
        t.rowMeta[e.row as number].dirty = true
        if (e.col === 'code') reconcileVarRows(t, e.row as number)
      }
      break
    }
    case 'set-row': {
      const row = t.rows[e.row as number]
      if (row) {
        Object.assign(row, e.values as Record<string, unknown>)
        t.rowMeta[e.row as number].dirty = true
        if ('code' in ((e.values as Record<string, unknown> | undefined) ?? {})) reconcileVarRows(t, e.row as number)
      }
      break
    }
    case 'rename-table': {
      const to = e.to as string
      if (!to || tables.has(to)) break
      tables.delete(name)
      tables.set(to, t)
      break
    }
    case 'remove-table':
      tables.delete(name)
      break
  }
}

function foldEventsMap(events: StampedEvent[]): Map<string, TableState> {
  const tables = new Map<string, TableState>()
  for (const e of events) {
    // One malformed event must never sink the whole load — skip it, fold the rest.
    try { applyEvent(tables, e) } catch { /* ignore an unfoldable event */ }
  }
  return tables
}

export interface EditableTableStore {
  readonly log: EventLog
  listNames(): string[]
  has(name: string): boolean
  // A record() event stream — the table panel skips row/column editing for it.
  isLog(name: string): boolean
  get(name: string): EditableTableData | undefined
  createTable(name: string): void
  removeTable(name: string): void
  renameTable(name: string, newName: string): boolean
  // The DSL's editable(name, schema): appends a create on first sight, a
  // declare-schema when the schema changed, and returns the folded rows.
  ensure(name: string, schema: Schema, seedRows?: Row[]): Row[]
  // Drop code-created tables not in `keep` — the program stopped declaring
  // them. User "+ table"s, record() streams and "code" are never touched.
  // Returns the removed names. No-op while replaying (reads must not mutate).
  retainDeclared(keep: Iterable<string>): string[]
  addColumn(name: string, colName: string, type: ColumnType): void
  removeColumn(name: string, colName: string): void
  setColumnType(name: string, colName: string, type: ColumnType): void
  renameColumn(name: string, colName: string, newName: string): boolean
  addRow(name: string): void
  removeRow(name: string, index: number): void
  duplicateRow(name: string, index: number): void
  // One table's columns and rows as text — the clipboard form replaceTable
  // reads back (null for an unknown table).
  serializeTable(name: string): string | null
  // Replace a table's columns and rows wholesale with that form's; a bare row
  // array keeps the current columns. False on anything that isn't a table —
  // a malformed paste must leave the log untouched.
  replaceTable(name: string, json: string | unknown): boolean
  setCell(name: string, index: number, colName: string, value: unknown): void
  // Several cells of one row as a single event — one history entry, never
  // observed half-updated (e.g. a Run sets `code` and `seed` together).
  setRow(name: string, index: number, values: Record<string, unknown>): void
  // Append an arbitrary event on `table` (auto-created columnless on first
  // sight) — for non-row streams like Apply pulses and peer join/leave. Riding
  // the same log gives them serialize/load/multiplayer-sync for free.
  record(table: string, kind: string, payload?: Record<string, unknown>): void
  // Declare an on-screen slider from code (expr.slider / a post cell's
  // slider()): upserts { name, min, max } in the "sliders" table. Every run's
  // declaration is appended — the log is the canonical record — with src
  // derived from the name; the fold keeps one row per name and the last
  // declaration wins its range.
  defineSlider(id: string, min?: number, max?: number): void
  onChange(cb: () => void): void
  // --- runs (session history) ---------------------------------------------
  // Record the Apply bookmark (see SessionRun) and return it.
  recordRun(): SessionRun
  runs(): SessionRun[]
  setRuns(runs: SessionRun[]): void
  // --- branches -----------------------------------------------------------
  // Commit pending edits as a new apply node — the branch-aware successor to
  // recordRun (the apply event *is* the run). `parent` fast-forwards to the
  // branch tip, unless forked (edit while scrubbed): then `parent` is the
  // scrubbed node and `seen` the abandoned tip, so it reads as a fork.
  recordApply(payload?: Record<string, unknown>): ApplyNode | null
  // True when un-applied edits to real data tables are waiting — the signal the
  // Run/Apply button gates on. Markers that ride log tables (peer join/leave,
  // MIDI/slider recordings, loop resizes) don't count: they'd otherwise keep
  // the button lit through any performance.
  hasPendingEdits(): boolean
  // Folded from the log's apply events (cached; invalidated by any change).
  branchTree(): BranchTree
  // The apply id the live fold shows; null for a fresh/legacy log.
  currentHead(): string | null
  // root..head applies on the current branch — the session bar's scrub axis
  // (applies at or before the latest clear-runs marker are hidden).
  branchPath(): ApplyNode[]
  // Switch the live fold to another branch head, dropping any un-applied tail.
  checkout(headId: string): void
  // Promote a scrubbed branch-node replay to a forked live head now. Fork-on-
  // edit runs anyway on first append, but a cook reads before it writes, so
  // evaluate forks up front. Returns whether a fork happened.
  forkFromReplay(): boolean
  // Backward compat for sessions that saved no run list: derive one run per
  // program Run in "code"'s history, stopping at the latest clear-runs marker.
  deriveRunsFromCode(): void
  // Show the store as it was at a past point: reads serve the historical fold
  // and ensure() appends nothing — a pure preview. `null` returns to the live
  // head. Target is an apply node id (mutating while there forks) or a legacy
  // SessionRun log prefix (mutating edits the head, as before branches).
  setReplayView(target: SessionRun | string | null): void
  // The event-data half of a persisted session (runs are the other half).
  // load() replaces the whole history, refolds, and resets runs.
  serialize(): string
  load(json: string | unknown): boolean
  clear(): void
}

export function createEditableTableStore({ src }: { src?: string } = {}): EditableTableStore {
  const log = createEventLog({ src, migrations: EDITABLE_MIGRATIONS })
  // The live head fold, kept incrementally by append(). Replay views are separate.
  let tables = new Map<string, TableState>()
  // Legacy linear scrub coordinates, kept for pre-branch sessions and
  // session-format round-trips. The branch tree is the live coordinate.
  let runs: SessionRun[] = []
  // When set (scrubbed replay), reads serve this fold and ensure() is read-only.
  let replay: Map<string, TableState> | null = null
  // Apply node id the replay shows; null for a legacy SessionRun replay (or none).
  let replayNode: string | null = null

  // --- branch state -----------------------------------------------------------
  // `head`: the apply whose branch the live fold shows (null = fresh/legacy).
  // `pending`: keys of un-applied events the next apply will claim. `forked`:
  // the live fold was promoted from a scrubbed replay, so the next apply
  // parents the scrubbed node; `seenTip` is the tip it forked away from.
  let head: string | null = null
  let pending: string[] = []
  let forked = false
  let seenTip: string | null = null
  let treeCache: BranchTree | null = null
  const branchTree = (): BranchTree => (treeCache ??= buildBranchTree(log.all()))
  const invalidateTree = (): void => { treeCache = null }

  const listeners: (() => void)[] = []
  const notify = (): void => listeners.forEach((cb) => cb())

  const view = (): Map<string, TableState> => replay ?? tables

  // Follow the linearized non-fork chain down from `id` to its branch tip —
  // where an ordinary apply fast-forwards its parent onto.
  function branchTip(id: string, tree: BranchTree): string {
    let cur = id
    for (;;) {
      const next = (tree.children.get(cur) ?? []).find((k) => !tree.nodes.get(k)!.fork)
      if (!next) return cur
      cur = next
    }
  }

  // Newest apply on any branch — the performance head peers follow, and the
  // parent for the first apply on a legacy/fresh log.
  function newestApplyId(tree: BranchTree): string | null {
    let best: ApplyNode | null = null
    for (const n of tree.nodes.values()) {
      if (!best || compareEvents(best, n) < 0) best = n
    }
    return best?.id ?? null
  }

  // Rebuild the live fold from `head`'s branch — for checkout and merge, where
  // the incremental fold can't absorb the change.
  function refoldBranch(): void {
    tables = foldEventsMap(branchEvents(log.all(), head, branchTree()))
  }

  // Working tail from the log alone: unclaimed non-apply events after the
  // newest apply. Reattaches `pending` after a reload mid-edit, since no
  // pending list is persisted.
  function deriveWorkingTail(tree: BranchTree): string[] {
    const all = log.all()
    const claimed = new Set<string>()
    for (const n of tree.nodes.values()) for (const k of n.edits) claimed.add(k)
    let newest: StampedEvent | null = null
    for (const e of all) {
      if (e.kind === APPLY_KIND && typeof e.id === 'string' && (!newest || compareEvents(e, newest) > 0)) newest = e
    }
    const out: string[] = []
    for (const e of all) {
      if (e.kind === APPLY_KIND) continue
      if (claimed.has(eventKey(e))) continue
      if (newest && compareEvents(e, newest) <= 0) continue
      out.push(eventKey(e))
    }
    return out
  }

  // Fork-on-edit: promote a scrubbed branch-node replay to the live fold and
  // discard the abandoned working tail — the old branch's applies still claim
  // their events, so nothing is rewritten.
  function forkFromReplay(): boolean {
    if (replay === null || replayNode === null || head === null) return false
    seenTip = branchTip(head, branchTree())
    head = replayNode
    forked = true
    pending = []
    tables = replay
    replay = null
    replayNode = null
    return true
  }

  function append(payload: Record<string, unknown> & { kind: string; table: string }): void {
    forkFromReplay()
    replay = null
    replayNode = null
    const e = log.append(payload)
    applyEvent(tables, e)
    // Every ordinary event (record() markers included) joins the working tail
    // so the next apply claims it; applies are never their own pending.
    if (e.kind !== APPLY_KIND) pending.push(eventKey(e))
    invalidateTree()
    notify()
  }

  // Remote events can land between existing ones, so refold rather than apply
  // incrementally. Any replay/fork-in-progress is dropped. When a peer's apply
  // merges in, follow it: the performance head is the newest apply on any
  // branch, so peers stay together.
  log.onMerge((added) => {
    replay = null
    replayNode = null
    forked = false
    invalidateTree()
    const tree = branchTree()
    if (added.some((e) => e.kind === APPLY_KIND && typeof e.id === 'string')) {
      const newest = newestApplyId(tree)
      if (newest) { head = newest; seenTip = newest }
    } else if (head !== null && !tree.nodes.has(head)) {
      head = newestApplyId(tree)
      seenTip = head
    }
    // Drop from pending anything a merged apply now claims (a peer committed
    // edits it had seen from us).
    if (pending.length) {
      const claimed = new Set<string>()
      for (const n of tree.nodes.values()) for (const k of n.edits) claimed.add(k)
      pending = pending.filter((k) => !claimed.has(k))
    }
    refoldBranch()
    notify()
  })

  return {
    log,
    listNames: () => [...view().keys()],
    has: (name) => view().has(name),
    isLog: (name) => view().get(name)?.log ?? false,

    get(name: string): EditableTableData | undefined {
      const t = view().get(name)
      return t ? { columns: effectiveColumns(t), rows: t.rows, events: t.events } : undefined
    },

    createTable(name: string): void {
      if (tables.has(name)) return
      // New tables start with "beat" — the 1-indexed beat convention tables key
      // time by; a beat past the loop's end lands in a later pass of the loop.
      append({ kind: 'create', table: name, columns: [{ name: 'beat', type: 'number' }] })
    },

    removeTable(name: string): void {
      if (!tables.has(name)) return
      append({ kind: 'remove-table', table: name })
    },

    renameTable(name: string, newName: string): boolean {
      newName = newName.trim()
      if (!newName || !tables.has(name) || tables.has(newName)) return false
      append({ kind: 'rename-table', table: name, to: newName })
      return true
    },

    ensure(name: string, schema: Schema, seedRows?: Row[]): Row[] {
      const wantCols = schemaColumns(schema)
      // Replay is a read-only preview: serve historical rows (or the seed, for
      // a table that didn't exist then) and append nothing.
      if (replay) {
        const t = replay.get(name)
        if (t) return visibleRows(t)
        return (seedRows ?? []).map((r) => conformRow(r, wantCols))
      }
      const existing = tables.get(name)
      if (!existing) {
        append({ kind: 'create', table: name, columns: wantCols, rows: seedRows, declared: true })
        return visibleRows(tables.get(name)!)
      }
      if (JSON.stringify(existing.declared) !== JSON.stringify(wantCols)) {
        append({ kind: 'declare-schema', table: name, columns: wantCols })
      }
      // Unchanged seeds stay silent, like an unchanged schema, so an ordinary
      // Run of the same code appends nothing.
      const t = tables.get(name)!
      if (t.codeCreated && seedRows !== undefined && JSON.stringify(seedRows) !== JSON.stringify(t.lastSeed)) {
        append({ kind: 'seed-rows', table: name, rows: seedRows })
      }
      return visibleRows(tables.get(name)!)
    },

    retainDeclared(keep: Iterable<string>): string[] {
      if (replay) return []
      const keepSet = new Set(keep)
      const removed: string[] = []
      for (const [name, t] of tables) {
        // "code" is code-created too but is the program itself — never prune it.
        if (t.codeCreated && !t.log && name !== 'code' && !keepSet.has(name)) removed.push(name)
      }
      for (const name of removed) append({ kind: 'remove-table', table: name })
      return removed
    },

    addColumn(name: string, colName: string, type: ColumnType): void {
      colName = colName.trim()
      const t = tables.get(name)
      if (!t || !colName || effectiveColumns(t).some((c) => c.name === colName)) return
      append({ kind: 'add-column', table: name, col: colName, type })
    },

    removeColumn(name: string, colName: string): void {
      const t = tables.get(name)
      if (!t || !effectiveColumns(t).some((c) => c.name === colName)) return
      append({ kind: 'remove-column', table: name, col: colName })
    },

    setColumnType(name: string, colName: string, type: ColumnType): void {
      const t = tables.get(name)
      const col = t && effectiveColumns(t).find((c) => c.name === colName)
      if (!col || col.type === type) return
      append({ kind: 'set-column-type', table: name, col: colName, type })
    },

    renameColumn(name: string, colName: string, newName: string): boolean {
      newName = newName.trim()
      const t = tables.get(name)
      if (!t || !newName || newName === colName) return false
      const cols = effectiveColumns(t)
      if (!cols.some((c) => c.name === colName) || cols.some((c) => c.name === newName)) return false
      append({ kind: 'rename-column', table: name, col: colName, to: newName })
      return true
    },

    addRow(name: string): void {
      if (!tables.has(name)) return
      append({ kind: 'add-row', table: name })
    },

    removeRow(name: string, index: number): void {
      const t = tables.get(name)
      if (!t || index < 0 || index >= t.rows.length) return
      append({ kind: 'remove-row', table: name, row: index })
    },

    duplicateRow(name: string, index: number): void {
      const t = tables.get(name)
      if (!t || index < 0 || index >= t.rows.length) return
      append({ kind: 'duplicate-row', table: name, row: index })
    },

    serializeTable(name: string): string | null {
      const t = view().get(name)
      if (!t) return null
      // val()-derived rows are left out: replaceTable re-derives them from the
      // code rows that own them, so keeping them would double every one.
      const rows = t.rows.filter((_r, i) => t.rowMeta[i].varName == null)
      return JSON.stringify({ columns: effectiveColumns(t), rows }, null, 2)
    },

    replaceTable(name: string, json: string | unknown): boolean {
      const t = tables.get(name)
      if (!t) return false
      let value: unknown = json
      if (typeof value === 'string') {
        try { value = JSON.parse(value) } catch { return false }
      }
      // A bare row array is the columns-less form: it keeps the current ones.
      const data = (Array.isArray(value) ? { rows: value } : value ?? {}) as { columns?: unknown; rows?: unknown }
      const rows = data.rows
      if (!Array.isArray(rows) || rows.some((r) => !r || typeof r !== 'object')) return false
      const columns = data.columns === undefined
        ? effectiveColumns(t)
        : eventColumns(data.columns).filter((c) => typeof c.name === 'string' && c.name !== '')
      if (!columns.length) return false
      append({ kind: 'replace-table', table: name, columns, rows })
      return true
    },

    setCell(name: string, index: number, colName: string, value: unknown): void {
      if (!tables.get(name)?.rows[index]) return
      append({ kind: 'set-cell', table: name, row: index, col: colName, value })
    },

    setRow(name: string, index: number, values: Record<string, unknown>): void {
      if (!tables.get(name)?.rows[index]) return
      append({ kind: 'set-row', table: name, row: index, values })
    },

    record(table: string, kind: string, payload: Record<string, unknown> = {}): void {
      if (!tables.has(table)) append({ kind: 'create', table, columns: [], log: true })
      append({ kind, table, ...payload })
    },

    defineSlider(id: string, min?: number, max?: number): void {
      id = id.trim()
      if (!id || replay) return
      append({ kind: DEFINE_SLIDER_KIND, table: SLIDERS_TABLE, src: 'slider:' + id, id, min: min ?? 0, max: max ?? 1 })
    },

    onChange(cb: () => void): void {
      listeners.push(cb)
    },

    recordRun(): SessionRun {
      replay = null
      const run: SessionRun = { at: log.length, tables: tableEventCounts(tables) }
      runs.push(run)
      return run
    },

    runs: () => runs.map((r) => ({ at: r.at, tables: { ...r.tables } })),

    setRuns(next: SessionRun[]): void {
      runs = next.map((r) => ({ at: r.at, tables: { ...r.tables } }))
    },

    deriveRunsFromCode(): void {
      const code = tables.get('code')
      const all = log.all()
      const clearedSeq = all.reduce((max, e) => (e.kind === CLEAR_RUNS_KIND ? Math.max(max, e.seq) : max), -1)
      runs = (code?.events ?? [])
        .filter((e) => (e.seq as number) > clearedSeq)
        .map((e) => {
          const at = (e.seq as number) + 1
          return { at, tables: tableEventCounts(foldEventsMap(all.slice(0, at))) }
        })
    },

    recordApply(payload: Record<string, unknown> = {}): ApplyNode | null {
      replay = null
      replayNode = null
      const tree = branchTree()
      let parent: string | null
      let seen: string | null
      if (forked && head !== null) {
        // Deliberate fork: parent is the scrubbed node, seen the abandoned tip.
        parent = head
        seen = seenTip ?? head
      } else {
        // Ordinary apply: fast-forward onto the branch tip, so seen == parent.
        parent = head !== null ? branchTip(head, tree) : newestApplyId(tree)
        seen = parent
      }
      const id = mintApplyId()
      // An ordinary apply also claims the derived working tail — a peer's edit
      // merged in since the last apply is un-claimed, and leaving it so lets a
      // later fold revert it. The union matters: the tail alone would drop a
      // local edit whose seq sits below a peer's newer apply. A deliberate fork
      // stays on `pending`, since forkFromReplay's discarded tail is exactly
      // what must not come back.
      const edits = forked && head !== null
        ? pending.slice()
        : [...new Set([...pending, ...deriveWorkingTail(tree)])]
      // Ensure the activity table exists first — the fold drops events on an
      // unknown table.
      if (!tables.has(ACTIVITY_TABLE)) {
        const create = log.append({ kind: 'create', table: ACTIVITY_TABLE, columns: [], log: true })
        applyEvent(tables, create)
        edits.push(eventKey(create))
      }
      const e = log.append({ kind: APPLY_KIND, table: ACTIVITY_TABLE, id, parent, seen, edits, ...payload })
      applyEvent(tables, e)
      head = id
      seenTip = id
      forked = false
      pending = []
      invalidateTree()
      notify()
      return branchTree().nodes.get(id) ?? null
    },

    hasPendingEdits(): boolean {
      if (!pending.length) return false
      const want = new Set(pending)
      for (const e of log.all()) {
        if (!want.has(eventKey(e))) continue
        // Markers ride log tables; only a data-table edit counts.
        if (tables.get(e.table as string)?.log) continue
        return true
      }
      return false
    },

    branchTree,

    currentHead: () => head,

    branchPath(): ApplyNode[] {
      if (head === null) return []
      const all = log.all()
      const clearedSeq = all.reduce((max, e) => (e.kind === CLEAR_RUNS_KIND ? Math.max(max, e.seq) : max), -1)
      // Hide applies at or before the latest clear marker — the fold still
      // uses the full path.
      return branchTree().pathTo(head).filter((n) => n.seq > clearedSeq)
    },

    checkout(headId: string): void {
      if (!branchTree().nodes.has(headId)) return
      replay = null
      replayNode = null
      forked = false
      head = headId
      seenTip = headId
      pending = []
      refoldBranch()
      notify()
    },

    forkFromReplay(): boolean {
      const forkedNow = forkFromReplay()
      if (forkedNow) { invalidateTree(); notify() }
      return forkedNow
    },

    setReplayView(target: SessionRun | string | null): void {
      if (target === null) {
        replay = null
        replayNode = null
      } else if (typeof target === 'string') {
        // Branch-aware scrub: fold that apply's branch up to it.
        replayNode = target
        replay = foldEventsMap(branchEvents(log.all(), target, branchTree()))
      } else {
        // Legacy SessionRun: a log prefix.
        replayNode = null
        replay = foldEventsMap(log.all().slice(0, target.at))
      }
    },

    serialize: () => log.serialize(),

    load(json: string | unknown): boolean {
      if (!log.load(json)) return false
      replay = null
      replayNode = null
      runs = []
      forked = false
      pending = []
      invalidateTree()
      // Adopt the newest apply so a saved branching session opens on its latest
      // branch; a legacy log has none, so head stays null (linear).
      head = newestApplyId(branchTree())
      seenTip = head
      // Reattach any un-applied working tail so the next apply claims it.
      pending = head !== null ? deriveWorkingTail(branchTree()) : []
      refoldBranch()
      notify()
      return true
    },

    clear(): void {
      log.clear()
      tables = new Map()
      replay = null
      replayNode = null
      runs = []
      head = null
      seenTip = null
      forked = false
      pending = []
      invalidateTree()
      notify()
    },
  }
}
