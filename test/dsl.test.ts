import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Table, createDSL, field } from '../src/dsl.js'
import { withLineage, getLineage, type Row } from '../src/lineage.js'

const t = (rows: Row[]): Table => new Table(rows)

test('map / filter / slice return new tables', () => {
  const base = t([{ v: 1 }, { v: 2 }, { v: 3 }])
  assert.deepEqual(base.map((r) => ({ v: (r.v as number) * 10 })).rows, [{ v: 10 }, { v: 20 }, { v: 30 }])
  assert.deepEqual(base.filter(field('v').mod(2).eq(1)).rows, [{ v: 1 }, { v: 3 }])
  assert.deepEqual(base.slice(1, 2).rows, [{ v: 2 }])
  assert.deepEqual(base.rows, [{ v: 1 }, { v: 2 }, { v: 3 }])
})

test('shift moves rows along the beat axis, leaving beat-less rows alone', () => {
  const base = t([{ beat: 1, dur: 2, v: 'a' }, { beat: 3, v: 'b' }, { note: 'no beat' }])
  assert.deepEqual(base.shift(4).rows,
    [{ beat: 5, dur: 2, v: 'a' }, { beat: 7, v: 'b' }, { note: 'no beat' }])
  assert.deepEqual(base.shift(-1).rows.map((r) => r.beat), [0, 2, undefined])
})

test('filter matches a { field: value } pattern (multi-key = AND, ===)', () => {
  const base = t([
    { id: 'ball', event: 'update', py: 1 },
    { id: 'ball', event: 'create', py: 2 },
    { id: 'box', event: 'update', py: 3 },
  ])
  assert.deepEqual(base.filter({ event: 'update' }).rows.map((r) => r.py), [1, 3])
  assert.deepEqual(base.filter({ id: 'ball', event: 'update' }).rows.map((r) => r.py), [1])
  assert.deepEqual(base.filter({ id: 'none' }).rows, [])
})

test('flatMap fans rows out through the index and full row array, dropping nulls and flattening arrays', () => {
  const base = t([{ v: 5 }, { v: 9 }, { v: 2 }])
  const out = base.flatMap((r, i, rows) =>
    i === 0 ? null : (r.v as number) > (rows[i - 1].v as number) ? [r, { v: 90 }] : r)
  assert.deepEqual(out.rows, [{ v: 9 }, { v: 90 }, { v: 2 }])
})

test('concat accepts a Table or a bare array', () => {
  const a = t([{ v: 1 }])
  assert.deepEqual(a.concat(t([{ v: 2 }])).rows, [{ v: 1 }, { v: 2 }])
  assert.deepEqual(a.concat([{ v: 3 }]).rows, [{ v: 1 }, { v: 3 }])
  assert.deepEqual(a.concat(null).rows, [{ v: 1 }])
})

test('fold reduces to a bare accumulator', () => {
  const sum = t([{ v: 1 }, { v: 2 }, { v: 4 }]).fold((acc, r) => acc + (r.v as number), 0)
  assert.equal(sum, 7)
})

test('scan threads state and flattens emitted rows', () => {
  const out = t([{ v: 4 }, { v: 7 }, { v: 12 }, { v: 3 }]).scan((state, cur) => {
    const total = state.total + (cur.v as number)
    const crossed = state.total < 10 && total >= 10
    return { state: { total }, emit: crossed ? [{ at: cur.v }, { at: total }] : null }
  }, { total: 0 })
  assert.deepEqual(out.rows, [{ at: 7 }, { at: 11 }], 'an emit array flattens in place')
})

test('columns is the first-seen union of keys across rows', () => {
  const out = t([{ a: 1 }, { b: 2, a: 3 }, { c: 4 }])
  assert.deepEqual(out.columns, ['a', 'b', 'c'])
})

test('join merges matching rows on a key (drops unmatched, fans out duplicates)', () => {
  const left = t([{ id: 'a', x: 1 }, { id: 'b', x: 2 }])
  const right = t([{ id: 'a', y: 10 }, { id: 'a', y: 11 }, { id: 'c', y: 99 }])
  assert.deepEqual(left.join(right, 'id').rows, [
    { id: 'a', x: 1, y: 10 }, { id: 'a', x: 1, y: 11 },
  ])
})

