// Performance contracts for the scene store.
//
// The store keeps keyframes, not a frame-by-frame bake, so a value a row holds
// for the whole piece costs one entry rather than ~1,500. The cheapest way to
// lose that is a well-meaning densification somewhere in the middle, which no
// correctness test would notice. These pin the SHAPE of the store (what it
// references, how much it keeps) rather than wall-clock wherever possible:
// shape is deterministic, wall-clock is not. The one timing test is budgeted
// two orders of magnitude above what it costs, so it catches a catastrophe
// without going flaky on a slow machine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/runtime.js'
import { cookProgram } from '../src/replay.js'
import { packCooked } from '../src/cook-transfer.js'
import { sampleFrame } from '../src/rasterize.js'
import { SAMPLES } from '../src/samples.js'
import { conformRow, schemaColumns, type ColumnType } from '../src/editable-tables.js'
import { outViewName, isBinding } from '../src/dsl.js'

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

// The scene table describes geometry the same way it describes everything
// else: one row per element, every cell a number. Nothing carries a nested
// blob a reader would have to expand — which is what makes the table
// inspectable, joinable, and expressible as flat buffers.
test('no scene cell holds a nested value', () => {
  const rows = cooked.views.get(outViewName('three'))!.rows
  assert.ok(rows.length > 1000, 'the crane really does emit its elements')
  const nested = new Set<string>()
  for (const r of rows) {
    for (const k in r) {
      const v = r[k]
      if (v !== null && typeof v === 'object' && !isBinding(v)) nested.add(k)
    }
  }
  assert.deepEqual([...nested], [], 'every cell is a number or a string')
  // and the elements really are there
  assert.ok(rows.some((r) => typeof r.vert === 'number'), 'vertices')
  assert.ok(rows.some((r) => typeof r.tri === 'number'), 'triangles')
  assert.ok(rows.some((r) => typeof r.edge === 'number'), 'edges')
})

test('the packed payload does not grow with the frame count', () => {
  // The paper is ~2,000 elements over ~1,500 frames. What must not happen is
  // the payload scaling with their PRODUCT — the bound sits well above the
  // element count and far below a per-frame materialization.
  const n = reachable(packCooked(cooked))
  assert.ok(n < 1_000_000, `packed payload reaches ${n} objects — per-frame rows would reach tens of millions`)
})

test('the store keeps only what changes', () => {
  // the columns that say which paper an element IS, as opposed to where it is
  const TOPOLOGY = new Set(['vert', 'face', 'edge', 'tri', 'v0', 'v1', 'v2', 'a', 'b'])
  let runs = 0, cols = 0, restated = 0, moved = 0
  for (const o of cooked.scene.objects) {
    for (const [k, t] of Object.entries(o.cols)) {
      runs += t.at.length
      cols++
      if (TOPOLOGY.has(k) && t.at.length > 1) restated++
      if (k === 'px' && t.at.length > 1) moved++
    }
  }
  const dense = (cooked.scene.maxFrame + 1) * cols
  assert.ok(runs < dense / 10,
    `${runs} entries for what a per-frame bake would store as ${dense} cells`)
  assert.ok(moved > 10, 'vertices really do move — otherwise the bound above is free')
  // The paper has ONE topology for the whole folding, so a triangle's vertices
  // and an edge's ends are stated once and never again. That is the property
  // that makes an element number mean the same paper throughout.
  assert.equal(restated, 0, 'a topology column is stated once')
})

test('sampling the playhead stays far inside real time', () => {
  const index = cooked.scene
  const FRAMES = 600                     // 10 seconds of playback at 60fps
  const started = performance.now()
  let rows = 0
  // fractional frames exercise the interpolating path, which is what playback
  // actually asks for
  for (let f = 0; f < FRAMES; f++) rows += sampleFrame(index, f + 0.5).length
  const ms = performance.now() - started
  assert.ok(rows > 0, 'the scene is not empty')
  // ~150ms alone, up to ~280ms when the whole suite runs in parallel — the
  // budget clears both and still catches a return to per-frame work
  assert.ok(ms < 500, `${FRAMES} frames sampled in ${ms.toFixed(0)}ms — budget 500ms, real time is 10,000ms`)
})
