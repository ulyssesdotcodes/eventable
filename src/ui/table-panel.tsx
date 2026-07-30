// Combined table + graph panel — the humble Solid view over ../table-panel.ts:
// one tab per view, a chart when numeric columns exist, and "Table"/"Events"
// sub-tabs for editable tables. All decisions come from the model's pure
// functions; every interaction forwards to the EditableTableStore, and the
// `tick` signal is bumped after each store write so reads re-fold.

import {
  createSignal, createMemo, createEffect, on, onCleanup, untrack,
  For, Index, Show, type Accessor, type JSX, type Setter,
} from 'solid-js'
import { SERIES_COLORS, chartDataFor, computeColRanges, drawSeriesChart, fmtNum, PANEL_CHART_STYLE, type ColRange } from '../graph-panel.js'
import {
  MAX_ROWS, COLUMN_TYPES, EVENTS_SUFFIX, formatCell, formatEditableCell,
  allNames, nextTableName, fallbackTab, chartFor, bottomSlotFor, hasCodeColumn,
  displayOrder, activeRowIndex,
  tabRingStyle, viewersOf, lastEditors, moveFocus, isCellInert,
  type TablePanel, type TablePanelOptions, type PeerPresence, type CellFocus, type FocusDir,
} from '../table-panel.js'
import { listenGlobal, focusInput } from './dom.js'
import { hydraCodeUpToRow } from '../hydra.js'
import { baubleCodeUpToRow } from '../bauble.js'
import { postCodeUpToRow } from '../post.js'
import { timelineSegments } from '../timeline.js'
import { CodeFacade, ExprOverlay, MobileEditorPopover } from './facade.js'
import { DocsPopover } from './docs-popover.js'
import { Icon } from './icon.js'
import type { GraphSpec, Table } from '../dsl.js'
import type { EditTarget } from '../editor-host.js'
import type { Row } from '../lineage.js'
import { DISABLED_COL, cellValid, invalidColumns, isExprCellText, type EditableTableStore, type ColumnType, type EditableColumn } from '../editable-tables.js'
// Registers the "=" cell checker cellValid consults (see editable-tables.ts).
import '../expr-cell.js'

export { EVENTS_SUFFIX }
export type { TablePanel, TablePanelOptions, PeerPresence }

// Per-user-colored name list — the visible half of a presence indicator,
// shared by the tab strip and a cell's last-editor badge.
function PresenceNames(nameProps: { peers: PeerPresence[] }) {
  return (
    <For each={nameProps.peers}>
      {(p, i) => (
        <>
          <Show when={i() > 0}>{', '}</Show>
          <span style={{ color: p.color }}>{p.user}</span>
        </>
      )}
    </For>
  )
}

// Settings and scene import/export, rendered in the table pane's header.
export interface PanelChrome {
  vimMode: boolean
  midiEnabled: boolean
  setVimMode(enabled: boolean): void
  setMidiEnabled(enabled: boolean): void
  resetHydra(): void
  exportScene(): void
  importScene(): void
}

interface PanelProps extends TablePanelOptions {
  store: EditableTableStore
  views: Accessor<Map<string, Table>>
  graphs: Accessor<Map<string, GraphSpec>>
  current: Accessor<string | null>
  setCurrent: Setter<string | null>
  desiredTable: Accessor<string | null>
  setDesiredTable: Setter<string | null>
  playIndex: Accessor<number>
  playActive: Accessor<Map<string, Set<number>> | null>
  userScrolled: Accessor<boolean>
  setUserScrolled: Setter<boolean>
  presence: Accessor<PeerPresence[]>
  // The view hands back a function that returns keyboard focus to the grid, so
  // the controller (and, through it, the editor) can refocus after a code cell.
  registerGridFocus: (fn: () => void) => void
  // Same registration pattern, for the timeline strip's handle clicks
  // (ui/timeline-strip.tsx): the view hands back a function that focuses a
  // row's first cell when that row's table is the open tab, or clears the
  // focus (row === null) when a background click deselects.
  registerFocusRow: (fn: (table: string, row: number | null) => void) => void
  // Mirrors the view's focused cell out to the controller (table-scoped),
  // so the strip can ring the matching handle.
  reportFocusedRow: (focus: { table: string; row: number } | null) => void
  // The row the timeline strip is pointing at (a hover over a handle, or an
  // in-progress drag), table-scoped — the matching row gets a stronger
  // row-level highlight than the ordinary focused-cell ring for exactly that
  // long (see .row-strip-active below).
  stripRow: Accessor<{ table: string; row: number } | null>
}