test('zip pairs rows positionally and stops at the shorter', () => {
  const a = t([{ x: 1 }, { x: 2 }, { x: 3 }])
  const b = t([{ y: 10 }, { y: 20 }])
  assert.deepEqual(a.zip(b).rows, [{ x: 1, y: 10 }, { x: 2, y: 20 }])
})

test('orderBy sorts asc and desc by key or fn', () => {
  const base = t([{ v: 2 }, { v: 1 }, { v: 3 }])
  assert.deepEqual(base.orderBy('v').rows.map((r) => r.v), [1, 2, 3])
  assert.deepEqual(base.orderBy('v', 'desc').rows.map((r) => r.v), [3, 2, 1])
  assert.deepEqual(base.orderBy((r) => -(r.v as number)).rows.map((r) => r.v), [3, 2, 1])
})

test('derive adds and overwrites columns, keeping the rest (Expr, fn, or literal)', () => {
  const base = t([{ a: 1 }, { a: 2 }])
  assert.deepEqual(base.derive({ b: (r: Row) => (r.a as number) * 10, c: 'k' }).rows, [
    { a: 1, b: 10, c: 'k' }, { a: 2, b: 20, c: 'k' },
  ])
  assert.deepEqual(base.derive({ a: (r: Row) => (r.a as number) + 1 }).rows, [{ a: 2 }, { a: 3 }])
  assert.deepEqual(base.derive({ root: field('a').mul(10) }).rows, [{ a: 1, root: 10 }, { a: 2, root: 20 }])
})

test('rescale linearly remaps a field into a range', () => {
  const out = t([{ v: 0 }, { v: 5 }, { v: 10 }]).rescale('v', [0, 10], [0, 100], 'pct')
  assert.deepEqual(out.rows.map((r) => r.pct), [0, 50, 100])
})

test('lag carries a past value into a new column (null at the start)', () => {
  const out = t([{ v: 1 }, { v: 2 }, { v: 3 }]).lag('v')
  assert.deepEqual(out.rows.map((r) => r.v_lag), [null, 1, 2])
})

test('groupBy().agg aggregates per group; count is shorthand', () => {
  const base = t([{ g: 'x', v: 1 }, { g: 'x', v: 3 }, { g: 'y', v: 10 }])
  assert.deepEqual(base.groupBy('g').agg({ sum: (rs) => rs.reduce((s, r) => s + (r.v as number), 0) }).rows, [
    { g: 'x', sum: 4 }, { g: 'y', sum: 10 },
  ])
  assert.deepEqual(base.groupBy('g').count().rows, [{ g: 'x', count: 2 }, { g: 'y', count: 1 }])
})

test('crossings detects level crossings with direction', () => {
  const wave = t([{ value: -1 }, { value: -0.5 }, { value: 0.5 }, { value: -2 }])
  assert.deepEqual(wave.crossings().rows.map((r) => ({ value: r.value, dir: r.dir })), [
    { value: 0.5, dir: 1 }, { value: -2, dir: -1 },
  ])
})

test('pairBy pairs matches cyclically, replacing each `second` with fn\'s output', () => {
  const out = t([
    { beat: 1, event: 'setCode', code: 'a' },
    { beat: 5, event: 'setVariable', name: 'freq', value: 3 },
    { beat: 9, event: 'setCode', code: 'b' },
  ]).pairBy({ event: 'setCode' }, (first, second) => [
    { beat: second.beat, from: first.code, to: second.code },
  ])
  assert.deepEqual(out.rows, [
    { beat: 1, from: 'b', to: 'a' },
    { beat: 5, event: 'setVariable', name: 'freq', value: 3 },
    { beat: 9, from: 'a', to: 'b' },
  ])
})

test('triggerEach fans out across objects and unions lineage from trigger + object', () => {
  const wave = new Table([
    withLineage({ value: -1, index: 0 }, [{ table: 'wave', index: 0 }]),
    withLineage({ value: 1, index: 1 }, [{ table: 'wave', index: 1 }]),
  ])
  const objs = new Table([
    withLineage({ id: 'a' }, [{ table: 'objs', index: 0 }]),
    withLineage({ id: 'b' }, [{ table: 'objs', index: 1 }]),
  ])
  const out = wave.triggerEach(
    (cur, i, rows) => i > 0 && (cur.value as number) * (rows[i - 1].value as number) < 0,
    objs,
    (o, cur) => ({ id: o.id, at: cur.index }),
  )
  assert.deepEqual(out.rows.map((r) => ({ id: r.id, at: r.at })), [
    { id: 'a', at: 1 }, { id: 'b', at: 1 },
  ])
  assert.deepEqual(getLineage(out.rows[0]), [{ table: 'wave', index: 1 }, { table: 'objs', index: 0 }])
})

