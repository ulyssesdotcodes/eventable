import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sliderDef, sliderDefs, buildSliderIndex, sampleSliderAt,
  currentSliderRows, createSliderInput,
} from '../src/sliders.js'
import { frameToBeat, beatToFrame } from '../src/constants.js'
import { createEditableTableStore } from '../src/editable-tables.js'
import type { Row } from '../src/lineage.js'
import type { LogStore, StampedEvent } from '../src/event-log.js'

const b = (frame: number): number => frameToBeat(frame)

// In-memory stand-in for the editable-table store the app backs sliders with.
function fakeStore(): LogStore {
  const events: StampedEvent[] = []
  let seq = 0
  const listeners: (() => void)[] = []
  return {
    record(kind: string, payload: Record<string, unknown> = {}): void {
      events.push({ kind, table: 'slider', seq: seq++, t: 0, ...payload })
      listeners.forEach((f) => f())
    },
    events: () => events.slice(),
    onChange: (cb: () => void) => { listeners.push(cb) },
  }
}

test('sliderDef parses id/min/max/default and clamps the default into range', () => {
  const d = sliderDef({ name: 'x', min: 0, max: 10 })!
  assert.deepEqual({ id: d.id, min: d.min, max: d.max, default: d.default }, { id: 'x', min: 0, max: 10, default: 0 })
  assert.equal(sliderDef({ name: 'x', min: 0, max: 10, default: 5 })!.default, 5)
  assert.equal(sliderDef({ name: 'x', min: 0, max: 10, default: 99 })!.default, 10, 'clamped to max')
  assert.equal(sliderDef({ name: 'x', min: -1, max: 1, default: -9 })!.default, -1, 'clamped to min')
  const y = sliderDef({ name: 'y' })!
  assert.deepEqual({ min: y.min, max: y.max, default: y.default }, { min: 0, max: 1, default: 0 }, 'min/max default to 0/1, default to min')
  assert.equal(sliderDef({ min: 0, max: 1 }), null, 'no name → null')
})

test('sliderDef takes an explicit step and defaults to a fine continuous one', () => {
  assert.equal(sliderDef({ name: 'n', min: 0, max: 10, step: 1 })!.step, 1, 'explicit integer step')
  const step = sliderDef({ name: 'f', min: 0, max: 1 })!.step
  assert.ok(step > 0 && step <= 0.01, 'fine default, not quantized to 1')
})

test('a hand-created "sliders" table (table panel, no code) yields slider defs', () => {
  // Reproduces "+ table" in the panel: a table named "sliders" that the program
  // never references, so the cook never surfaces it as a view. main.ts falls
  // back to editableStore.get("sliders").rows — this checks that path parses.
  const store = createEditableTableStore()
  store.createTable('sliders') // seeded with a "beat" column
  store.addColumn('sliders', 'name', 'string')
  store.addColumn('sliders', 'min', 'number')
  store.addColumn('sliders', 'max', 'number')
  store.addRow('sliders')
  store.setCell('sliders', 0, 'name', 'brightness')
  store.setCell('sliders', 0, 'min', 0)
  store.setCell('sliders', 0, 'max', 1)

  const defs = sliderDefs(store.get('sliders')!.rows)
  assert.equal(defs.length, 1)
  assert.deepEqual(
    { id: defs[0].id, min: defs[0].min, max: defs[0].max, default: defs[0].default },
    { id: 'brightness', min: 0, max: 1, default: 0 },
  )
})

test('sliderDefs keeps one def per id, last row wins', () => {
  const defs = sliderDefs([
    { name: 'a', min: 0, max: 1 },
    { name: 'a', min: 0, max: 5 },
    { name: 'b', min: 0, max: 1 },
    { min: 0, max: 1 }, // no name — dropped
  ])
  assert.equal(defs.length, 2)
  assert.equal(defs.find((d) => d.id === 'a')!.max, 5)
})

