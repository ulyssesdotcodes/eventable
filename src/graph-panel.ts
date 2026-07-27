// Chart logic + the shared 2D series renderer. The table panel's big graph and
// the hover preview's sparklines are the *same* renderer (drawSeriesChart) with
// different styles, so plottability / x-axis / y-range rules can't drift between
// surfaces. Range computation is deliberately a pure pre-step (computeColRanges)
// so legends can reuse the numbers without a second scan.

import type { Table } from './dsl.js'
import type { Row } from './lineage.js'

export const SERIES_COLORS = [
  '#4a9eff', '#ff6b6b', '#51cf66', '#ffd43b', '#cc5de8', '#ff922b', '#22d3ee',
]

const PLAYHEAD_COLOR = '#e94560'
const ACTIVE_ROW_COLOR = '#e9a23b'
const TICK_LABEL_COLOR = '#607a96'

export interface GraphSpec {
  table: Table
  columns: string[]
  viewName?: string | null
  name?: string
}

export interface ResolvedSpec {
  rows: Row[]
  cols: string[]
  xOf: (row: Row, i: number) => number
  hasIndex: boolean
}

export interface ChartData {
  rows: Row[]
  cols: string[]
  xOf: (row: Row, i: number) => number
  hasIndex: boolean
  xMin: number
  xMax: number
  name: string
}

export interface ColRange {
  rawMin: number
  rawMax: number
  min: number
  max: number
}

function isNumericColumn(rows: Row[], col: string): boolean {
  return rows.some((r) => typeof r[col] === 'number')
}

// The one "what counts as plottable" rule: a column charts when it holds a
// number somewhere and isn't the `beat` x-axis column.
export function numericColumns(rows: Row[], cols: string[]): string[] {
  return cols.filter((c) => c !== 'beat' && isNumericColumn(rows, c))
}

// Plot against `beat` when the table has one, else against row ordinal.
export function beatXOf(columns: string[]): { hasIndex: boolean; xOf: (row: Row, i: number) => number } {
  const hasIndex = columns.includes('beat')
  return { hasIndex, xOf: (row, i) => (hasIndex ? (row.beat as number) : i) }
}

export function xExtent(rows: Row[], xOf: (row: Row, i: number) => number): { xMin: number; xMax: number } {
  let xMin = Infinity, xMax = -Infinity
  rows.forEach((row, i) => {
    const x = xOf(row, i)
    if (x < xMin) xMin = x
    if (x > xMax) xMax = x
  })
  return { xMin, xMax }
}

export function resolveSpec(spec: GraphSpec): ResolvedSpec {
  const rows = spec.table.rows
  const allCols = spec.table.columns
  // Explicit .graph() columns win (minus non-numeric ones); default is every
  // plottable column.
  const cols = spec.columns.length
    ? spec.columns.filter((c) => isNumericColumn(rows, c))
    : numericColumns(rows, allCols)
  const { hasIndex, xOf } = beatXOf(allCols)
  return { rows, cols, xOf, hasIndex }
}

// Long-format log rows ({id, value, beat} — a slider move, a midi note/cc, a
// setVariable keyframe) pivoted to wide format: one Row per input row,
// carrying only its own id's column, `cols` in first-seen order. Feed the
// result straight to chartDataFor(rows, ['beat', ...cols], cols, name) —
// drawSeriesChart already skips a column's non-numeric (missing) entries and
// never resets its `started` flag, so gaps between one id's points draw as a
// connecting line rather than a break, which is what a keyframe track wants.
export function pivotChannels(rows: Row[], { idCol, valueCol }: { idCol: string; valueCol: string }): { rows: Row[]; cols: string[] } {
  const cols: string[] = []
  const seen = new Set<string>()
  const out: Row[] = rows.flatMap((row) => {
    const id = row[idCol]
    if (id == null) return []
    const key = String(id)
    if (!seen.has(key)) { seen.add(key); cols.push(key) }
    return [{ beat: row.beat, [key]: row[valueCol] }]
  })
  return { rows: out, cols }
}

