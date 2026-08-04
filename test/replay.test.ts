import { test } from 'node:test'
import { storeRows } from '../src/rasterize.js'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/runtime.js'
import { cookProgram } from '../src/replay.js'

const PROG = (n: number): string => `
  define("base", () => rows([{ id: "s", event: "create", beat: 1, shape: "sphere",
    color: 0x4a9eff, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
  define("noise", (rand) => math(() => rand()).range(${n}/30))
  define("three", (rand, table) => table("base"))
  define("scene", (rand, table) => table("three").rasterize(${n}/30))
`

test('cookProgram resolves the scene cache and is deterministic per seed', () => {
  const rt = createRuntime()
  const a = cookProgram(rt, PROG(8), 123)
  const b = cookProgram(rt, PROG(8), 123)
  assert.ok(a.scene.objects.length > 0)
  assert.deepEqual(storeRows(a.scene), storeRows(b.scene))
  assert.deepEqual(
    a.views.get('noise')!.rows.map((r) => r.value),
    b.views.get('noise')!.rows.map((r) => r.value),
    'same seed → identical noise',
  )
})

test('cookProgram falls back to rasterizing the three table when there is no scene view', () => {
  const rt = createRuntime()
  const code = `
    define("three", () => rows([{ id: "s", event: "create", beat: 1, shape: "box",
      color: 1, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
  `
  const cooked = cookProgram(rt, code, 1)
  assert.ok(cooked.scene.objects.length > 0, 'the three table became a scene store')
  assert.equal(storeRows(cooked.scene)[0].shape, 'box')
})

test('the legacy "events" table name still cooks into the scene cache', () => {
  const rt = createRuntime()
  const code = `
    define("events", () => rows([{ id: "s", event: "create", beat: 1, shape: "box",
      color: 1, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
  `
  const cooked = cookProgram(rt, code, 1)
  assert.ok(cooked.scene.objects.length > 0, 'saved sessions using "events" still render')
})

test('outX() routing feeds the consumers with no define() and no names', () => {
  const rt = createRuntime()
  const code = `
    t.box({ color: 1 }).outThree()
    table([{ beat: 1, event: "setCode", code: "osc().out()" }]).outHydra()
  `
  const cooked = cookProgram(rt, code, 1)
  assert.ok(cooked.scene.objects.length > 0, 'a routed three table becomes the scene store')
  assert.equal(storeRows(cooked.scene)[0].shape, 'box')
  assert.equal(cooked.hydraRows.length, 1)
  assert.equal(cooked.hydraRows[0].code, 'osc().out()')
})

test('outX() takes precedence over a name-defined consumer table', () => {
  const rt = createRuntime()
  const code = `
    define("hydra", () => rows([{ beat: 1, event: "setCode", code: "osc().out()" }]))
    rows([{ beat: 2, event: "setVariable", name: "amount", value: 3 }]).outHydra()
  `
  const cooked = cookProgram(rt, code, 1)
  assert.deepEqual(cooked.hydraRows.map((r) => r.event), ['setVariable'],
    'once anything routes, only routed tables play — by-name is the no-routes fallback')
})

test('cookProgram surfaces a broken post chain (e.g. a trailing comment) as an error', () => {
  const rt = createRuntime()
  const code = `
    define("post", () => rows([{ beat: 1, event: "setCode", code: "edges(0.2)\\n// glow" }]))
  `
  assert.throws(() => cookProgram(rt, code, 1))
})

test('cookProgram surfaces the hydra setCode/setVariable rows from the "hydra" view', () => {
  const rt = createRuntime()
  const code = `
    define("base", () => rows([{ id: "s", event: "create", beat: 1, shape: "box",
      color: 1, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
    define("scene", (rand, table) => table("base").rasterize(1/30))
    define("hydra", () => rows([
      { beat: 1, event: "setCode", code: "src(s0).modulate(noise(amount)).out()" },
      { beat: 1, event: "setVariable", name: "amount", value: 3 },
    ]))
  `
  const cooked = cookProgram(rt, code, 1)
  assert.equal(cooked.hydraRows.length, 2)
  assert.equal(cooked.hydraRows[0].code, 'src(s0).modulate(noise(amount)).out()')
  assert.equal(cooked.hydraRows[1].value, 3)
  assert.ok(cooked.scene.objects.every((o) => o.id === 's'))
})

test('hydra variables can be data-driven from another view without cycling', () => {
  const rt = createRuntime()
  const code = `
    define("sim", () => rows([
      { id: "s", event: "create", beat: 1, shape: "box", color: 1,
        px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 },
      { id: "s", event: "collision", beat: 3, other: "floor" },
    ]))
    define("scene", (rand, table) => table("sim").rasterize(1/30))
    define("hydra", (rand, table) =>
      rows([
        { beat: 1, event: "setCode", code: "src(s0).modulate(noise(amount)).out()" },
        { beat: 1, event: "setVariable", name: "amount", value: 0.2 },
      ]).concat(
        table("sim")
          .filter({ event: "collision", other: "floor" })
          .map(r => ({ beat: r.beat, event: "setVariable", name: "amount", value: 2.6 }))
      ))
  `
  const cooked = cookProgram(rt, code, 1)
  const bump = cooked.hydraRows.find((r) => r.value === 2.6)
  assert.ok(bump, 'a collision-driven variable change was emitted')
  assert.equal(bump!.beat, 3)
})