test('.three.rotate passes base rows through, appending start + end keyframes', () => {
  const { three } = createDSL(null)
  const scene = three.box({ id: 'a' }).concat(three.box({ id: 'b', beat: 3 }))
  const out = scene.three.rotate({ amount: Math.PI, dur: 4 })
  assert.deepEqual(out.rows.slice(0, 2), scene.rows, 'base rows pass through')
  assert.deepEqual(out.rows.slice(2), [
    // 'a': create at beat 1, so ry glides 0 → π over beats 1..5.
    { id: 'a', event: 'update', beat: 1, ry: 0 },
    { id: 'a', event: 'update', beat: 5, ry: Math.PI },
    // 'b': create at beat 3, so beats 3..7.
    { id: 'b', event: 'update', beat: 3, ry: 0 },
    { id: 'b', event: 'update', beat: 7, ry: Math.PI },
  ])
})

test('.three animators chain, each acting only on the create rows', () => {
  const { three } = createDSL(null)
  const out = three.box({ id: 'a' }).three.rotate({ amount: 1, dur: 2 }).three.scale({ amount: 3, dur: 2 })
  assert.deepEqual(out.rows.filter((r) => r.event === 'update'), [
    { id: 'a', event: 'update', beat: 1, ry: 0 },
    { id: 'a', event: 'update', beat: 3, ry: 1 },
    { id: 'a', event: 'update', beat: 1, sx: 1, sy: 1, sz: 1 },
    { id: 'a', event: 'update', beat: 3, sx: 3, sy: 3, sz: 3 },
  ])
})

test('csv parses a header row and coerces numeric cells', () => {
  const { csv } = createDSL(null)
  assert.deepEqual(csv('city,pop\nNYC,8000000\nLA,4000000').rows, [
    { city: 'NYC', pop: 8000000 }, { city: 'LA', pop: 4000000 },
  ])
})

test('json wraps an array and parses a string', () => {
  const { json } = createDSL(null)
  assert.deepEqual(json([{ a: 1 }]).rows, [{ a: 1 }])
  assert.deepEqual(json('[{"a":2}]').rows, [{ a: 2 }])
})

test('grid lays out a centred cols×rows lattice', () => {
  const { grid } = createDSL(null)
  const g = grid(2, 2, { spacing: 1 })
  assert.equal(g.length, 4)
  assert.deepEqual(g.rows[0], { i: 0, col: 0, row: 0, px: -0.5, py: 0, pz: -0.5 })
  assert.deepEqual(g.rows[3], { i: 3, col: 1, row: 1, px: 0.5, py: 0, pz: 0.5 })
})

test('camera builds a create row (defaulted pose) then update keyframes', () => {
  const { three } = createDSL(null)
  const cam = three.camera([
    { beat: 1, px: 0, py: 0.5, pz: 5, fov: 60 },
    { beat: 9, px: 4, fov: 45 },
  ])
  assert.deepEqual(cam.rows[0], {
    id: 'camera', shape: 'camera', event: 'create', beat: 1,
    px: 0, py: 0.5, pz: 5, tx: 0, ty: 0, tz: 0, fov: 60,
  })
  assert.deepEqual(cam.rows[1], {
    id: 'camera', shape: 'camera', event: 'update', beat: 9, px: 4, fov: 45,
  })
})

test('box builds a defaulted create row, props overriding defaults', () => {
  const { three } = createDSL(null)
  assert.deepEqual(three.box({ id: 'a', px: -1, color: 0x4a9eff }).rows[0], {
    id: 'a', event: 'create', beat: 1, shape: 'box',
    px: -1, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, color: 0x4a9eff,
  })
})

