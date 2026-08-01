import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/runtime.js'
import { getLineage } from '../src/lineage.js'
import { compileFoldTable } from '../src/fold-engine.js'
import { buildFrameIndex, sampleFrame, rasterizeRows } from '../src/rasterize.js'

// The paper is scene rows now — a vertex is an object with px/py/pz keyframes —
// so geometry assertions read the same rows the renderer draws from, sampled
// at the beat the fold lands on.
const posAtBeat = (rows: Row[], beat: number): [number, number, number][] =>
  sampleFrame(buildFrameIndex(rows), beatToFrame(beat))
    .filter((r) => typeof r.vert === 'number')
    .map((r) => [r.px as number, r.py as number, r.pz as number])
// Fold-level facts (names, kinds, how far each swings) are the compiler's, not
// the scene row's — compile the sample's own fold table for those.
const programOf = (sample: { tables?: Record<string, Record<string, unknown>[]> }, table: string) =>
  compileFoldTable(sample.tables![table], { size: 1 })
import { conformRow, schemaColumns, invalidColumns, type ColumnType } from '../src/editable-tables.js'
import { SAMPLES } from '../src/samples.js'
import { buildHydraIndex, hydraFrameAt } from '../src/hydra.js'
import { beatToFrame } from '../src/constants.js'
import type { Row } from '../src/lineage.js'
import { outViewName, SCHEMAS } from '../src/dsl.js'

test('new verbs cook end-to-end (grid/derive/groupBy/csv/join/triggerEach + lineage)', () => {
  const code = `
define("wave", () => math(t => Math.sin(t * Math.PI * 10)).range(0.8))
define("base", "three", () => grid(2, 2).derive({
  id: r => "o" + r.i, event: "create", beat: 1, shape: "sphere",
  rx: 0, ry: 0, rz: 0, color: 0x4444ff,
}))
define("flash", "three", (rand, table) =>
  table("wave").triggerEach(
    (cur, i, rows) => i > 0 && cur.value * rows[i - 1].value < 0,
    table("base"),
    (o, cur) => ({ id: o.id, event: "color", beat: cur.beat, color: 0xff0000, dur: 4/30 })
  ))
define("scene", () => table("three").rasterize(24/30))
define("bySign", () => table("wave").derive({ sign: r => r.value >= 0 ? "pos" : "neg" }).groupBy("sign").count())
define("cities", () => csv("id,pop\\na,8\\nb,4"))
define("joined", () => table("cities").join(rows([{ id: "a", note: "hit" }]), "id"))
`
  const { views } = createRuntime().run(code, { seed: 1 })

  assert.equal(views.get('base')!.length, 4)

  const colorRows = views.get('three')!.rows.filter((r) => r.event === 'color')
  assert.equal(views.get('three')!.length, 4 + colorRows.length)
  assert.ok(colorRows.length >= 4 && colorRows.length % 4 === 0, 'color events fan out per object')

  assert.equal(views.get('bySign')!.rows.reduce((s, r) => s + (r.count as number), 0), 24)

  assert.deepEqual(views.get('cities')!.rows.map((r) => ({ id: r.id, pop: r.pop })),
    [{ id: 'a', pop: 8 }, { id: 'b', pop: 4 }])
  assert.deepEqual(views.get('joined')!.rows.map((r) => ({ id: r.id, pop: r.pop, note: r.note })),
    [{ id: 'a', pop: 8, note: 'hit' }])

  const scene = views.get('scene')!
  assert.equal(scene.length, 4 * 24)
  const lit = scene.rows.find((r) => r.color !== 0x4444ff)
  assert.ok(lit, 'expected at least one flashed frame')
  const tables = new Set(getLineage(lit!).map((l) => l.table))
  assert.ok(tables.has('wave'), 'flashed frame traces to the wave sample')
  assert.ok(tables.has('base'), 'flashed frame traces to the base object')
})

test('every sample.table names a table the sample declares', () => {
  // The example's default tab (see main's openExample) must be a real view or
  // editable table the code produces — a typo would silently fall back to the
  // default tab. Guard it statically: the name has to be a
  // define()/editable()/table(name, …)/.save() target in that sample's own code.
  for (const s of SAMPLES) {
    if (s.table == null) continue
    const escaped = s.table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const decl = new RegExp(`(define|editable|table|save)\\(\\s*"${escaped}"`)
    assert.ok(decl.test(s.code), `sample "${s.name}" declares its table "${s.table}"`)
  }
})

