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
import { sampleFrame, elementRowsAt, type MeshSlab } from '../src/rasterize.js'
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
  let runs = 0, cols = 0
  for (const o of cooked.scene.objects) {
    for (const t of Object.values(o.cols)) { runs += t.at.length; cols++ }
  }
  const dense = (cooked.scene.maxFrame + 1) * cols
  assert.ok(runs < dense / 10,
    `${runs} entries for what a per-frame bake would store as ${dense} cells`)
})

// The paper is a couple of thousand elements. As sibling objects they cost the
// playhead a row each, every frame, and the renderer a hash lookup each to
// gather them back — for geometry that is the same paper all the way through.
// The store compiles them into buffers once, so a frame is one object.
test('a mesh reaches the playhead as buffers, not as an object per element', () => {
  const objects = cooked.scene.objects
  assert.equal(objects.length, 1, `${objects.length} objects for one folded paper`)
  const slab = objects[0].cols.slab.val[0] as MeshSlab
  assert.ok(slab.vpos instanceof Float32Array && slab.cornerVert instanceof Int32Array)
  // positions sit on ONE keyframe axis for the whole mesh, so a frame is a
  // single search rather than one per column per element
  assert.equal(slab.vpos.length, slab.axis.length * slab.nv * 3)
  assert.equal(slab.foff.length, slab.axis.length * slab.nf * 3)
  assert.ok(slab.axis.length < cooked.scene.maxFrame,
    `${slab.axis.length} keyframes for ${cooked.scene.maxFrame + 1} frames`)
  // and the corner order is topology: stated once, as plain indices
  assert.equal(slab.cornerVert.length, slab.cornerFace.length * 3)
  assert.ok(slab.cornerVert.every((v) => v >= 0 && v < slab.nv), 'every corner names a vertex')
  assert.ok(slab.endVert.every((v) => v >= 0 && v < slab.nv), 'every crease end names a vertex')
})

// Playback hands the buffers straight to the renderer; everything else — the
// table view, .rasterize(), an inspector — can still ask for the paper one
// vertex at a time, and must get the same geometry.
test('the buffers still describe every element as a row', () => {
  const frame = 400.5
  const mesh = sampleFrame(cooked.scene, frame)[0]
  const els = elementRowsAt(mesh.slab as MeshSlab, mesh.id, frame)
  const verts = els.filter((r) => typeof r.vert === 'number')
  const tris = els.filter((r) => typeof r.tri === 'number')
  assert.ok(verts.length > 10 && tris.length > 10)
  for (const r of els) {
    for (const k in r) {
      const v = r[k]
      assert.ok(v === null || typeof v === 'number' || typeof v === 'string',
        `${k} is a scalar`)
    }
  }
  // a triangle's corners are vertices that exist and have been placed
  const at = new Map(verts.map((r) => [r.vert, r]))
  for (const t of tris) {
    for (const c of ['v0', 'v1', 'v2']) {
      const v = at.get(t[c] as number)
      assert.ok(v && Number.isFinite(v.px as number), `corner ${c} of tri ${t.tri} is placed`)
    }
  }
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
  // ~3ms now that a mesh is one object rather than 400 — the budget is loose
  // enough to survive a busy machine and still catch a return to per-element rows
  assert.ok(ms < 200, `${FRAMES} frames sampled in ${ms.toFixed(0)}ms — budget 200ms, real time is 10,000ms`)
})