// `children` slots under the header: session selector / room chip / session bar.
function TablePanelView(props: PanelProps & { chrome: PanelChrome; children?: JSX.Element }) {
  const { store, views, graphs, current, setCurrent, presence } = props

  // Presence: announce every tab switch, including the initial one (not
  // deferred) — main.ts publishes which table this replica has open.
  createEffect(() => props.onSelectTable?.(current()))

  // Bumped after every store write so memos re-read the non-reactive
  // EditableTableStore fold.
  const [tick, setTick] = createSignal(0)
  const bump = () => setTick((t) => t + 1)

  // store.onChange has no unsubscribe; this view is mounted once for the
  // app's lifetime, so one subscription for life is fine (mirrors
  // ui/timeline-strip.tsx's own tick).
  store.onChange(bump)

  // A Run can change `views` without ever writing to the store (a recomputed,
  // non-editable table), so store.onChange alone can miss it — pair every
  // external `views` refresh with a bump too, or tick-gated store reads would
  // show the pre-Run shape.
  createEffect(on(views, () => bump(), { defer: true }))

  const [filter, setFilter] = createSignal('')
  // At most one cell in edit mode at a time; an outside mousedown cancels it.
  const [editingCell, setEditingCell] = createSignal<string | null>(null)
  // Cell whose editor was just opened by Tab and must survive the async panel
  // refresh that follows a store write (see advanceEdit / guardFocus).
  let focusGuardKey: string | null = null
  const [openColMenu, setOpenColMenu] = createSignal<string | null>(null)
  const [openInfoRow, setOpenInfoRow] = createSignal<string | null>(null)
  const [subView, setSubView] = createSignal<'table' | 'events'>('table')
  // Live, not a one-shot read: the facades below are <Index>-keyed, so their
  // props are only evaluated once per slot and a frozen `.matches` would keep
  // routing promotion the wrong way after a resize or rotation.
  const mobileQuery = window.matchMedia('(max-width: 767px)')
  const [isMobile, setIsMobile] = createSignal(mobileQuery.matches)
  const onMobileChange = (e: MediaQueryListEvent): void => { setIsMobile(e.matches) }
  mobileQuery.addEventListener('change', onMobileChange)
  onCleanup(() => mobileQuery.removeEventListener('change', onMobileChange))
  const [graphCollapsed, setGraphCollapsed] = createSignal(mobileQuery.matches)
  // Mobile soft keyboards have no Tab key; on a coarse pointer a cell editor's
  // "next" action walks to the next cell in the row instead of closing to
  // arrow-key navigation (which needs a physical keyboard anyway).
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches
  const [colRanges, setColRanges] = createSignal<ColRange[] | null>(null)
  // Keyboard navigation: the arrow-key cursor over editable cells (null until
  // the grid is first driven), and the "/"-opened table picker overlay.
  const [focusedCell, setFocusedCell] = createSignal<CellFocus | null>(null)
  const [pickerOpen, setPickerOpen] = createSignal(false)
  // At most one anchored "=" overlay and one full-screen mobile editor; both
  // close on a tab switch and when anything else takes the live view.
  const [exprCell, setExprCell] = createSignal<{ target: EditTarget; anchor: HTMLElement } | null>(null)
  const [popoverTarget, setPopoverTarget] = createSignal<EditTarget | null>(null)
  // The settings menu is position:fixed (not absolute) so the pane's
  // overflow:hidden can't clip it.
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [menuPos, setMenuPos] = createSignal<{ top: number; right: number }>({ top: 0, right: 0 })
  let settingsWrap: HTMLDivElement | undefined
  let settingsBtn: HTMLButtonElement | undefined

  // Hand the controller a way to pull keyboard focus back onto the grid — used
  // after committing an inline edit and when a code cell's editor is escaped.
  const refocusGrid = (): void => { scrollEl?.focus() }
  props.registerGridFocus(refocusGrid)

  listenGlobal(document, 'mousedown', (e) => {
    const target = e.target as HTMLElement | null
    if (editingCell() != null && !target?.closest?.('.editable-cell.editing')) setEditingCell(null)
    if (openColMenu() != null && !target?.closest?.('.col-settings-wrap')) setOpenColMenu(null)
    if (openInfoRow() != null && !target?.closest?.('.row-info-wrap')) setOpenInfoRow(null)
    if (pickerOpen() && !target?.closest?.('.table-picker')) setPickerOpen(false)
  })

  listenGlobal(document, 'click', (e) => {
    if (settingsWrap && !settingsWrap.contains(e.target as Node)) setSettingsOpen(false)
  })

  const names = createMemo(() => {
    tick()
    return allNames(views(), store)
  })

  // A pending restore (desiredTable) wins the moment its table appears among
  // the tabs — cooked-view tabs only exist after the cook — and is cleared
  // once honored so it never fights a later manual tab switch.
  createEffect(() => {
    const ns = names()
    const want = props.desiredTable()
    if (want != null && ns.includes(want)) {
      props.setDesiredTable(null)
      setCurrent(want)
      return
    }
    setCurrent((cur) => fallbackTab(ns, cur))
  })

  // Switching tabs resets transient edit state and drops back to the "table"
  // sub-tab.
  createEffect(on(current, () => {
    setEditingCell(null)
    setOpenColMenu(null)
    setOpenInfoRow(null)
    setSubView('table')
    setFocusedCell(null)
    setPickerOpen(false)
    setExprCell(null)
    setPopoverTarget(null)
  }, { defer: true }))

  // A genuine editable table, as opposed to a cooked view or a log table.
  const isEditableTable = createMemo(() => {
    tick()
    const name = current()
    return !!name && store.has(name) && !store.isLog(name)
  })

  const editableData = createMemo(() => {
    tick(); views()
    const name = current()
    if (!name || !isEditableTable() || subView() === 'events') return null
    const data = store.get(name)
    return data ? { name, data } : null
  })

  // Keep a just-opened editor focused across the async panel refresh a store
  // write triggers (the refresh blurs the editor, whose blur handler would
  // close it): commit's viaBlur guard ignores the spurious blur, and this
  // restores focus once the refresh settles.
  function guardFocus(key: string): void {
    focusGuardKey = key
    const restore = (): void => {
      if (editingCell() !== key) return
      const el = scrollEl?.querySelector<HTMLInputElement>('.editable-cell.editing input, .editable-cell.editing select')
      if (el && document.activeElement !== el) el.focus()
    }
    requestAnimationFrame(() => {
      restore()
      requestAnimationFrame(() => {
        restore()
        if (focusGuardKey === key) focusGuardKey = null
      })
    })
  }

  // Tab/Shift+Tab out of a cell editor (the caller commits first): move to
  // the adjacent column, wrapping to the next/previous display row. Code
  // cells open in the main editor; every other type edits inline.
  function advanceEdit(rowIndex: number, colName: string, dir: 1 | -1): void {
    const ed = editableData()
    if (!ed) return
    const { name: table, data } = ed
    const cols = data.columns
    const cIdx = cols.findIndex((c) => c.name === colName)
    if (cIdx < 0) return
    let nextRow = rowIndex
    let nextIdx = cIdx + dir
    if (nextIdx < 0 || nextIdx >= cols.length) {
      const order = displayOrder(data.rows, cols)
      const pos = order.indexOf(rowIndex)
      const nextPos = pos + dir
      if (pos < 0 || nextPos < 0 || nextPos >= order.length) return
      nextRow = order[nextPos]
      nextIdx = dir > 0 ? 0 : cols.length - 1
    }
    const target = cols[nextIdx]
    const tv = data.rows[nextRow]?.[target.name]
    if (target.type === 'code' || isExprCellText(tv)) {
      openCell(table, nextRow, target)
      return
    }
    const nextKey = `${nextRow}::${target.name}`
    setEditingCell(nextKey)
    guardFocus(nextKey)
  }

  // --- keyboard navigation -----------------------------------------------------

  const cellEl = (row: number, col: string): HTMLElement | null =>
    scrollEl?.querySelector<HTMLElement>(`.editable-cell[data-row="${row}"][data-col="${CSS.escape(col)}"]`) ?? null

  const scrollCellIntoView = (fc: CellFocus): void => {
    requestAnimationFrame(() => cellEl(fc.row, fc.col)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
  }

  // A code or "=" cell edits in the app's one roving CodeMirror, never an
  // inline input: a code cell hands the view to its facade in the bottom slot
  // (focusing the facade is what promotes it), an "=" cell gets an overlay
  // anchored under its <td>, and on a phone either opens the full-screen
  // popover instead — the facades are unreadable at that width.
  function openCell(table: string, rowIndex: number, col: EditableColumn, override?: string): void {
    const v = override ?? editableData()?.data.rows[rowIndex]?.[col.name]
    const target = props.targetFor(table, rowIndex, col.name, v == null ? '' : String(v))
    if (window.matchMedia('(max-width: 767px)').matches) {
      setPopoverTarget(target)
      return
    }
    if (col.type === 'code') {
      requestAnimationFrame(() => {
        const el = bottomEl?.querySelector<HTMLElement>(`.code-facade[data-label="${CSS.escape(target.label)}"] .facade-code`)
        el?.scrollIntoView({ block: 'nearest' })
        el?.focus()
      })
      return
    }
    const anchor = cellEl(rowIndex, col.name)
    if (anchor) setExprCell({ target, anchor })
  }

  // A handle click on the timeline strip lands here: focus the row's first
  // column (a no-op if the click's table isn't the open tab — the strip only
  // ever renders handles for the current table, so this is a safety guard,
  // not the common path).
  props.registerFocusRow((table, row) => {
    if (table !== current()) return
    if (row === null) { setFocusedCell(null); return }
    const firstCol = editableData()?.data.columns[0]?.name
    if (!firstCol) return
    const fc = { row, col: firstCol }
    setFocusedCell(fc)
    scrollCellIntoView(fc)
  })

  // Mirror the focused cell out to the controller, table-scoped, so the strip
  // can highlight the matching handle.
  createEffect(() => {
    const fc = focusedCell()
    const cur = current()
    props.reportFocusedRow(fc && cur ? { table: cur, row: fc.row } : null)
  })

  // Enter on the focused cell: code cells (and "=" expression cells) open in
  // the main editor, enums focus their live dropdown, everything else opens
  // its inline editor.
  function beginEditFocused(): void {
    const fc = focusedCell()
    const ed = editableData()
    if (!fc || !ed) return
    const col = ed.data.columns.find((c) => c.name === fc.col)
    if (!col) return
    const v = ed.data.rows[fc.row]?.[col.name]
    if (col.type === 'code' || (col.type !== 'enum' && isExprCellText(v))) {
      openCell(ed.name, fc.row, col)
      return
    }
    if (col.type === 'enum') {
      cellEl(fc.row, col.name)?.querySelector('select')?.focus()
      return
    }
    setEditingCell(`${fc.row}::${col.name}`)
  }

  function onGridKeyDown(e: KeyboardEvent): void {
    if (pickerOpen() || editingCell() != null) return
    // A cell's own editor (or the enum dropdown) owns the keys while focused.
    const t = e.target as HTMLElement | null
    if (t && t !== scrollEl && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return
    // "/" opens the table switcher from any table, editable or not.
    if (e.key === '/' && current()) { e.preventDefault(); setPickerOpen(true); return }
    // Cell navigation is an editable-table feature; read-only views just scroll.
    if (!isEditableTable()) return
    const ed = editableData()
    if (!ed) return
    const cols = ed.data.columns
    const order = displayOrder(ed.data.rows, cols).filter(edRowVisible)
    if (!cols.length || !order.length) return
    const fc = focusedCell()
    // No cursor yet, or it points at a now-hidden/removed cell: land on the
    // first visible cell.
    if (!fc || order.indexOf(fc.row) < 0 || !cols.some((c) => c.name === fc.col)) {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) return
      e.preventDefault()
      const first = { row: order[0], col: cols[0].name }
      setFocusedCell(first)
      scrollCellIntoView(first)
      return
    }
    if (e.key === 'Enter') { e.preventDefault(); beginEditFocused(); return }
    const dir = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const)[e.key] as FocusDir | undefined
    if (!dir) return
    e.preventDefault()
    const next = moveFocus(order, cols, fc, dir)
    if (next) { setFocusedCell(next); scrollCellIntoView(next) }
  }

  const roTable = createMemo(() => {
    const name = current()
    if (!name || editableData()) return null
    // The "events" sub-tab reads the injected `name·events` view; everything
    // else is keyed by its own name.
    const key = isEditableTable() ? name + EVENTS_SUFFIX : name
    return views().get(key) ?? null
  })
  const roCols = createMemo(() => roTable()?.columns ?? [])
  const shownRows = createMemo(() => {
    const t = roTable()
    return t ? t.rows.slice(0, MAX_ROWS) : []
  })
  const indexCol = createMemo(() => (roCols().includes('beat') ? 'beat' : null))
  const activeIdx = createMemo(() => {
    const col = indexCol()
    return col ? activeRowIndex(shownRows(), col, props.playIndex()) : -1
  })
  const lineageSet = () => props.playActive()?.get(current() ?? '')

  const chart = createMemo(() => (
    editableData() || (isEditableTable() && subView() === 'events') ? null : chartFor(current(), views(), graphs(), store)
  ))

  // What sits below the grid: one facade per code-bearing row (the `code`
  // table's rows *are* the program's fragments), a passive warp map for a
  // timeline-schema table, or nothing.
  const bottomSlot = createMemo(() => {
    tick(); views()
    return subView() === 'events' ? 'none' : bottomSlotFor(current(), views(), store)
  })

  const codeTargets = createMemo<EditTarget[]>(() => {
    const ed = editableData()
    if (!ed || bottomSlot() !== 'facades') return []
    const codeCols = ed.data.columns.filter((c) => c.type === 'code')
    return displayOrder(ed.data.rows, ed.data.columns).flatMap((i) =>
      codeCols.map((c) => {
        const v = ed.data.rows[i]?.[c.name]
        return props.targetFor(ed.name, i, c.name, v == null ? '' : String(v))
      }))
  })

  // A facade slot is <Index>-keyed by position and labeled by row index, so a
  // tab switch or a row insert/delete rebinds a live slot to a different row
  // in place — no unmount, so CodeFacade's onCleanup demote never fires and
  // the promoted view is left orphaned under a label that now means something
  // else. Flush it first, while its commit still validates against the cell it
  // was opened on (see cellTarget in main.ts). Keyed on the promoted cell's own
  // text, not the row count: an append (a peer's, or the local "+ row") leaves
  // that cell alone and must not demote a half-typed buffer.
  createEffect(on(codeTargets, (next, prev) => {
    const label = props.host.promoted()
    if (!label) return
    const after = next.find((t) => t.label === label)
    const before = prev?.find((t) => t.label === label)
    if (!after || (before && before.text !== after.text)) props.host.demote()
  }, { defer: true }))

  const roRowText = (i: number) =>
    roCols().map((c) => formatCell(c, shownRows()[i]?.[c])).join(' ').toLowerCase()
  const edRowText = (i: number) => {
    const d = editableData()?.data
    if (!d) return ''
    return d.columns.map((c) => formatEditableCell(c.type, d.rows[i]?.[c.name])).join(' ').toLowerCase()
  }
  const roRowVisible = (i: number) => !filter() || roRowText(i).includes(filter())
  const edRowVisible = (i: number) => !filter() || edRowText(i).includes(filter())

  const countText = createMemo(() => {
    const q = filter()
    const ed = editableData()
    if (ed) {
      const total = ed.data.rows.length
      if (q && total) {
        const visible = ed.data.rows.filter((_r, i) => edRowVisible(i)).length
        return `${visible} / ${total} row${total === 1 ? '' : 's'}`
      }
      return `${total} row${total === 1 ? '' : 's'}`
    }
    const t = roTable()
    if (!current() || !t) return ''
    if (!t.length) return '0 rows'
    const shown = shownRows()
    if (q && shown.length) {
      const visible = shown.filter((_r, i) => roRowVisible(i)).length
      return `${visible} / ${shown.length} row${shown.length === 1 ? '' : 's'}`
    }
    return t.length > MAX_ROWS
      ? `${t.length} rows (showing ${MAX_ROWS})`
      : `${shown.length} row${shown.length === 1 ? '' : 's'}`
  })

  // --- scroll/autoscroll -----------------------------------------------------
  let scrollEl: HTMLDivElement | undefined
  let suppressScrollEvent = false
  const roRowEls: HTMLTableRowElement[] = []

  createEffect(on(current, () => {
    props.setUserScrolled(false)
    if (scrollEl) {
      suppressScrollEvent = true
      scrollEl.scrollTop = 0
      requestAnimationFrame(() => { suppressScrollEvent = false })
    }
  }, { defer: true }))

  createEffect(() => {
    const ai = activeIdx()
    if (props.userScrolled() || ai < 0) return
    const el = roRowEls[ai]
    if (!el) return
    suppressScrollEvent = true
    el.scrollIntoView({ block: 'nearest' })
    requestAnimationFrame(() => { suppressScrollEvent = false })
  })

  // --- chart -------------------------------------------------------------------
  let graphCanvas: HTMLCanvasElement | undefined

  function drawCurrentChart(): void {
    const c = untrack(chart)
    if (!c || !graphCanvas) return
    const ranges = computeColRanges(c.rows, c.cols, PANEL_CHART_STYLE.yPadFrac)
    drawSeriesChart(graphCanvas, c, ranges, {
      playIndex: untrack(props.playIndex),
      activeRows: untrack(props.playActive)?.get(c.name) ?? null,
    })
    setColRanges(ranges)
  }

  const ro = new ResizeObserver(() => drawCurrentChart())
  onCleanup(() => ro.disconnect())

  // Redraw on data/playhead changes; (re)observe the canvas only when the
  // chart appears or disappears, not per frame.
  createEffect(() => {
    ro.disconnect()
    if (!chart()) {
      setColRanges(null)
      return
    }
    if (graphCanvas) ro.observe(graphCanvas)
  })
  createEffect(() => {
    props.playIndex()
    props.playActive()
    if (chart()) drawCurrentChart()
  })

  // --- warp map ----------------------------------------------------------------
  // A timeline-schema table's compiled segments, plotted as source beat against
  // playback beat: the shape of the warp the retimed content rides.
  let warpCanvas: HTMLCanvasElement | undefined
  let bottomEl: HTMLDivElement | undefined

  function drawWarp(): void {
    if (!warpCanvas?.isConnected) return
    const name = current()
    if (!name) return
    const rows = (store.get(name)?.rows ?? views().get(name)?.rows ?? []).filter((r) => r[DISABLED_COL] !== true)
    const points: Row[] = timelineSegments(rows, props.loopBeats())
      .flatMap((s) => [{ beat: s.p0, source: s.s0 }, { beat: s.p1, source: s.s1 }])
    const data = chartDataFor(points, ['beat', 'source'], ['source'], name)
    if (!data) return
    drawSeriesChart(warpCanvas, data, computeColRanges(points, ['source'], PANEL_CHART_STYLE.yPadFrac), {
      playIndex: props.playIndex(),
    })
  }

  const warpRo = new ResizeObserver(() => drawWarp())
  onCleanup(() => warpRo.disconnect())
  // Split like the chart pair above: re-observing an element fires the
  // observer's initial notification, so a combined effect drew twice per frame.
  createEffect(() => {
    warpRo.disconnect()
    if (bottomSlot() === 'warp' && warpCanvas) warpRo.observe(warpCanvas)
  })
  createEffect(() => { tick(); views(); props.playIndex(); drawWarp() })

  // --- editable sub-views ------------------------------------------------------

  function ColHeader(colProps: { table: string; col: EditableColumn }) {
    const { table, col } = colProps
    const [renaming, setRenaming] = createSignal(false)
    const [menuPos, setMenuPos] = createSignal<{ top: number; left: number } | null>(null)
    const menuKey = `${table}::${col.name}`
    const menuOpen = () => openColMenu() === menuKey
    let settingsBtn: HTMLButtonElement | undefined
    let menuEl: HTMLDivElement | undefined

    const commitRename = (value: string): void => {
      const v = value.trim()
      if (v && v !== col.name) store.renameColumn(table, col.name, v)
      setRenaming(false)
    }

    // Measured after opening so a menu near the viewport's right edge clamps
    // against its real width instead of overflowing.
    createEffect(() => {
      if (!menuOpen() || !settingsBtn || !menuEl) return
      const r = settingsBtn.getBoundingClientRect()
      const left = Math.max(4, Math.min(r.left, window.innerWidth - menuEl.offsetWidth - 4))
      setMenuPos({ top: r.bottom + 4, left })
    })

    return (
      <th class="editable-col-head">
        <div class="col-head-row">
          <Show
            when={renaming()}
            fallback={
              <span class="col-name-label" title="Click to rename" onClick={() => setRenaming(true)}>
                {col.name}
              </span>
            }
          >
            <input
              class="col-name-input"
              value={col.name}
              ref={(el) => focusInput(el)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
              onBlur={(e) => commitRename(e.currentTarget.value)}
              onClick={(e) => e.stopPropagation()}
            />
          </Show>
          <div class="settings-wrap col-settings-wrap">
            <button
              class="settings-btn col-settings-btn"
              title="Column settings"
              aria-label="Column settings"
              ref={settingsBtn}
              onClick={(e) => {
                e.stopPropagation()
                setOpenColMenu(menuOpen() ? null : menuKey)
              }}
            >
              ⋯
            </button>
            <div
              class="settings-menu"
              classList={{ open: menuOpen() }}
              ref={menuEl}
              style={menuPos() ? { top: `${menuPos()!.top}px`, left: `${menuPos()!.left}px` } : undefined}
            >
              <label class="settings-row">
                Type
                <select
                  class="col-type-select"
                  onChange={(e) => store.setColumnType(table, col.name, e.currentTarget.value as ColumnType)}
                >
                  <For each={COLUMN_TYPES}>
                    {(t) => <option value={t} selected={t === col.type}>{t}</option>}
                  </For>
                  {/* Enum is code-only, not in COLUMN_TYPES — surface it so
                      the menu isn't mislabeled. */}
                  <Show when={col.type === 'enum'}>
                    <option value="enum" selected disabled>enum</option>
                  </Show>
                </select>
              </label>
              <button
                class="settings-row col-del-btn"
                onClick={() => store.removeColumn(table, col.name)}
              >
                Remove column
              </button>
            </div>
          </div>
        </div>
      </th>
    )
  }

  function AddColHeader(colProps: { table: string }) {
    const [adding, setAdding] = createSignal(false)
    let nameInput: HTMLInputElement | undefined
    let typeSel: HTMLSelectElement | undefined
    const commit = (): void => {
      const colName = nameInput?.value.trim()
      if (colName) store.addColumn(colProps.table, colName, (typeSel?.value ?? 'number') as ColumnType)
      setAdding(false)
    }
    return (
      <th class="add-col-head">
        <Show
          when={adding()}
          fallback={<button class="add-col-btn" onClick={() => setAdding(true)}>+ column</button>}
        >
          <input
            class="col-name-input new-col-name"
            placeholder="name"
            ref={(el) => { nameInput = el; focusInput(el, false) }}
            onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
          />
          <select class="col-type-select" ref={typeSel}>
            <For each={COLUMN_TYPES}>{(t) => <option value={t}>{t}</option>}</For>
          </select>
          <button class="col-confirm-btn" onClick={commit}>Add</button>
        </Show>
      </th>
    )
  }

  // One editable cell: click opens a typed editor in place; enums instead
  // show an always-live dropdown so a value is one pick away mid-performance.
  // Committing appends a set-cell event to the store — the edit *is* the
  // event. Values that don't fit the column type get a `cell-invalid` marker.
  // A cell whose column the row's event/type ignores gets `cell-inert`
  // (dimmed, but stays fully editable — see isCellInert in table-panel.ts).
  function EditableCell(cellProps: { table: string; rowIndex: number; col: EditableColumn }) {
    const { table, rowIndex, col } = cellProps
    const key = `${rowIndex}::${col.name}`
    const editing = () => editingCell() === key
    const row = () => editableData()?.data.rows[rowIndex]
    const raw = () => row()?.[col.name]
    const rowEvent = () => {
      const r = row()
      return typeof r?.event === 'string' ? r.event : typeof r?.type === 'string' ? r.type : undefined
    }
    const invalid = () => !cellValid(raw(), col, rowEvent())
    const inert = () => {
      const r = row()
      return r ? isCellInert(r, col, editableData()?.data.columns ?? []) : false
    }

    const commit = (value: unknown, viaBlur = false): void => {
      // Guard the Enter-then-blur double fire: only the open editor commits.
      if (editingCell() !== key) return
      // A blur while the focus guard is live is the async panel refresh, not
      // the user — leave the editor open (guardFocus restores focus).
      if (viaBlur && key === focusGuardKey) return
      store.setCell(table, rowIndex, col.name, value)
      setEditingCell(null)
    }

    const keyHandler = (e: KeyboardEvent, commitNow: () => void): void => {
      // preventDefault so the browser doesn't also shift focus and fight our
      // editor placement.
      if (e.key === 'Tab') {
        e.preventDefault()
        commitNow()
        advanceEdit(rowIndex, col.name, e.shiftKey ? -1 : 1)
        return
      }
      // Escape cancels the edit (the pending blur-commit no-ops once the editor
      // is closed) and returns to arrow-key navigation.
      if (e.key === 'Escape') {
        e.preventDefault()
        setEditingCell(null)
        queueMicrotask(refocusGrid)
        return
      }
      if (e.key === 'Enter') {
        commitNow()
        if (coarsePointer) advanceEdit(rowIndex, col.name, 1)
        else queueMicrotask(refocusGrid)
      }
      if (e.key === 'Enter' && e.ctrlKey && props.onCtrlEnter) props.onCtrlEnter()
    }

    // Collaborators whose last edit landed on this cell.
    const editors = () => lastEditors(presence(), table, rowIndex, col.name)
    // Only read for a code chip's tint; targetFor owns the language ladder.
    const cellLang = (): string => props.targetFor(table, rowIndex, col.name, String(raw() ?? '')).lang

    const focused = () => focusedCell()?.row === rowIndex && focusedCell()?.col === col.name

    return (
      <td
        class="editable-cell"
        classList={{ editing: editing(), 'cell-invalid': invalid(), 'cell-focused': focused(), 'cell-inert': inert() }}
        data-row={rowIndex}
        data-col={col.name}
        style={editors().length ? { outline: `2px solid ${editors()[0].color}`, 'outline-offset': '-2px' } : undefined}
        onClick={() => {
          setFocusedCell({ row: rowIndex, col: col.name })
          if (editing() || col.type === 'enum') return
          // "=" expression cells edit like code cells — in the roving editor —
          // never the coercing primitive editors.
          if (col.type === 'code' || isExprCellText(raw())) openCell(table, rowIndex, col)
          else setEditingCell(key)
        }}
      >
        <Show when={editors().length}>
          <span class="cell-presence"><PresenceNames peers={editors()} /></span>
        </Show>
        <Show when={col.type === 'enum'}>
          <select
            class="cell-enum"
            value={raw() == null ? '' : String(raw())}
            onChange={(e) => store.setCell(table, rowIndex, col.name, e.currentTarget.value)}
          >
            {/* A stray value not in the options still shows, flagged, until a
                valid pick. */}
            <Show when={invalid() && raw() != null && raw() !== ''}>
              <option value={String(raw())} selected>{String(raw())}</option>
            </Show>
            <option value="" />
            <For each={col.options ?? []}>
              {(o) => <option value={o} selected={o === raw()}>{o}</option>}
            </For>
          </select>
        </Show>
        <Show
          when={col.type !== 'enum' && editing()}
          fallback={
            <Show when={col.type !== 'enum'}>
              {/* A code cell is a chip tinted by its language — the same tint
                  its facade wears below the grid — and clicking it promotes
                  that facade rather than opening an inline input. */}
              <Show
                when={col.type === 'code'}
                fallback={<span class="cell-value">{formatEditableCell(col.type, raw())}</span>}
              >
                <span class="cell-value code-chip" data-lang={cellLang()}>
                  {formatEditableCell('code', raw())}
                </span>
              </Show>
            </Show>
          }
        >
          <Show when={col.type === 'boolean'}>
            <input
              type="checkbox"
              checked={!!raw()}
              ref={(el) => queueMicrotask(() => el.focus())}
              onChange={(e) => commit(e.currentTarget.checked)}
              onKeyDown={(e) => {
                // A checkbox commits on toggle — Tab advances, Enter/Escape
                // just close back to arrow-key navigation.
                if (e.key === 'Tab') {
                  e.preventDefault()
                  setEditingCell(null)
                  advanceEdit(rowIndex, col.name, e.shiftKey ? -1 : 1)
                } else if (e.key === 'Enter' || e.key === 'Escape') {
                  e.preventDefault()
                  setEditingCell(null)
                  queueMicrotask(refocusGrid)
                }
              }}
            />
          </Show>
          <Show when={col.type === 'number'}>
            {(() => {
              const cur = Number(raw()) || 0
              let num: HTMLInputElement | undefined
              const commitNum = (viaBlur = false): void => {
                if (!num) return
                const v = Number(num.value)
                commit(Number.isFinite(v) && num.value.trim() !== '' ? v : cur, viaBlur)
              }
              // type="text" (default inputmode — a decimal keypad has no "="
              // key) so a leading "=" is typable: it hands the cell straight
              // to expression editing (cell-target mode), spreadsheet muscle
              // memory.
              return (
                <input
                  type="text"
                  class="cell-number"
                  enterkeyhint={coarsePointer ? 'next' : undefined}
                  value={String(cur)}
                  ref={(el) => { num = el; focusInput(el) }}
                  onInput={(e) => {
                    const t = e.currentTarget.value
                    if (t.startsWith('=')) {
                      setEditingCell(null)
                      openCell(table, rowIndex, col, t)
                    }
                  }}
                  onKeyDown={(e) => keyHandler(e, commitNum)}
                  onBlur={() => commitNum(true)}
                />
              )
            })()}
          </Show>
          <Show when={col.type === 'string' || col.type === 'code'}>
            {(() => {
              let txt: HTMLInputElement | undefined
              // Commit directly rather than via blur(): a synchronous blur()
              // unmounts this input mid-flight, stranding focus before the
              // next cell can take it.
              const commitTxt = (viaBlur = false): void => { if (txt) commit(txt.value, viaBlur) }
              return (
                <input
                  type="text"
                  class="cell-text"
                  enterkeyhint={coarsePointer ? 'next' : undefined}
                  value={raw() == null ? '' : String(raw())}
                  ref={(el) => { txt = el; focusInput(el) }}
                  onKeyDown={(e) => keyHandler(e, commitTxt)}
                  onBlur={() => commitTxt(true)}
                />
              )
            })()}
          </Show>
        </Show>
      </td>
    )
  }

  // Which tables get the per-row ⓘ: the same "has a code-typed column" test the
  // facade stack uses, plus an `event` column, since the popover shows the
  // sketch compiled up to and including *this event* (the `code` table's
  // fragments have no such fold).
  const rowInfoTable = createMemo(() => {
    const cols = editableData()?.data.columns
    return !!cols && hasCodeColumn(cols) && cols.some((c) => c.name === 'event')
  })

  // Per-row info button: a popover showing the sketch compiled up to and
  // including this event — the table's name picks which fold. Mirrors
  // ColHeader's measured fixed-position popover.
  function RowInfo(rowProps: { table: string; rowIndex: number }) {
    const { table, rowIndex } = rowProps
    const infoKey = `${table}::${rowIndex}`
    const open = () => openInfoRow() === infoKey
    const [menuPos, setMenuPos] = createSignal<{ top: number; left: number } | null>(null)
    let infoBtn: HTMLButtonElement | undefined
    let popEl: HTMLDivElement | undefined

    // Recompute only while open; tick-gated so an edit to any earlier row
    // updates the shown code live.
    const code = createMemo(() => {
      tick(); views()
      if (!open()) return null
      const data = store.get(table)
      if (!data) return null
      return table === 'bauble' ? baubleCodeUpToRow(data.rows, rowIndex)
        : table === 'post' ? postCodeUpToRow(data.rows, rowIndex)
        : hydraCodeUpToRow(data.rows, rowIndex)
    })

    createEffect(() => {
      if (!open() || !infoBtn || !popEl) return
      // Depend on the code so remeasuring happens once it has content (height).
      code()
      const r = infoBtn.getBoundingClientRect()
      const left = Math.max(4, Math.min(r.left, window.innerWidth - popEl.offsetWidth - 4))
      // Flip above the button when it would overflow the viewport bottom.
      const h = popEl.offsetHeight
      const below = r.bottom + 4
      const top = below + h > window.innerHeight - 4 && r.top - h - 4 >= 4 ? r.top - h - 4 : below
      setMenuPos({ top, left })
    })

    return (
      <div class="settings-wrap row-info-wrap">
        <button
          class="row-info-btn"
          title="Compiled code at this event"
          aria-label="Compiled code at this event"
          ref={infoBtn}
          onClick={(e) => { e.stopPropagation(); setOpenInfoRow(open() ? null : infoKey) }}
        >
          ⓘ
        </button>
        <div
          class="settings-menu row-info-popover"
          classList={{ open: open() }}
          ref={popEl}
          style={menuPos() ? { top: `${menuPos()!.top}px`, left: `${menuPos()!.left}px` } : undefined}
        >
          <div class="row-info-title">Compiled code at this event</div>
          <Show
            when={code() != null}
            fallback={<div class="row-info-empty">No compiled sketch at this event yet.</div>}
          >
            <pre class="row-info-code">{code()}</pre>
          </Show>
        </div>
      </div>
    )
  }

  function Tab(tabProps: { name: string }) {
    const { name } = tabProps
    const [renaming, setRenaming] = createSignal(false)
    const editable = () => {
      tick()
      return store.has(name) && !store.isLog(name)
    }
    const commitRename = (value: string): void => {
      const v = value.trim()
      if (v && v !== name && store.renameTable(name, v) && untrack(current) === name) setCurrent(v)
      setRenaming(false)
    }
    const viewers = () => viewersOf(presence(), name)
    const ringStyle = () => tabRingStyle(presence(), name)

    return (
      <button
        class="table-tab"
        classList={{ 'table-tab-editable': editable(), 'tab-active': current() === name }}
        style={ringStyle() ? { 'box-shadow': ringStyle() } : undefined}
        title={editable() ? 'Double-click to rename' : undefined}
        onClick={() => setCurrent(name)}
        onDblClick={(e) => {
          if (!editable()) return
          e.stopPropagation()
          setRenaming(true)
        }}
      >
        <Show
          when={renaming()}
          fallback={
            <>
              <span class="tab-label">{name}</span>
              <Show when={viewers().length}>
                <span class="tab-presence"><PresenceNames peers={viewers()} /></span>
              </Show>
              <Show when={editable()}>
                <span
                  class="tab-del"
                  title="Delete table"
                  onClick={(e) => {
                    e.stopPropagation()
                    store.removeTable(name)
                    if (untrack(current) === name) setCurrent(null)
                  }}
                >
                  ×
                </span>
              </Show>
            </>
          }
        >
          <input
            class="tab-rename-input"
            value={name}
            ref={(el) => focusInput(el)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
            onBlur={(e) => commitRename(e.currentTarget.value)}
            onClick={(e) => e.stopPropagation()}
          />
        </Show>
      </button>
    )
  }

  // The "/"-opened table switcher: a filterable list of every tab, driven by
  // the keyboard (type to filter, ↑/↓ to move, Enter to pick, Escape to close).
  function TablePicker() {
    const [query, setQuery] = createSignal('')
    const [sel, setSel] = createSignal(0)
    const matches = createMemo(() => {
      const q = query().toLowerCase()
      return names().filter((n) => !q || n.toLowerCase().includes(q))
    })
    const close = (): void => { setPickerOpen(false); queueMicrotask(refocusGrid) }
    const choose = (name: string | undefined): void => {
      if (name) setCurrent(name)
      close()
    }
    return (
      <div
        class="table-picker"
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); close() }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, matches().length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)) }
          else if (e.key === 'Enter') { e.preventDefault(); choose(matches()[sel()]) }
        }}
      >
        <input
          class="table-picker-input"
          placeholder="Switch table…"
          ref={(el) => focusInput(el, false)}
          onInput={(e) => { setQuery(e.currentTarget.value); setSel(0) }}
        />
        <div class="table-picker-list">
          <For each={matches()}>
            {(n, i) => (
              <button
                class="table-picker-item"
                classList={{ 'picker-sel': i() === sel(), 'picker-current': n === current() }}
                onMouseEnter={() => setSel(i())}
                onClick={() => choose(n)}
              >
                {n}
              </button>
            )}
          </For>
          <Show when={!matches().length}>
            <div class="table-picker-empty">No tables</div>
          </Show>
        </div>
      </div>
    )
  }

  return (
    <>
      <div class="table-pane-header">
        <div class="table-pane-header-row">
          <div class="table-tabs">
            <For each={names()}>{(n) => <Tab name={n} />}</For>
          </div>
          {/* Mobile substitute for the tab strip — a native <select> is far
              easier to use with a thumb. */}
          <select class="table-tab-select" onChange={(e) => setCurrent(e.currentTarget.value)}>
            <For each={names()}>
              {(n) => <option value={n} selected={n === current()}>{n}</option>}
            </For>
          </select>
        </div>
        <div class="table-pane-header-row">
          <button
            class="table-tab-add"
            title="Add a new editable table"
            aria-label="Add a new editable table"
            onClick={() => {
              const name = nextTableName(untrack(views), store)
              store.createTable(name)
              setCurrent(name)
            }}
          >
            <Icon name="plus" />
          </button>
          <input
            class="table-filter"
            type="text"
            placeholder="filter…"
            onInput={(e) => setFilter(e.currentTarget.value.toLowerCase())}
          />
          <span class="table-count">{countText()}</span>
          <DocsPopover currentTable={current} />
          <div class="settings-wrap" ref={settingsWrap}>
            <button
              class="settings-btn"
              title="Settings"
              aria-label="Settings"
              ref={settingsBtn}
              onClick={(e) => {
                e.stopPropagation()
                const opening = !settingsOpen()
                if (opening && settingsBtn) {
                  const r = settingsBtn.getBoundingClientRect()
                  setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right })
                }
                setSettingsOpen(opening)
              }}
            >
              ⚙
            </button>
            <div
              class="settings-menu"
              classList={{ open: settingsOpen() }}
              style={{ top: `${menuPos().top}px`, right: `${menuPos().right}px` }}
            >
              <label class="settings-row">
                <input
                  type="checkbox"
                  checked={props.chrome.vimMode}
                  onChange={(e) => props.chrome.setVimMode(e.currentTarget.checked)}
                />
                Vim mode
              </label>
              <label class="settings-row">
                <input
                  type="checkbox"
                  checked={props.chrome.midiEnabled}
                  onChange={(e) => props.chrome.setMidiEnabled(e.currentTarget.checked)}
                />
                MIDI
              </label>
              <button
                class="settings-row settings-action"
                title="Fixes hydra visuals stuck in an error state (same fix as resizing the window)"
                onClick={() => { props.chrome.resetHydra(); setSettingsOpen(false) }}
              >
                Reset visuals
              </button>
              <button
                class="settings-row settings-action"
                title="Copy the current scene to the clipboard as an example you can paste into samples.ts"
                onClick={() => { props.chrome.exportScene(); setSettingsOpen(false) }}
              >
                Export scene
              </button>
              <button
                class="settings-row settings-action"
                title="Load a scene from the clipboard (exported from here, or a SAMPLES entry)"
                onClick={() => { props.chrome.importScene(); setSettingsOpen(false) }}
              >
                Import scene
              </button>
            </div>
          </div>
        </div>
      </div>
      {props.children}
      <div class="tab-content">
        <Show when={pickerOpen()}>
          <TablePicker />
        </Show>
        <Show when={isEditableTable()}>
          <div class="table-subtabs">
            <button
              class="table-subtab"
              classList={{ 'subtab-active': subView() === 'table' }}
              onClick={() => setSubView('table')}
            >
              Table
            </button>
            <button
              class="table-subtab"
              classList={{ 'subtab-active': subView() === 'events' }}
              onClick={() => setSubView('events')}
            >
              Events
            </button>
          </div>
        </Show>
        <Show when={chart()}>
          <div class="tab-graph" classList={{ 'graph-collapsed': graphCollapsed() }}>
            <div class="graph-header">
              <button
                class="collapse-btn"
                title={graphCollapsed() ? 'Expand graph' : 'Collapse graph'}
                aria-label={graphCollapsed() ? 'Expand graph' : 'Collapse graph'}
                onClick={() => setGraphCollapsed(!graphCollapsed())}
              >
                <Icon name={graphCollapsed() ? 'chevron-down' : 'chevron-up'} />
              </button>
              <span class="graph-title">Graph</span>
            </div>
            <div class="graph-legend">
              <For each={chart()!.cols}>
                {(c, ci) => (
                  <span class="graph-series">
                    <span class="graph-dot" style={{ background: SERIES_COLORS[ci() % SERIES_COLORS.length] }} />
                    {c}
                    <Show when={colRanges()?.[ci()]}>
                      {(range) => (
                        <span class="graph-range">{`${fmtNum(range().rawMin)}–${fmtNum(range().rawMax)}`}</span>
                      )}
                    </Show>
                  </span>
                )}
              </For>
            </div>
            <canvas class="tab-graph-canvas" ref={graphCanvas} />
          </div>
        </Show>
        <div
          class="tab-scroll"
          ref={scrollEl}
          tabindex={current() ? 0 : undefined}
          onKeyDown={onGridKeyDown}
          onScroll={() => { if (!suppressScrollEvent) props.setUserScrolled(true) }}
        >
          <table class="events-table">
            <Show
              when={editableData()}
              fallback={
                <>
                  <thead>
                    <Show when={roTable()?.length}>
                      <tr>
                        <For each={roCols()}>{(col) => <th>{col}</th>}</For>
                      </tr>
                    </Show>
                  </thead>
                  <tbody>
                    <Index each={shownRows()}>
                      {(row, i) => (
                        <tr
                          ref={(el) => { roRowEls[i] = el }}
                          hidden={!roRowVisible(i)}
                          classList={{
                            'row-active': i === activeIdx(),
                            'row-source': !!lineageSet()?.has(i),
                          }}
                        >
                          <For each={roCols()}>{(col) => <td>{formatCell(col, row()[col])}</td>}</For>
                        </tr>
                      )}
                    </Index>
                  </tbody>
                </>
              }
            >
              {(ed) => (
                <>
                  <thead>
                    <tr>
                      <th class="row-actions-head" />
                      <For each={ed().data.columns}>
                        {(col) => <ColHeader table={ed().name} col={col} />}
                      </For>
                      <AddColHeader table={ed().name} />
                    </tr>
                  </thead>
                  <tbody>
                    <For each={displayOrder(ed().data.rows, ed().data.columns)}>
                      {(i) => (
                        <tr
                          hidden={!edRowVisible(i)}
                          classList={{
                            'row-source': !!lineageSet()?.has(i),
                            // A boolean column named "disabled" is the row's
                            // own mute switch (see DISABLED_COL).
                            'row-disabled': ed().data.rows[i]?.[DISABLED_COL] === true,
                            'row-invalid': invalidColumns(ed().data.rows[i], ed().data.columns).length > 0,
                            'row-strip-active': props.stripRow()?.table === ed().name && props.stripRow()?.row === i,
                          }}
                        >
                          <td class="row-actions">
                            <Show when={rowInfoTable()}>
                              <RowInfo table={ed().name} rowIndex={i} />
                            </Show>
                            <button
                              class="row-dup-btn"
                              title="Duplicate row"
                              aria-label="Duplicate row"
                              onClick={() => store.duplicateRow(ed().name, i)}
                            >
                              ⧉
                            </button>
                            <button
                              class="row-del-btn"
                              title="Delete row"
                              aria-label="Delete row"
                              onClick={() => store.removeRow(ed().name, i)}
                            >
                              ×
                            </button>
                          </td>
                          <For each={ed().data.columns}>
                            {(col) => <EditableCell table={ed().name} rowIndex={i} col={col} />}
                          </For>
                          <td />
                        </tr>
                      )}
                    </For>
                  </tbody>
                </>
              )}
            </Show>
          </table>
        </div>
        <Show when={editableData()}>
          <div class="edit-toolbar" style={{ display: 'flex' }}>
            <button
              class="add-row-btn"
              onClick={() => store.addRow(editableData()!.name)}
            >
              + row
            </button>
          </div>
        </Show>
        {/* Bottom slot (capped and scrollable so it shares the pane's
            height with the chart above rather than fighting it). */}
        <div class="table-bottom-slot" ref={bottomEl}>
          <Show when={bottomSlot() === 'facades'}>
            <Index each={codeTargets()}>
              {(target) => (
                <CodeFacade
                  host={props.host}
                  target={target()}
                  onPromote={isMobile() ? setPopoverTarget : undefined}
                />
              )}
            </Index>
          </Show>
          <Show when={bottomSlot() === 'warp'}>
            <canvas class="warp-canvas" ref={warpCanvas} />
          </Show>
        </div>
        {/* Errors with no promoted target (a session load, a boot cook) — a
            promoted facade shows its own inline instead. */}
        <Show when={props.host.error('')}>
          {(msg) => <div class="editor-error">{msg()}</div>}
        </Show>
      </div>
      <Show when={exprCell()}>
        {(cell) => (
          <ExprOverlay
            host={props.host}
            target={cell().target}
            anchor={cell().anchor}
            onClose={() => setExprCell(null)}
          />
        )}
      </Show>
      <Show when={popoverTarget()}>
        {(target) => (
          <MobileEditorPopover host={props.host} target={target()} onClose={() => setPopoverTarget(null)} />
        )}
      </Show>
    </>
  )
}

