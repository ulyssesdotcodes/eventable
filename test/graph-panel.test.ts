// Tests for graph-panel's pure chart logic — the layer shared by the table
// panel's big graph, the hover preview's sparklines, and chartFor's
// auto-charting. (drawSeriesChart itself is canvas and stays untested; every
// decision it renders is computed here.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  numericColumns, beatXOf, computeColRanges,
  xTicks, tickDecimals, fmtNum, resolveSpec, pivotChannels, TIMELINE_CHART_STYLE,
} from '../src/graph-panel.js'
import { Table } from '../src/dsl.js'
import type { Row } from '../src/lineage.js'

test('numericColumns: numeric somewhere, and never the beat x-axis column', () => {
  const rows: Row[] = [
    { beat: 1, x: 1, label: 'a', maybe: null },
    { beat: 2, x: 2, label: 'b', maybe: 5 },
  ]
  assert.deepEqual(numericColumns(rows, ['beat', 'x', 'label', 'maybe']), ['x', 'maybe'])
  assert.deepEqual(numericColumns([], ['x']), [])
})

test('beatXOf plots against beat when present, else the row ordinal', () => {
  const withBeat = beatXOf(['beat', 'x'])
  assert.equal(withBeat.hasIndex, true)
  assert.equal(withBeat.xOf({ beat: 7 }, 3), 7)
  const without = beatXOf(['x'])
  assert.equal(without.hasIndex, false)
  assert.equal(without.xOf({ x: 9 }, 3), 3)
})

test('resolveSpec: explicit columns are numeric-filtered; default is every plottable column', () => {
  const rows: Row[] = [{ beat: 1, x: 1, y: 2, label: 'a' }]
  const t = new Table(rows)
  const explicit = resolveSpec({ table: t, columns: ['y', 'label'] })
  assert.deepEqual(explicit.cols, ['y'], 'non-numeric explicit columns have nothing to plot')
  const auto = resolveSpec({ table: t, columns: [] })
  assert.deepEqual(auto.cols, ['x', 'y'])
  assert.equal(auto.hasIndex, true)
})

test('computeColRanges: per-series raw ranges plus optional padding', () => {
  const rows: Row[] = [{ a: -2, b: 3 }, { a: 6, b: 3 }, { a: 0, b: 3 }]
  const [a, b] = computeColRanges(rows, ['a', 'b'], 0)
  assert.deepEqual(a, { rawMin: -2, rawMax: 6, min: -2, max: 6 })
  assert.deepEqual(b, { rawMin: 2, rawMax: 4, min: 2, max: 4 }, 'a constant column widens by ±1 so it stays drawable')

  const [padded] = computeColRanges(rows, ['a'], 0.08)
  assert.deepEqual([padded.rawMin, padded.rawMax], [-2, 6], 'raw range is unpadded for the legend')
  assert.ok(Math.abs(padded.min - (-2 - 8 * 0.08)) < 1e-9)
  assert.ok(Math.abs(padded.max - (6 + 8 * 0.08)) < 1e-9)
})

test('xTicks picks nice steps across magnitudes', () => {
  assert.deepEqual(xTicks(0, 10, 4), [0, 2, 4, 6, 8, 10])
  assert.deepEqual(xTicks(0, 1, 4), [0, 0.2, 0.4, 0.6, 0.8, 1])
  assert.deepEqual(xTicks(5, 5, 4), [5], 'zero span: the single value')
  assert.deepEqual(xTicks(-3, 3, 4), [-2, 0, 2], 'ticks snap to step multiples, not the extents')
  assert.deepEqual(xTicks(0, 1000, 4), [0, 200, 400, 600, 800, 1000])
})

test('xTicks: a zero (or negative) targetCount means no axis — TIMELINE_CHART_STYLE\'s sentinel', () => {
  assert.deepEqual(xTicks(0, 8, 0), [])
  assert.deepEqual(xTicks(5, 5, 0), [], 'even the zero-span single-tick case is suppressed')
  assert.equal(TIMELINE_CHART_STYLE.tickTarget, 0)
})

test('xTicks steps survive float accumulation (0.1-scale steps stay exact)', () => {
  for (const t of xTicks(0, 0.4, 4)) {
    assert.equal(t, parseFloat(t.toFixed(10)), `tick ${t} carries float noise`)
  }
})

test('tickDecimals matches the step size', () => {
  assert.equal(tickDecimals([0, 2, 4]), 0)
  assert.equal(tickDecimals([0, 0.2, 0.4]), 1)
  assert.equal(tickDecimals([0, 0.05]), 2)
  assert.equal(tickDecimals([5]), 0, 'single tick: no decimals')
})

test('pivotChannels: long-format {id,value,beat} rows become one column per id, holes elsewhere', () => {
  const rows: Row[] = [
    { id: 'a', value: 1, beat: 1 },
    { id: 'b', value: 2, beat: 2 },
    { id: 'a', value: 3, beat: 3 },
  ]
  const { rows: pivoted, cols } = pivotChannels(rows, { idCol: 'id', valueCol: 'value' })
  assert.deepEqual(cols, ['a', 'b'], 'column order is first-seen id order')
  assert.deepEqual(pivoted, [
    { beat: 1, a: 1 },
    { beat: 2, b: 2 },
    { beat: 3, a: 3 },
  ], 'each row carries only its own id\'s column — the other column is a hole')
  assert.deepEqual(pivotChannels([{ value: 1, beat: 1 }], { idCol: 'id', valueCol: 'value' }), { rows: [], cols: [] }, 'a blank id contributes nothing')
})

test('fmtNum: integers plain, precision scales down as magnitude grows', () => {
  assert.equal(fmtNum(3), '3')
  assert.equal(fmtNum(3.00000000001), '3')
  assert.equal(fmtNum(12.345), '12.3')
  assert.equal(fmtNum(1.2345), '1.23')
  assert.equal(fmtNum(0.12345), '0.123')
  assert.equal(fmtNum(-12.345), '-12.3')
})