test('Origami Crane sample: 17 exact fold steps, wings held half-raised', () => {
  const sample = SAMPLES.find((s) => s.name === 'Origami Crane')!
  // Materialize seed rows exactly like the app (cook-service): the sample's table
  // data seeds the store, conformed so every schema column exists with type defaults.
  const { views } = createRuntime({
    editableRows: (name: string, schema: Record<string, ColumnType>, seed?: Record<string, unknown>[]) =>
      (seed ?? sample.tables?.[name] ?? []).map((r) => conformRow(r, schemaColumns(schema))),
  }).run(sample.code, { seed: 1 })

  const events = views.get(outViewName('three'))!
  const program = programOf(sample, 'origami')
  assert.equal(program.steps.length, 17)
  // the paper reaches the scene as elements, not as a geometry blob
  assert.ok(events.rows.some((r) => typeof r.vert === 'number'), 'vertices are rows')
  assert.ok(events.rows.some((r) => typeof r.tri === 'number'), 'triangles are rows')
  assert.equal(events.rows.find((r) => r.event === 'create')!.program, undefined)
  assert.equal(program.steps[16].name, 'wings')
  assert.equal(program.steps[16].to, 0.5)
  assert.equal(program.steps[16].FV.length, 74)
  // solved fold kinds: the collapse and the point folds are reverse folds
  const kinds = program.steps.map((s) => s.type)
  assert.equal(kinds.filter((k) => k === 'Inside Reverse').length, 9)

  // ONE topology for the whole folding: folding only subdivides, so the last
  // fold's vertices cover every earlier state. They are stated once and never
  // replaced, which is what makes an element number the same piece of paper
  // from the first beat to the last.
  const created = events.rows.filter((r) => r.event === 'create' && typeof r.vert === 'number')
  assert.equal(created.length, program.steps[16].Vfrom.length, 'every vertex of the final fold')
  assert.equal(new Set(created.map((r) => r.beat)).size, 1, 'all stated at one beat')
  assert.equal(events.rows.filter((r) => r.event === 'destroy').length, 0, 'and none is ever retired')

  // exact states at every landed fold: all flat (|z| only layer nudges = 0
  // here, raw positions), and the finished pose has the wings up
  for (let k = 0; k <= 16; ++k) {
    const landed = program.steps[k === 0 ? 0 : k - 1]
    const at = k === 0 ? program.steps[0].t0 : landed.t1
    for (const p of posAtBeat(events.rows, at)) assert.ok(Math.abs(p[2]) < 1e-6, `state ${k} is flat`)
  }
  const zMax = Math.max(...posAtBeat(events.rows, program.steps[16].t1).map((p) => p[2]))
  assert.ok(zMax > 0.5, `wings rise out of plane (z ${zMax.toFixed(2)})`)

  // Playback rasterizes the routed events into the scene cache automatically —
  // the baked frames must carry the paper's vertices.
  const sceneRows = rasterizeRows(events.rows)
  assert.ok(sceneRows.some((r: Row) => typeof r.vert === 'number'), 'baked frames carry vertices')
})

// The two flower samples are hand-authored fold tables; the contract is that
// they solve to flat states that read as a flower — a bloom with four-fold
// radial symmetry — not the exact fold count, which is free to change.
for (const { name, steps } of [
  { name: 'Origami Lotus', steps: 12 },
  { name: 'Origami Lily', steps: 8 },
]) {
  test(`${name} sample: simple folds solve to a flat, four-fold-symmetric bloom`, () => {
    const sample = SAMPLES.find((s) => s.name === name)!
    const { views } = createRuntime({
      editableRows: (n: string, schema: Record<string, ColumnType>, seed?: Record<string, unknown>[]) =>
        (seed ?? sample.tables?.[n] ?? []).map((r) => conformRow(r, schemaColumns(schema))),
    }).run(sample.code, { seed: 1 })

    const rows = views.get(outViewName('three'))!.rows
    const program = programOf(sample, sample.table!)
    assert.equal(program.steps.length, steps)

    // the finished flower lies flat
    const pos = posAtBeat(rows, program.steps[steps - 1].t1)
    for (const p of pos) assert.ok(Math.abs(p[2]) < 1e-6, 'landed flower is flat')

    // and it reads as a bloom: paper reaches out to a comparable radius in
    // every quarter turn, so petals radiate all the way around rather than
    // bunching to one side
    const cx = pos.reduce((s, p) => s + p[0], 0) / pos.length
    const cy = pos.reduce((s, p) => s + p[1], 0) / pos.length
    const reach = [0, 0, 0, 0]
    let rMax = 0
    for (const p of pos) {
      const dx = p[0] - cx
      const dy = p[1] - cy
      const r = Math.hypot(dx, dy)
      rMax = Math.max(rMax, r)
      const q = (Math.floor((Math.atan2(dy, dx) / (Math.PI / 2) + 4)) % 4)
      reach[q] = Math.max(reach[q], r)
    }
    for (const r of reach) assert.ok(r > 0.6 * rMax, 'petals radiate in every quarter')
  })
}