// The pure-logic side handed to app.tsx — no DOM here; the view above is the
// only thing that touches elements.
export interface TablePanelController extends TablePanel, PanelProps {
  // Return keyboard focus to the table grid (see registerGridFocus).
  focusGrid(): void
  // Focus `row`'s first cell in the panel when `table` is the open tab, or
  // clear the focus (row === null) — wired from the timeline strip's handle
  // clicks and its background-click deselect.
  focusRow(table: string, row: number | null): void
  // The panel's current focus, table-scoped; null once focus leaves that
  // table (tab switch, or no focus yet). Consumed by the strip to ring the
  // matching handle.
  focusedRow: Accessor<{ table: string; row: number } | null>
  // Set by the strip while it points at a row — a hover over a handle or an
  // in-progress drag (null once the pointer leaves / the gesture ends) —
  // drives the grid's stronger .row-strip-active highlight.
  setStripRow(row: { table: string; row: number } | null): void
}

export function createTablePanel(
  editableStore: EditableTableStore,
  { targetFor, host, loopBeats, onCtrlEnter, onSelectTable }: TablePanelOptions,
): TablePanelController {
  const [views, setViews] = createSignal<Map<string, Table>>(new Map())
  const [graphs, setGraphs] = createSignal<Map<string, GraphSpec>>(new Map())
  const [current, setCurrent] = createSignal<string | null>(null)
  const [desiredTable, setDesiredTable] = createSignal<string | null>(null)
  const [playIndex, setPlayIndex] = createSignal(0)
  const [playActive, setPlayActive] = createSignal<Map<string, Set<number>> | null>(null)
  const [userScrolled, setUserScrolled] = createSignal(false)
  const [presence, setPresence] = createSignal<PeerPresence[]>([])
  // Set by the view once mounted; lets focusGrid pull focus back to the grid.
  let gridFocus: (() => void) | null = null
  // Set by the view once mounted; lets focusRow drive the panel's focused cell.
  let focusRowImpl: ((table: string, row: number | null) => void) | null = null
  const [focusedRow, setFocusedRow] = createSignal<{ table: string; row: number } | null>(null)
  const [stripRow, setStripRowSignal] = createSignal<{ table: string; row: number } | null>(null)

  return {
    store: editableStore,
    views,
    graphs,
    current,
    setCurrent,
    desiredTable,
    setDesiredTable,
    playIndex,
    playActive,
    userScrolled,
    setUserScrolled,
    presence,
    targetFor,
    host,
    loopBeats,
    onCtrlEnter,
    onSelectTable,
    registerGridFocus(fn: () => void): void {
      gridFocus = fn
    },
    focusGrid(): void {
      gridFocus?.()
    },
    registerFocusRow(fn: (table: string, row: number | null) => void): void {
      focusRowImpl = fn
    },
    reportFocusedRow(focus: { table: string; row: number } | null): void {
      setFocusedRow(focus)
    },
    focusRow(table: string, row: number | null): void {
      focusRowImpl?.(table, row)
    },
    focusedRow,
    stripRow,
    setStripRow(row: { table: string; row: number } | null): void {
      setStripRowSignal(row)
    },

    selectTable(name: string | null): void {
      if (name != null && (views().has(name) || editableStore.has(name)) && name !== current()) {
        setCurrent(name)
      }
    },
    restoreTable(name: string | null): void {
      setDesiredTable(name)
    },
    setTables(newStore: Map<string, Table>): void {
      setViews(newStore)
    },
    setGraphs(newSpecs: GraphSpec[] | null): void {
      const byName = new Map<string, GraphSpec>()
      for (const spec of newSpecs ?? []) {
        const name = spec.viewName ?? spec.table.name
        if (name) byName.set(name, spec)
      }
      setGraphs(byName)
    },
    highlightIndex(idx: number): void {
      setPlayIndex(idx)
    },
    highlightLineage(active: Map<string, Set<number>> | null): void {
      setPlayActive(active)
    },
    resetAutoscroll(): void {
      setUserScrolled(false)
    },
    setPresence(peers: PeerPresence[]): void {
      setPresence(peers)
    },
  }
}

export function TablePane(props: {
  ctl: TablePanelController
  chrome: PanelChrome
  children?: JSX.Element
  ref?: (el: HTMLDivElement) => void
}) {
  return (
    <div id="table-pane" ref={props.ref}>
      <TablePanelView {...props.ctl} chrome={props.chrome}>{props.children}</TablePanelView>
    </div>
  )
}