test('sampleSliderAt returns the most recent value at-or-before the frame', () => {
  const rows: Row[] = [
    { type: 'slider', id: 'brightness', value: 1, beat: b(60) },
    { type: 'slider', id: 'brightness', value: 0, beat: b(120) },
  ]
  const idx = buildSliderIndex(rows)
  assert.equal(sampleSliderAt(idx, 'brightness', 60, 0.5), 1, 'at the move frame')
  assert.equal(sampleSliderAt(idx, 'brightness', 119, 0.5), 1, 'still held')
  assert.equal(sampleSliderAt(idx, 'brightness', 120, 0.5), 0, 'after the second move')
  assert.equal(sampleSliderAt(idx, 'brightness', 999, 0.5), 0, 'holds the last move')
})

test('before the first move, sampleSliderAt jumps to the first recorded value (loop start)', () => {
  // At the loop top the slider must sit at the FIRST value, not carry over the
  // loop-end value.
  const rows: Row[] = [
    { type: 'slider', id: 'x', value: 1, beat: b(60) },
    { type: 'slider', id: 'x', value: 0, beat: b(120) },
  ]
  const idx = buildSliderIndex(rows)
  assert.equal(sampleSliderAt(idx, 'x', 0, 0.2), 1, 'loop top: jumps to the first value')
  assert.equal(sampleSliderAt(idx, 'x', 59, 0.2), 1, 'still the first value just before it')
  assert.equal(sampleSliderAt(idx, 'x', 60, 0.2), 1, 'at the first move')
})

test('currentSliderRows folds per id, dedupes one row per frame', () => {
  const events: StampedEvent[] = [
    { seq: 0, t: 0, kind: 'slider', id: 'x', value: 0.1, beat: 2, loop: 0 },
    { seq: 1, t: 0, kind: 'slider', id: 'x', value: 0.9, beat: 2, loop: 0 }, // same frame → replaces
    { seq: 2, t: 0, kind: 'slider', id: 'y', value: 0.5, beat: 3, loop: 0 },
  ]
  const rows = currentSliderRows(events)
  const x = rows.filter((r) => r.id === 'x')
  assert.equal(x.length, 1, 'burst at one frame collapses')
  assert.equal(x[0].value, 0.9, 'last write wins')
  assert.equal(rows.filter((r) => r.id === 'y').length, 1)
})

test('a fresh take (clearId then record) replaces the old one; untouched sliders carry forward', () => {
  let src = 1
  const input = createSliderInput({ store: fakeStore(), getIndex: () => src })

  src = 2; input.set('a', 0.1)
  src = 3; input.set('b', 0.2)
  input.clearId('a')
  src = 1.5; input.set('a', 0.7)

  const rows = input.rows()
  const a = rows.filter((r) => r.id === 'a')
  const bb = rows.filter((r) => r.id === 'b')
  assert.equal(a.length, 1, 'the cleared a take is gone; only the new one is current')
  assert.equal(a[0].beat, 1.5)
  assert.equal(a[0].value, 0.7)
  assert.equal(bb.length, 1, 'b was never grabbed — it carries forward')
})

test('createSliderInput stamps moves at the source position and samples them', () => {
  let src = 1
  const input = createSliderInput({ store: fakeStore(), getIndex: () => src })
  input.setDefs([{ id: 'x', min: 0, max: 1, default: 0.2, step: 0.01 }])

  assert.equal(input.ctxAt(60).slider!('x'), 0.2, 'the default before any move')

  src = b(60); input.set('x', 0.8)
  src = b(120); input.set('x', 0.2)

  assert.equal(input.rows().length, 2)
  assert.equal(input.ctxAt(60).slider!('x'), 0.8, 'first move')
  assert.equal(input.ctxAt(119).slider!('x'), 0.8, 'held')
  assert.equal(input.ctxAt(120).slider!('x'), 0.2, 'second move')
  assert.equal(input.ctxAt(0).slider!('x'), 0.8, 'before the first move: jumps to the first value')
  assert.deepEqual(input.valuesAt(60), { x: 0.8 }, 'valuesAt maps every defined id')
})