test('Origami Metamorphosis sample: retime pingpongs the lotus back to a square before the lily', () => {
  const sample = SAMPLES.find((s) => s.name === 'Origami Metamorphosis')!
  const { views } = createRuntime({
    editableRows: (n: string, schema: Record<string, ColumnType>, seed?: Record<string, unknown>[]) =>
      (seed ?? sample.tables?.[n] ?? []).map((r) => conformRow(r, schemaColumns(schema))),
  }).run(sample.code, { seed: 1 })
  const rows = views.get(outViewName('three'))!.rows

  // two flowers, handed off at the flat square: lotus retired, lily raised
  assert.ok(rows.some((r) => r.event === 'create' && r.id === 'flowerA'), 'lotus spawns')
  assert.ok(rows.some((r) => r.event === 'create' && r.id === 'flowerB'), 'lily spawns')
  assert.ok(rows.some((r) => r.event === 'destroy' && r.id === 'flowerA'), 'lotus is retired')

  // Read foldedness off the paper itself. A bounding box will not do — the
  // corners stay put — but folding gathers the paper toward its own centre.
  const idx = buildFrameIndex(rows)
  const paperAt = (id: string, beat: number): Map<number, [number, number, number]> => {
    const m = new Map<number, [number, number, number]>()
    for (const r of sampleFrame(idx, beatToFrame(beat))) {
      if (typeof r.vert === 'number' && String(r.id).startsWith(id)) {
        m.set(r.vert, [r.px as number, r.py as number, r.pz as number])
      }
    }
    return m
  }
  const gathered = (id: string, beat: number): number => {
    const pts = [...paperAt(id, beat).values()]
    const cx = pts.reduce((s, q) => s + q[0], 0) / pts.length
    const cy = pts.reduce((s, q) => s + q[1], 0) / pts.length
    return pts.reduce((s, q) => s + Math.hypot(q[0] - cx, q[1] - cy), 0) / pts.length
  }
  // the lotus folds up, then .retime(pingpong) folds the very same run back
  // down to a flat square — no hand-mirrored rows
  const flat = gathered('flowerA', 1)
  assert.ok(gathered('flowerA', 7) < flat * 0.8, 'the lotus gathers as it blooms')
  assert.ok(gathered('flowerA', 19) < flat * 0.8, 'and is still folded on the way back')

  // the pingpong lands on the very same square it started from — which is what
  // lets the lily take over there unseen
  const start = paperAt('flowerA', 1)
  const end = paperAt('flowerA', 25)
  assert.equal(end.size, start.size)
  for (const [v, q] of end) {
    const a = start.get(v)!
    assert.ok(Math.hypot(q[0] - a[0], q[1] - a[1], q[2] - a[2]) < 1e-6,
      `vertex ${v} returns to where it started`)
  }
})

