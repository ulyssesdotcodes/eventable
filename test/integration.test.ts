import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/runtime.js'
import { getLineage } from '../src/lineage.js'
import { compileFoldTable, meshAt, type MeshAnim } from '../src/fold-engine.js'

// The scene row carries the paper as a baked MESH, so geometry assertions read
// what is actually drawn. Positions come back flat, and Float32 storage means
// "flat" is a small tolerance rather than an exact zero.
const meshOf = (rows: { event?: unknown; mesh?: unknown }[]): MeshAnim =>
  rows.find((r) => r.event === 'create')!.mesh as MeshAnim
const posAt = (m: MeshAnim, fold: number): [number, number, number][] => {
  const { verts } = meshAt(m, fold)
  const out: [number, number, number][] = []
  for (let i = 0; i < verts.length; i += 3) out.push([verts[i], verts[i + 1], verts[i + 2]])
  return out
}
// Fold-level facts (names, kinds, how far each swings) are the compiler's, not
// the scene row's — compile the sample's own fold table for those.
const programOf = (sample: { tables?: Record<string, Record<string, unknown>[]> }, table: string) =>
  compileFoldTable(sample.tables![table], { size: 1 })
import { conformRow, schemaColumns, invalidColumns, type ColumnType } from '../src/editable-tables.js'
import { SAMPLES } from '../src/samples.js'
import { buildHydraIndex, hydraFrameAt } from '../src/hydra.js'
import { beatToFrame } from '../src/constants.js'
import { rasterizeRows } from '../src/rasterize.js'
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
  const mesh = meshOf(events.rows)
  const program = programOf(sample, 'origami')
  assert.equal(mesh.kind, 'mesh-anim')
  assert.equal(mesh.steps.length, 17)
  assert.equal(program.steps.length, 17)
  assert.equal(program.steps[16].name, 'wings')
  assert.equal(program.steps[16].to, 0.5)
  assert.equal(mesh.steps[16].faces.length, 74)
  // solved fold kinds: the collapse and the point folds are reverse folds
  const kinds = program.steps.map((s) => s.type)
  assert.equal(kinds.filter((k) => k === 'Inside Reverse').length, 9)

  // the schedule drives one numeric: fold rises 0 → 16.5 and never falls
  const folds = events.rows
    .filter((r) => r.event === 'update' && typeof r.fold === 'number')
    .sort((a, b) => (a.beat as number) - (b.beat as number))
    .map((r) => r.fold as number)
  assert.equal(folds[folds.length - 1], 16.5)
  for (let i = 1; i < folds.length; ++i) assert.ok(folds[i] >= folds[i - 1])

  // exact states at every landed fold: all flat (|z| only layer nudges = 0
  // here, raw positions), and the finished pose has the wings up
  for (let k = 0; k <= 16; ++k) {
    for (const p of posAt(mesh, k)) assert.ok(Math.abs(p[2]) < 1e-6, `state ${k} is flat`)
  }
  const zMax = Math.max(...posAt(mesh, 16.5).map((p) => p[2]))
  assert.ok(zMax > 0.5, `wings rise out of plane (z ${zMax.toFixed(2)})`)

  // Playback rasterizes the routed events into the scene cache automatically —
  // the baked frames must carry the same fold track.
  const sceneRows = rasterizeRows(events.rows)
  const withFold = sceneRows.filter((r) => typeof r.fold === 'number')
  assert.ok(withFold.length > 0, 'scene frames carry fold')
  const last = withFold[withFold.length - 1]
  assert.equal(last.fold, 16.5)
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

    const mesh = meshOf(views.get(outViewName('three'))!.rows)
    assert.equal(mesh.kind, 'mesh-anim')
    assert.equal(mesh.steps.length, steps)

    // the finished flower lies flat
    const pos = posAt(mesh, steps)
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

  const track = (id: string): [number, number][] => rows
    .filter((r) => r.id === id && r.event === 'update' && typeof r.fold === 'number')
    .map((r) => [r.beat as number, r.fold as number] as [number, number])
    .sort((a, b) => a[0] - b[0])

  // the lotus folds up, then .retime(pingpong) folds the very same run back
  // down to a flat square — no hand-mirrored rows
  const a = track('flowerA')
  const peak = Math.max(...a.map(([, f]) => f))
  const peakBeat = a.find(([, f]) => f === peak)![0]
  assert.ok(peak >= 11, 'lotus reaches its full fold')
  assert.ok(a[a.length - 1][1] < 0.5, 'lotus unfolds back to a flat square')
  assert.ok(a[a.length - 1][0] > peakBeat, 'the unfold comes after the bloom')

  // the lily then folds up from that square
  const b = track('flowerB')
  assert.equal(b[0][1], 0, 'the lily starts from a square')
  assert.ok(Math.max(...b.map(([, f]) => f)) >= 7, 'the lily folds into its bloom')
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
  const mesh = meshOf(events.rows)
  const program = programOf(sample, 'origami')
  assert.equal(mesh.steps.length, 9)
  for (const step of program.steps) assert.equal(step.type, 'Pureland')
  for (let k = 0; k <= 9; ++k) {
    for (const p of posAt(mesh, k)) assert.ok(Math.abs(p[2]) < 1e-6, `state ${k} flat`)
  }
  const xs = posAt(mesh, 9).map((p) => p[0])
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