test('an open recording window holds the live hand, then replays the take once a cycle completes', () => {
  let src = 5 // beats — getIndex and recordTick share the beat unit
  const input = createSliderInput({ store: fakeStore(), getIndex: () => src })
  input.setDefs([{ id: 'x', min: 0, max: 1, default: 0.2, step: 0.01 }])

  src = 5; input.beginRecord('x'); input.setLive('x', 0.8)
  assert.equal(input.recording('x'), true)
  // Record without playback: while the window is open the value is the live
  // hand everywhere, not a sample of the (incomplete) take.
  assert.equal(input.ctxAt(beatToFrame(1)).slider!('x'), 0.8, 'live value before the grab beat')
  assert.equal(input.valuesAt(beatToFrame(3)).x, 0.8, 'live value past the grab beat')

  // Release: no more moves, but the window stays open and keeps holding 0.8.
  input.recordTick(6); input.recordTick(8)
  assert.equal(input.recording('x'), true, 'release does not close the window')
  input.recordTick(2) // wrapped past the loop seam
  assert.equal(input.recording('x'), true, 'still open before returning to the grab beat')
  input.recordTick(5) // back at the grab beat, one full cycle later
  assert.equal(input.recording('x'), false, 'the window closes one cycle after the grab')
  assert.equal(input.ctxAt(beatToFrame(1)).slider!('x'), 0.8, 'the take replays')
})

test('a motion across the loop seam is captured as one continuous take', () => {
  let src = 7 // beats
  const input = createSliderInput({ store: fakeStore(), getIndex: () => src })
  input.setDefs([{ id: 'x', min: 0, max: 1, default: 0.1, step: 0.01 }])

  // Grab near the loop end and sweep past the seam into the next cycle.
  src = 7; input.beginRecord('x'); input.setLive('x', 0.2); input.recordTick(7)
  src = 8; input.setLive('x', 0.4); input.recordTick(8)
  src = 1; input.setLive('x', 0.6); input.recordTick(1)
  src = 2; input.setLive('x', 0.8); input.recordTick(2)
  // Sweep the rest of the cycle back to the grab beat to close the window.
  input.recordTick(4); input.recordTick(6); input.recordTick(7)
  assert.equal(input.recording('x'), false)

  assert.equal(input.ctxAt(beatToFrame(7)).slider!('x'), 0.2, 'the take spans the seam: beat 7')
  assert.equal(input.ctxAt(beatToFrame(8)).slider!('x'), 0.4, 'beat 8')
  assert.equal(input.ctxAt(beatToFrame(1)).slider!('x'), 0.6, 'beat 1, after the seam')
  assert.equal(input.ctxAt(beatToFrame(2)).slider!('x'), 0.8, 'beat 2')
})

test('clearId only affects the named slider; sliders() covers all defined ids', () => {
  let src = b(60)
  const input = createSliderInput({ store: fakeStore(), getIndex: () => src })
  input.setDefs([
    { id: 'a', min: 0, max: 1, default: 0.1, step: 0.01 },
    { id: 'b', min: 0, max: 1, default: 0.2, step: 0.01 },
  ])
  input.set('a', 0.9)
  input.set('b', 0.8)
  input.clearId('a')

  const values = input.ctxAt(60).sliders!()
  assert.equal(values.a, 0.1, 'a fell back to its default after the clear')
  assert.equal(values.b, 0.8, 'b is untouched')
})

test('clear() empties the whole fold', () => {
  const input = createSliderInput({ store: fakeStore(), getIndex: () => 1 })
  input.set('x', 0.5)
  assert.equal(input.rows().length, 1)
  input.clear()
  assert.equal(input.rows().length, 0)
})

test('the fold is deterministic over a shared event list (multiplayer/session replay)', () => {
  const events: StampedEvent[] = [
    { seq: 0, t: 0, kind: 'slider', id: 'x', value: 0.3, beat: b(30) },
    { seq: 1, t: 0, kind: 'slider', id: 'x', value: 0.7, beat: b(90) },
    { seq: 2, t: 0, kind: 'clear', id: 'x' },
    { seq: 3, t: 0, kind: 'slider', id: 'x', value: 0.5, beat: b(60) },
  ]
  const a = currentSliderRows(events)
  const b2 = currentSliderRows(events.map((e) => ({ ...e })))
  assert.deepEqual(a, b2)
  assert.equal(a.length, 1, 'only the post-clear take survives')
  assert.equal(a[0].value, 0.5)
})