test('every named primitive carries its shape and a "create" type', () => {
  const { three } = createDSL(null)
  for (const shape of ['box', 'sphere', 'cylinder', 'cone', 'torus', 'text'] as const) {
    const row = three[shape]().rows[0]
    assert.equal(row.shape, shape)
    assert.equal(row.event, 'create')
    assert.equal(row.id, shape)
  }
})

test('light builds a "light" create row without forcing a position', () => {
  const { three } = createDSL(null)
  // Unlike the mesh primitives, a light omits px/py/pz so the renderer can
  // apply the kind's own default position; kind defaults to directional.
  assert.deepEqual(three.light().rows[0], {
    id: 'light', event: 'create', beat: 1, shape: 'light', kind: 'directional',
  })
  // Props override — kind and any light field pass straight through.
  const row = three.light({ id: 'k', kind: 'point', px: 2, intensity: 4 }).rows[0]
  assert.equal(row.kind, 'point')
  assert.equal(row.px, 2)
  assert.equal(row.intensity, 4)
})

test('the per-kind light helpers fill in kind and a distinct default id', () => {
  const { three } = createDSL(null)
  assert.deepEqual(three.ambientLight({ intensity: 2 }).rows[0], {
    id: 'ambientLight', event: 'create', beat: 1, shape: 'light', kind: 'ambient', intensity: 2,
  })
  // Distinct ids so two lights concat into one scene without colliding.
  const kinds = three.directionalLight().concat(three.pointLight())
    .concat(three.spotLight()).concat(three.hemisphereLight())
  assert.deepEqual(kinds.rows.map((r) => [r.id, r.kind]), [
    ['directionalLight', 'directional'], ['pointLight', 'point'],
    ['spotLight', 'spot'], ['hemisphereLight', 'hemisphere'],
  ])
})

test('three.translate/scale/rotate modify a scene table\'s create rows', () => {
  const { three } = createDSL(null)
  const base = three.box({ id: 'a', px: 1 })
  assert.deepEqual(three.translate(base, 2, -1, 0.5).rows[0], { ...base.rows[0], px: 3, py: -1, pz: 0.5 })
  // scale multiplies sx/sy/sz (default 1); one arg = uniform on all axes.
  assert.deepEqual(three.scale(base, 2).rows[0], { ...base.rows[0], sx: 2, sy: 2, sz: 2 })
  assert.deepEqual(three.rotate(base, 0, Math.PI, 0).rows[0].ry, Math.PI)
})

test('three modifiers leave partial update keyframes that omit the field alone', () => {
  const { three } = createDSL(null)
  const scene = three.box({ id: 'a' }).concat([{ id: 'a', event: 'update', beat: 5, ry: 1 }])
  const rows = three.translate(scene, 2, 0, 0).rows
  assert.equal(rows[0].px, 2)                       // create row shifted
  assert.deepEqual(rows[1], { id: 'a', event: 'update', beat: 5, ry: 1 }) // update untouched
})

test('rotate emits one row per value, cycling the pattern and letting each value override it', () => {
  const { rotate } = createDSL(null)
  const out = rotate([{ shape: 'a' }, { shape: 'b' }],
    [{ beat: 1 }, { beat: 2 }, { beat: 3 }, { beat: 4, shape: 'c' }])
  assert.deepEqual(out.rows, [
    { shape: 'a', beat: 1 }, { shape: 'b', beat: 2 }, { shape: 'a', beat: 3 }, { shape: 'c', beat: 4 },
  ])
})

test('schemas: canonical table schemas ride the DSL surface, typed and frozen', async () => {
  const { schemas } = createDSL(null)
  const { SCHEMAS } = await import('../src/dsl.js')
  assert.equal(schemas, SCHEMAS)
  const { schemaColumns } = await import('../src/editable-tables.js')
  const cols = schemaColumns(schemas.hydra)
  const code = cols.find((c) => c.name === 'code')!
  assert.ok(code.type === 'code' && code.language === 'hydra', 'hydra code cells open in hydra mode')
  for (const name of ['sliders', 'path', 'origami']) assert.ok(name in schemas, `expected schemas.${name}`)
  // Frozen: an untyped program can't reshape a shared schema for later runs.
  assert.ok(Object.isFrozen(schemas.hydra) && Object.isFrozen(schemas.hydra.event))
  assert.throws(() => { (schemas.hydra as Record<string, unknown>).beat = 'string' })
})