export function chartDataFor(rows: Row[], columns: string[], cols: string[], name: string): ChartData | null {
  if (!rows.length || !cols.length) return null
  const { hasIndex, xOf } = beatXOf(columns)
  const { xMin, xMax } = xExtent(rows, xOf)
  return { rows, cols, xOf, hasIndex, xMin, xMax, name }
}

export function xTicks(xMin: number, xMax: number, targetCount: number = 4): number[] {
  if (!(targetCount > 0)) return [] // 0 is TIMELINE_CHART_STYLE's "no axis" sentinel
  const span = xMax - xMin
  if (span === 0) return [xMin]
  const rough = span / targetCount
  const mag = Math.pow(10, Math.floor(Math.log10(rough)))
  const norm = rough / mag
  const step = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag
  const start = Math.ceil(xMin / step) * step
  const ticks: number[] = []
  for (let t = start; t <= xMax + step * 0.01; t = parseFloat((t + step).toFixed(10)))
    ticks.push(t)
  return ticks
}

export function tickDecimals(ticks: number[]): number {
  if (ticks.length < 2) return 0
  const step = Math.abs(ticks[1] - ticks[0])
  return step >= 1 ? 0 : step >= 0.1 ? 1 : 2
}

export function fmtNum(v: number): string {
  if (Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v))
  const abs = Math.abs(v)
  return v.toFixed(abs >= 10 ? 1 : abs >= 1 ? 2 : 3)
}

// Each series is scaled independently so columns of very different magnitudes
// all show their shape. `yPadFrac` adds breathing room (sparklines pass 0);
// degenerate ranges widen to something drawable.
export function computeColRanges(rows: Row[], cols: string[], yPadFrac: number): ColRange[] {
  return cols.map((c) => {
    let rawMin = Infinity, rawMax = -Infinity
    for (const row of rows) {
      const v = row[c]
      if (typeof v === 'number') {
        if (v < rawMin) rawMin = v
        if (v > rawMax) rawMax = v
      }
    }
    if (!isFinite(rawMin)) { rawMin = -1; rawMax = 1 }
    if (rawMin === rawMax) { rawMin -= 1; rawMax += 1 }
    const yPad = (rawMax - rawMin) * yPadFrac
    return { rawMin, rawMax, min: rawMin - yPad, max: rawMax + yPad }
  })
}

export interface SeriesChartStyle {
  pad: { l: number; r: number; t: number; b: number }
  lineWidth: number
  tickFont: string
  tickTarget: number
  yPadFrac: number
}

export const PANEL_CHART_STYLE: SeriesChartStyle = {
  pad: { l: 6, r: 6, t: 8, b: 18 },
  lineWidth: 1.5,
  tickFont: '9px system-ui',
  tickTarget: 4,
  yPadFrac: 0.08,
}

export const SPARKLINE_STYLE: SeriesChartStyle = {
  pad: { l: 3, r: 3, t: 3, b: 14 },
  lineWidth: 1.25,
  tickFont: '8px system-ui',
  tickTarget: 3,
  yPadFrac: 0,
}

// A timeline-pane section band: flush against the shared TimelineAxis drawn
// once above the whole section list, so no padding and no per-section ticks
// (tickTarget 0 — see xTicks) — beatToX's own 1..maxBeats+1 axis is what lines
// the sections up, not each chart's own.
export const TIMELINE_CHART_STYLE: SeriesChartStyle = {
  pad: { l: 0, r: 0, t: 3, b: 3 },
  lineWidth: 1.5,
  tickFont: '9px system-ui',
  tickTarget: 0,
  yPadFrac: 0.08,
}