test('Hydra Meta sample: replace/append/setSource/layer rewrite the sketch across the loop', () => {
  const sample = SAMPLES.find((s) => s.name === 'Hydra Meta')!
  const { views } = createRuntime({
    editableRows: (name: string, schema, seed?: Record<string, unknown>[]) =>
      (seed ?? sample.tables?.[name] ?? []).map((r) => conformRow(r, schemaColumns(schema))),
  }).run(sample.code, { seed: 1 })

  const hydra = views.get('hydra')!
  const cols = schemaColumns(SCHEMAS.hydra)
  for (const r of hydra.rows) assert.deepEqual(invalidColumns(r, cols), [], 'seed rows conform')

  const index = buildHydraIndex(hydra.rows)
  const at = (beat: number) => hydraFrameAt(index, beatToFrame(beat))!

  // beat 1: the bare oscillator.
  assert.equal(at(1).code, 'osc(20, 0.1, 1.2).out(o0)')
  // beat 5: replace retuned 20 → 45 in place.
  assert.equal(at(5).code, 'osc(45, 0.1, 1.2).out(o0)')
  // beat 7: append grew the chain with a kaleidoscope.
  assert.equal(at(7).code, 'osc(45, 0.1, 1.2).kaleid(5).out(o0)')
  // beat 9: setSource swapped osc → noise, the kaleidoscope carried over.
  assert.equal(at(9).code, 'noise(2.5, 0.3).kaleid(5).out(o0)')
  // beat 13: an additive layer of voronoi over the current sketch.
  assert.equal(at(13).code, 'noise(2.5, 0.3).kaleid(5).add(voronoi(10), 0.5).out(o0)')
  // beat 14: a transition wipes to a fresh sketch through the user's mask —
  // the before program layers the after, revealed through the mask sketch.
  const wipe = at(14).code
  assert.ok(wipe.startsWith('noise(2.5, 0.3).kaleid(5).add(voronoi(10), 0.5).layer('), 'wipe starts from the before program')
  assert.ok(wipe.includes('osc(30, 0.2, 2).kaleid(7)'), 'the after sketch rides inside the wipe')
  assert.ok(wipe.includes('.mask('), 'revealed through a mask')
  assert.ok(wipe.includes('gradient(0).thresh('), "the user's mask sketch is embedded")
  assert.ok(wipe.endsWith('.out(o0)'))
  // Byte-stable through the wipe (beat 15 is mid-window) — no per-frame injection.
  assert.deepEqual(at(14).vars, {})
  assert.equal(at(15).code, wipe)
  // At beat 16 the 2-beat window has elapsed: only the after sketch remains.
  assert.equal(at(16).code, 'osc(30, 0.2, 2).kaleid(7).out(o0)')
})

test('Origami Cicada sample: nine simple folds, all exact', () => {
  const sample = SAMPLES.find((s) => s.name === 'Origami Cicada')!
  const { views } = createRuntime({
    editableRows: (name: string, schema: Record<string, ColumnType>, seed?: Record<string, unknown>[]) =>
      (seed ?? sample.tables?.[name] ?? []).map((r) => conformRow(r, schemaColumns(schema))),
  }).run(sample.code, { seed: 1 })
  const events = views.get(outViewName('three'))!
  const program = programOf(sample, 'origami')
  assert.equal(program.steps.length, 9)
  for (const step of program.steps) assert.equal(step.type, 'Pureland')
  for (let k = 1; k <= 9; ++k) {
    for (const p of posAtBeat(events.rows, program.steps[k - 1].t1)) {
      assert.ok(Math.abs(p[2]) < 1e-6, `state ${k} flat`)
    }
  }
  const xs = posAtBeat(events.rows, program.steps[8].t1).map((p) => p[0])
  assert.ok(Math.max(...xs) - Math.min(...xs) > 0.8, 'wings splay wide')
})

test('Run Counter sample: the same code cooks to a different sketch every run', () => {
  const sample = SAMPLES.find((s) => s.name === 'Run Counter')!
  const activity: Record<string, unknown>[] = [
    { seq: 0, t: 0, kind: 'apply', id: 'a1', at: 10_000, edits: [] },
    { seq: 1, t: 1, kind: 'peer-join', client: 'c1' },
    { seq: 2, t: 2, kind: 'apply', id: 'a2', at: 13_000, edits: ['e1'] },
  ]
  const rt = createRuntime({ logRows: (n) => (n === 'activity' ? activity : null) })
  const { views } = rt.run(sample.code, { seed: 1 })
  assert.equal(views.get('runs')!.length, 2, 'peer-join rows are not runs')
  const hydra = views.get(outViewName('hydra'))!.rows
  const setCode = hydra.find((r) => r.event === 'setCode')!.code as string
  assert.ok(setCode.includes('kaleid(5)'), 'two runs -> 3 + 2 kaleid facets')
  // 3s between the last two applies -> heat 0.7 -> the oscillator runs hot.
  assert.ok(setCode.includes('osc((props) => props.freq, 0.06, 1.10)'), setCode)
  assert.equal(hydra.find((r) => r.event === 'setVariable')!.value, 6, 'the variable steps with every run: 4 + runs')

  // Another apply lands: same code, different program.
  activity.push({ seq: 3, t: 3, kind: 'apply', id: 'a3', at: 999_000, edits: [] })
  const again = rt.run(sample.code, { seed: 1 }).views.get(outViewName('hydra'))!.rows
  assert.ok((again.find((r) => r.event === 'setCode')!.code as string).includes('kaleid(6)'))
  assert.equal(again.find((r) => r.event === 'setVariable')!.value, 7)

  // A fresh session (no applies yet) still cooks: the calm baseline.
  const fresh = createRuntime({ logRows: (n) => (n === 'activity' ? [] : null) }).run(sample.code, { seed: 1 })
  assert.ok((fresh.views.get(outViewName('hydra'))!.rows.find((r) => r.event === 'setCode')!.code as string).includes('kaleid(3)'))
})

