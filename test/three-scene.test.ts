// Tests for three-scene's pure geometry-rebuild decision — the layer that
// caught a real bug: updateObject only ever repositioned an existing mesh, so
// a re-run that resized or reshaped an object left the stale THREE.js geometry
// in place forever. (The WebGL renderer stays untested; every decision it acts
// on is computed here.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { geometryDims, geometryChanged, textParams, textGeometryChanged, cameraPose, lightParams, lightKindChanged, paintTables, LIGHT_DEFAULT } from '../src/three-scene.js'

test('geometryDims merges shape defaults with the row\'s own fields', () => {
  assert.deepEqual(geometryDims('box', {}), { hx: 0.25, hy: 0.25, hz: 0.25, r: undefined, h: undefined })
  assert.deepEqual(geometryDims('box', { hx: 0.04 }), { hx: 0.04, hy: 0.25, hz: 0.25, r: undefined, h: undefined })
  assert.deepEqual(geometryDims('sphere', {}), { hx: undefined, hy: undefined, hz: undefined, r: 0.3, h: undefined })
})

test('geometryChanged fires only when the shape or a dimension moved', () => {
  const box = geometryDims('box', { hx: 0.04, hy: 0.35, hz: 0.22 })
  assert.equal(geometryChanged('box', box, { shape: 'box', hx: 0.04, hy: 0.35, hz: 0.22, px: 1, py: 2 }), false)
  // The house-of-cards thickness edit: one dimension moving forces a rebuild.
  assert.equal(geometryChanged('box', box, { shape: 'box', hx: 0.3, hy: 0.35, hz: 0.22 }), true)
  // A row that omits shape keeps the previous one rather than defaulting.
  assert.equal(geometryChanged('box', box, { hx: 0.04, hy: 0.35, hz: 0.22 }), false)
  assert.equal(geometryChanged('box', box, { hx: 0.5, hy: 0.35, hz: 0.22 }), true)
  // Reshaping the same id rebuilds both ways, so it isn't a one-way latch.
  const sphere = geometryDims('sphere', { r: 0.3 })
  assert.equal(geometryChanged('sphere', sphere, { shape: 'box', hx: 0.25, hy: 0.25, hz: 0.25 }), true)
  assert.equal(geometryChanged('box', box, { shape: 'sphere', r: 0.3 }), true)
})

test('textParams stringifies text and fills in defaults', () => {
  assert.deepEqual(textParams({ text: 'hi' }), { text: 'hi', size: 0.5, color: 0xffffff })
  // A missing string is empty, not "undefined".
  assert.deepEqual(textParams({}), { text: '', size: 0.5, color: 0xffffff })
  assert.deepEqual(textParams({ text: 42, size: 1.2, color: 0xff0000 }), { text: '42', size: 1.2, color: 0xff0000 })
})

test('textGeometryChanged tracks string/size only — color recolors without a rebuild', () => {
  const prev = textParams({ text: 'hi', size: 0.5, color: 0xffffff })
  assert.equal(textGeometryChanged(prev, { text: 'hi', size: 0.5, px: 1, py: 2 }), false)
  assert.equal(textGeometryChanged(prev, { text: 'hi', size: 0.5, color: 0xff0000 }), false)
  assert.equal(textGeometryChanged(prev, { text: 'bye', size: 0.5 }), true)
  assert.equal(textGeometryChanged(prev, { text: 'hi', size: 1.0 }), true)
})

test('cameraPose fills eye/target defaults and leaves fov null when unset', () => {
  // fov null means "leave the current fov untouched".
  assert.deepEqual(cameraPose({ pz: 8 }), { px: 0, py: 0, pz: 8, tx: 0, ty: 0, tz: 0, fov: null })
  assert.deepEqual(cameraPose({ px: 1, py: 2, pz: 3, tx: -1, ty: -2, tz: -3, fov: 45 }),
    { px: 1, py: 2, pz: 3, tx: -1, ty: -2, tz: -3, fov: 45 })
  // The empty-row default matches the app's initial camera.
  assert.deepEqual(cameraPose({}), { px: 0, py: 0, pz: 5, tx: 0, ty: 0, tz: 0, fov: null })
})

test('lightParams resolves a partial row with defaults and guards the kind', () => {
  // An empty row is well-defined (the default directional key), so a bare
  // create/keyframe still builds a light.
  assert.deepEqual(lightParams({}), LIGHT_DEFAULT)
  // A partial row keeps what it sets and defaults the rest.
  const p = lightParams({ kind: 'point', intensity: 4, px: 1 })
  assert.equal(p.kind, 'point')
  assert.equal(p.intensity, 4)
  assert.equal(p.px, 1)
  assert.equal(p.py, LIGHT_DEFAULT.py)
  // An unknown kind falls back to the default rather than reaching THREE.
  assert.equal(lightParams({ kind: 'laser' }).kind, 'directional')
})

test('lightKindChanged flags a rebuild only when a row names a different kind', () => {
  // A plain update (no kind) or the same kind is a live mutation, not a rebuild.
  assert.equal(lightKindChanged('point', { intensity: 5, px: 2 }), false)
  assert.equal(lightKindChanged('point', { kind: 'point', intensity: 5 }), false)
  // A genuinely different kind needs the THREE.Light rebuilt.
  assert.equal(lightKindChanged('point', { kind: 'spot' }), true)
  // An unknown kind is ignored — keep the current one.
  assert.equal(lightKindChanged('point', { kind: 'nope' }), false)
})

// Origami paint rows are addressed by (step, element) because a face number
// only means something inside its own step — every fold re-splits the paper.
test('paintTables indexes paint by step, keyed the way the renderer draws', () => {
  const paint = paintTables(
    [
      { step: 0, face: 1, color: 0x00ff00, fade: 1 },
      { step: 2, face: 1, color: 0x0000ff },
      { step: 2, face: 0 },                       // no color: paints nothing
    ],
    [{ step: 2, a: 7, b: 3, color: 0xff0000 }],
  )
  assert.deepEqual([...paint.faces.keys()], [0, 2], 'a step with no paint is absent')
  assert.equal(paint.faces.get(2)?.has(0), false)
  assert.equal(paint.faces.get(0)?.get(1)?.fade, 1)
  assert.equal(paint.faces.get(2)?.get(1)?.fade, 0, 'no fade means paint throughout')
  // edges key on the low-high vertex pair, matching the renderer's line dedup
  assert.ok(paint.edges.get(2)?.has('3,7'))
})
