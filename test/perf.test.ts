// Performance contracts for the scene cache.
//
// The cache is a dense per-frame bake, so anything a row carries is paid for
// ~1,500 times on a real model. That has always been survivable only because
// large values are stored once and referenced — and the cheapest way to break
// it is a well-meaning copy somewhere in the middle, which no correctness test
// would notice. These pin the SHAPE of the cache (what it references, how many
// objects it reaches) rather than wall-clock wherever possible: shape is
// deterministic, wall-clock is not. The one timing test is budgeted two orders
// of magnitude above what it costs, so it catches a catastrophe without going
// flaky on a slow machine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/runtime.js'
import { cookProgram } from '../src/replay.js'
import { packCooked } from '../src/cook-transfer.js'
import { buildFrameIndex, sampleFrame } from '../src/rasterize.js'
import { SAMPLES } from '../src/samples.js'
import { conformRow, schemaColumns, type ColumnType } from '../src/editable-tables.js'

// The crane is the heaviest thing the app ships: 17 exact folds, ~1,500 baked
// frames, and a compiled program of a megabyte and a half.
const sample = SAMPLES.find((s) => s.name === 'Origami Crane')!
const cooked = cookProgram(
  createRuntime({
    editableRows: (n: string, schema: Record<string, ColumnType>, seed?: Record<string, unknown>[]) =>
      (seed ?? sample.tables?.[n] ?? []).map((r) => conformRow(r, schemaColumns(schema))),
  }), sample.code, 1)

const reachable = (root: unknown): number => {
  const seen = new Set<object>()
  const stack: unknown[] = [root]
  while (stack.length) {
    const v = stack.pop()
    if (v === null || typeof v !== 'object' || seen.has(v)) continue
    seen.add(v)
    if (Array.isArray(v)) { for (const x of v) stack.push(x) }
    else for (const k in v as Record<string, unknown>) stack.push((v as Record<string, unknown>)[k])
  }
  return seen.size
}

test('nothing large is copied onto every frame of the cache', () => {
  assert.ok(cooked.sceneRows.length > 1000, 'the crane really does bake ~1,500 frames')
  const byValue = cooked.sceneRows.filter(
    (r) => (r.program as { kind?: string } | undefined)?.kind === 'fold-table')
  assert.equal(byValue.length, 0, 'no frame carries the fold program by value')
  const byHandle = cooked.sceneRows.filter(
    (r) => typeof (r.program as { $asset?: string } | undefined)?.$asset === 'string')
  assert.equal(byHandle.length, cooked.sceneRows.length, 'every frame references it instead')
})

test('the packed payload does not grow with the frame count', () => {
  // Reached-object count is the amplification metric: one shared program is a
  // few thousand nodes, so a payload that copied it per frame would reach
  // millions. The bound sits an order of magnitude above the real figure and
  // two below a per-frame copy.
  const n = reachable(packCooked(cooked))
  assert.ok(n < 100_000, `packed payload reaches ${n} objects — a per-frame copy would reach millions`)
})

test('sampling the playhead stays far inside real time', () => {
  const index = buildFrameIndex(cooked.sceneRows)
  const FRAMES = 600                     // 10 seconds of playback at 60fps
  const started = performance.now()
  let rows = 0
  // fractional frames exercise the interpolating path, which is what playback
  // actually asks for
  for (let f = 0; f < FRAMES; f++) rows += sampleFrame(index, f + 0.5).length
  const ms = performance.now() - started
  assert.ok(rows > 0, 'the scene is not empty')
  assert.ok(ms < 250, `${FRAMES} frames sampled in ${ms.toFixed(0)}ms — budget 250ms, real time is 10,000ms`)
})