export interface DrawSeriesChartOptions {
  style?: SeriesChartStyle
  // Fixed CSS size (sparklines paint before layout); default is the canvas's
  // laid-out size.
  size?: { w: number; h: number }
  // Playhead beat — a vertical line when it falls inside the plot.
  playIndex?: number | null
  // Storage ordinals of the playhead's active-lineage rows, dotted per series.
  activeRows?: Set<number> | null
}

// The one multi-series line renderer. Every series gets its own y scale from
// the caller-computed `ranges`, which must be parallel to data.cols. Returns
// false when the canvas has no drawable area yet.
export function drawSeriesChart(
  canvas: HTMLCanvasElement,
  data: ChartData,
  ranges: ColRange[],
  { style = PANEL_CHART_STYLE, size, playIndex = null, activeRows = null }: DrawSeriesChartOptions = {},
): boolean {
  const { rows, cols, xOf, hasIndex, xMin, xMax } = data
  const g = canvas.getContext('2d')
  if (!g) return false
  const dpr = window.devicePixelRatio || 1
  const w = size ? size.w : canvas.clientWidth
  const h = size ? size.h : canvas.clientHeight
  if (w === 0 || h === 0) return false
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  if (size) {
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, h)

  const { pad, lineWidth, tickFont, tickTarget } = style
  const plotW = w - pad.l - pad.r
  const plotH = h - pad.t - pad.b

  const xSpan = xMax - xMin || 1
  const px = (x: number): number => pad.l + ((x - xMin) / xSpan) * plotW

  const seriesPy = ranges.map(({ min, max }) => {
    const yRange = max - min
    return (v: number): number => pad.t + (1 - (v - min) / yRange) * plotH
  })

  cols.forEach((c, ci) => {
    const py = seriesPy[ci]
    const { min, max } = ranges[ci]

    if (min < 0 && max > 0) {
      g.strokeStyle = SERIES_COLORS[ci % SERIES_COLORS.length] + '44'
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(pad.l, py(0))
      g.lineTo(w - pad.r, py(0))
      g.stroke()
    }

    g.strokeStyle = SERIES_COLORS[ci % SERIES_COLORS.length]
    g.lineWidth = lineWidth
    g.beginPath()
    let started = false
    rows.forEach((row, i) => {
      const v = row[c]
      if (typeof v !== 'number') return
      const X = px(xOf(row, i))
      const Y = py(v)
      if (!started) { g.moveTo(X, Y); started = true }
      else g.lineTo(X, Y)
    })
    g.stroke()
  })

  if (activeRows) {
    g.fillStyle = ACTIVE_ROW_COLOR
    for (const ordinal of activeRows) {
      const row = rows[ordinal]
      if (!row) continue
      cols.forEach((c, ci) => {
        const v = row[c]
        if (typeof v !== 'number') return
        g.beginPath()
        g.arc(px(xOf(row, ordinal)), seriesPy[ci](v), 3.5, 0, Math.PI * 2)
        g.fill()
      })
    }
  }

  if (playIndex != null) {
    const cx = px(playIndex)
    if (cx >= pad.l - 0.5 && cx <= w - pad.r + 0.5) {
      g.strokeStyle = PLAYHEAD_COLOR
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(cx, pad.t)
      g.lineTo(cx, h - pad.b)
      g.stroke()
    }
  }

  const ticks = xTicks(xMin, xMax, tickTarget)
  const dec = tickDecimals(ticks)
  const suffix = hasIndex ? ' b' : '' // 'b' = beats
  g.fillStyle = TICK_LABEL_COLOR
  g.font = tickFont
  g.textBaseline = 'top'
  ticks.forEach((t, i) => {
    const x = px(t)
    if (x < pad.l - 2 || x > w - pad.r + 2) return
    g.textAlign = i === 0 ? 'left' : i === ticks.length - 1 ? 'right' : 'center'
    g.fillText(t.toFixed(dec) + suffix, x, h - pad.b + 3)
  })

  return true
}