test('Session Sculpture sample: one brick per apply, sized by its edit batch, plus the pace graph', () => {
  const sample = SAMPLES.find((s) => s.name === 'Session Sculpture')!
  const activity: Record<string, unknown>[] = [
    { seq: 0, t: 0, kind: 'apply', id: 'a1', at: 50_000, edits: [] },
    { seq: 1, t: 1, kind: 'apply', id: 'a2', at: 53_000, edits: ['e1', 'e2', 'e3', 'e4'] },
    { seq: 2, t: 2, kind: 'peer-leave', client: 'c9' },
  ]
  const rt = createRuntime({ logRows: (n) => (n === 'activity' ? activity : null) })
  const { views, graphs } = rt.run(sample.code, { seed: 1 })

  // Bricks, caption, and camera each route with .outThree() and combine into
  // the one system scene table.
  const scene = views.get(outViewName('three'))!.rows
  const bricks = scene.filter((r) => r.shape === 'box')
  assert.equal(bricks.filter((r) => r.event === 'create').length, 2, 'one brick per apply')
  const [b0, b1] = bricks
  assert.ok((b1.hx as number) > (b0.hx as number), 'a bigger edit batch makes a bigger brick')
  const brickIds = new Set(bricks.map((r) => r.id))
  assert.equal(scene.filter((r) => r.event === 'update' && brickIds.has(r.id)).length, 1, 'the newest brick gets its spin keyframe')

  assert.ok((scene.find((r) => r.shape === 'text')!.text as string).includes('2 runs'))
  assert.deepEqual(views.get('pace')!.rows.map((r) => r.gap_s), [0, 3], 'seconds between consecutive runs')
  assert.ok(graphs.some((g) => g.viewName === 'pace'), 'the pace view is charted')
  assert.ok(rasterizeRows(scene).length > 0, 'the whole thing rasterizes')
})

test('Tap Constellation sample: on-grid taps ring at radius 1, sloppy taps leave it', () => {
  const sample = SAMPLES.find((s) => s.name === 'Tap Constellation')!
  // Five metronome-perfect taps, 500ms apart…
  const perfect = Array.from({ length: 5 }, (_, i) => ({ beat: i, time: i * 500 }))
  const rt = createRuntime({ tapRows: () => perfect })
  const stars = rt.run(sample.code, { seed: 1 }).views.get('stars')!.rows
  const creates = stars.filter((r) => r.event === 'create')
  assert.equal(creates.length, 5, 'one star per tap')
  for (const s of creates) {
    const rad = Math.hypot(s.px as number, s.py as number)
    assert.ok(Math.abs(rad - 1) < 1e-9, `a perfect tap sits on the ring (got ${rad})`)
  }

  // …then the middle tap lands a quarter-beat late: its star leaves the ring.
  const sloppy = perfect.map((r, i) => (i === 2 ? { ...r, time: r.time + 125 } : r))
  const off = createRuntime({ tapRows: () => sloppy }).run(sample.code, { seed: 1 })
    .views.get('stars')!.rows.filter((r) => r.event === 'create')
  const rads = off.map((s) => Math.hypot(s.px as number, s.py as number))
  assert.ok(Math.max(...rads) > 1.5, 'the late tap is pushed well off the ring')

  // Too few taps: the sketch asks for some instead of erroring.
  const hint = createRuntime({ tapRows: () => [] }).run(sample.code, { seed: 1 }).views.get('stars')!.rows
  assert.equal(hint[0].shape, 'text')
})
