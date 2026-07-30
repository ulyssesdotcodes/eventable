import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  Table, field, idx, midi, slider, time, loop, isBinding, isStreamingNode, resolveBindings, type Expr,
} from '../src/dsl.js'
import { rasterizeRows } from '../src/rasterize.js'
import { buildMidiIndex, sampleMidiAt, midiRow, decodeMidi } from '../src/midi.js'
import { buildHydraIndex, hydraFrameAt } from '../src/hydra.js'
import { frameToBeat } from '../src/constants.js'
import type { Row } from '../src/lineage.js'

const t = (rows: Row[]): Table => new Table(rows)
const b = (frame: number): number => frameToBeat(frame)
const nodeOf = (e: Expr): import('../src/dsl.js').ExprNode => e.node

test('isStreamingNode is true for any expression containing midi()', () => {
  assert.equal(isStreamingNode(nodeOf(field('a').add(1))), false)
  assert.equal(isStreamingNode(nodeOf(midi('c4'))), true)
  assert.equal(isStreamingNode(nodeOf(midi('c4').mul(2))), true)
  assert.equal(isStreamingNode(nodeOf(field('base').add(midi('c4')))), true)
})

test('derive(slider) leaves a per-frame binding; resolveBindings reads ctx.slider', () => {
  const row = t([{ id: 'a' }]).derive({ py: slider('height') }).rows[0]
  assert.ok(isBinding(row.py), 'a streaming slider value is deferred')
  const resolved = resolveBindings(row, { slider: () => 0.4 })
  assert.equal(resolved.py, 0.4)
})

// ── time(): the playback clock as a streaming source ────────────────────────

test('derive(time) leaves a per-frame binding; resolveBindings reads ctx.time', () => {
  const row = t([{ id: 'a' }]).derive({ ry: time().mul(0.5) }).rows[0]
  assert.ok(isBinding(row.ry), 'the playback clock is deferred to frame time')
  assert.equal(isStreamingNode(nodeOf(time())), true)
  assert.equal(resolveBindings(row, { time: () => 3 }).ry, 1.5)
})

// ── loop(): the whole-loop counter as a streaming source ────────────────────

test('derive(loop) leaves a per-frame binding; resolveBindings reads ctx.loop', () => {
  const row = t([{ id: 'a' }]).derive({ n: loop() }).rows[0]
  assert.ok(isBinding(row.n), 'the loop counter is deferred to frame time')
  assert.equal(isStreamingNode(nodeOf(loop())), true)
  assert.equal(resolveBindings(row, { loop: () => 3 }).n, 3)
})

test('derive with a constant Expr bakes immediately (no binding)', () => {
  const row = t([{ a: 2 }]).derive({ b: field('a').mul(3) }).rows[0]
  assert.equal(row.b, 6)
  assert.ok(!isBinding(row.b))
})

test('a midi value composes with row fields, resolved at frame time', () => {
  const row = t([{ base: 10 }]).derive({ v: field('base').add(midi('c4').mul(100)) }).rows[0]
  assert.ok(isBinding(row.v))
  // base (baked: 10) + c4 (live: 0.5) * 100 = 60
  assert.equal(resolveBindings(row, { midi: () => 0.5 }).v, 60)
})

test('rasterize carries a midi binding onto each dense frame row', () => {
  const events = t([
    { id: 's', event: 'create', beat: 1, shape: 'box', px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 },
  ]).derive({ amount: midi('c4') })

  const baked = rasterizeRows(events.rows, 0.1) // ~3 frames
  assert.ok(baked.length >= 2)
  for (const f of baked) assert.ok(isBinding(f.amount), 'binding survives the bake')
})

// ── End-to-end: the same path playback walks each frame ─────────────────────

test('a note recorded at frame 60 drives the field every time the loop passes it', () => {
  // Record c4 (on) at source frame 60, off at frame 120 — as live input stores it.
  const midiRows = [
    midiRow(decodeMidi([0x90, 60, 127])!, b(60)),
    midiRow(decodeMidi([0x80, 60, 0])!, b(120)),
  ]
  const idx = buildMidiIndex(midiRows)
  const ctxAt = (frame: number): { midi: (n: string, c: number | null) => number } => ({
    midi: (note, ch) => sampleMidiAt(idx, note, ch, frame),
  })

  const baked = rasterizeRows(
    t([{ id: 's', event: 'create', beat: 1, shape: 'box', px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }])
      .derive({ amount: midi('c4') }).rows,
    5,
  )
  const rowAt = (frame: number): Row => resolveBindings(baked.find((r) => r.frame === frame)!, ctxAt(frame))

  assert.equal(rowAt(30).amount, 0, 'before the note (frame 30): 0')
  assert.equal(rowAt(60).amount, 1, 'loop reaches frame 60: note on')
  assert.equal(rowAt(90).amount, 1, 'still held at frame 90')
  assert.equal(rowAt(120).amount, 0, 'released at frame 120')
})

test('a midi binding in a hydra setVariable event survives to hydraFrameAt and resolves at playback', () => {
  const codeRow = { beat: 1, event: 'setCode', code: 'osc(speed).out()' }
  const varRow = t([{ beat: 1, event: 'setVariable', name: 'speed' }]).derive({ value: midi('c4') }).rows[0]
  assert.ok(isBinding(varRow.value), 'the variable value is deferred, like a scene field')

  const idx = buildHydraIndex([codeRow, varRow])
  const frame = hydraFrameAt(idx, 0)
  assert.ok(frame)
  assert.ok(isBinding(frame!.vars.speed), 'the binding survives hydraFrameAt untouched')

  const resolved = resolveBindings(frame!.vars, { midi: () => 0.6 })
  assert.equal(resolved.speed, 0.6)
})

test('filter() rejects a streaming predicate — row presence is decided at cook time', () => {
  assert.throws(() => t([{ v: 1 }]).filter(slider('gate').gt(0.5)), /live source/)
})

test('idx() inside a streaming expression bakes per row rather than resolving to 0', () => {
  const rows = t([{}, {}, {}]).derive({ y: idx().mul(10).add(slider('h')) }).rows
  const ctx = { slider: () => 1 }
  assert.deepEqual(rows.map((r) => resolveBindings(r, ctx).y), [1, 11, 21])
})
