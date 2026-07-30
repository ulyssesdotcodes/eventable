import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/runtime.js'
import { createEditableTableStore } from '../src/editable-tables.js'
import type { Row } from '../src/lineage.js'

test('cooks defined views and resolves table() dependencies', () => {
  const rt = createRuntime()
  const code = `
    define("nums", () => math(t => t * 30).range(4/30))
    define("doubled", (rand, table) => table("nums").map(r => ({ beat: r.beat, value: r.value * 2 })))
  `
  const { views } = rt.run(code, { seed: 1 })
  assert.deepEqual(views.get('nums')!.rows.map((r) => r.value), [0, 1, 2, 3])
  assert.deepEqual(views.get('doubled')!.rows.map((r) => r.value), [0, 2, 4, 6])
})

test('records the dependency edges it discovers', () => {
  const rt = createRuntime()
  const code = `
    define("a", () => rows([{ v: 1 }]))
    define("b", (rand, table) => table("a").map(r => ({ v: r.v + 1 })))
    define("c", (rand, table) => table("a").concat(table("b")))
  `
  const { deps } = rt.run(code, { seed: 1 })
  assert.deepEqual(deps.get('b'), ['a'])
  assert.deepEqual(deps.get('c'), ['a', 'b'])
})

test('a shared upstream view is cooked exactly once per run', () => {
  const rt = createRuntime()
  ;(globalThis as Record<string, unknown>).__cookCount = 0
  const code = `
    define("c", () => { globalThis.__cookCount++; return rows([{ v: 1 }]) })
    define("a", (rand, table) => table("c").map(r => ({ ...r, a: 1 })))
    define("b", (rand, table) => table("c").map(r => ({ ...r, b: 1 })))
  `
  rt.run(code, { seed: 1 })
  assert.equal((globalThis as Record<string, unknown>).__cookCount, 1)
  delete (globalThis as Record<string, unknown>).__cookCount
})

test('rand is deterministic for a given seed and varies by seed', () => {
  const rt = createRuntime()
  const code = `define("r", (rand) => math(() => rand()).range(6))`
  const a = rt.run(code, { seed: 42 }).views.get('r')!.rows.map((r) => r.value)
  const b = rt.run(code, { seed: 42 }).views.get('r')!.rows.map((r) => r.value)
  const c = rt.run(code, { seed: 7 }).views.get('r')!.rows.map((r) => r.value)
  assert.deepEqual(a, b, 'same seed → identical sequence')
  assert.notDeepEqual(a, c, 'different seed → different sequence')
  for (const v of a) assert.ok((v as number) >= 0 && (v as number) < 1, `rand in [0,1): ${v}`)
})

test("each view has an independent rand stream (order-independent)", () => {
  const rt = createRuntime()
  const code1 = `
    define("x", (rand) => math(() => rand()).range(3))
    define("y", (rand, table) => table("x").map(r => ({ v: rand() })))
  `
  const code2 = `
    define("y", (rand, table) => table("x").map(r => ({ v: rand() })))
    define("x", (rand) => math(() => rand()).range(3))
  `
  const x1 = rt.run(code1, { seed: 99 }).views.get('x')!.rows.map((r) => r.value)
  const x2 = rt.run(code2, { seed: 99 }).views.get('x')!.rows.map((r) => r.value)
  assert.deepEqual(x1, x2)
})

test('save() registers a constant view, still resolvable by table()', () => {
  const rt = createRuntime()
  const code = `
    rows([{ v: 1 }]).save("k")
    define("d", (rand, table) => table("k").map(r => ({ d: r.v + 1 })))
  `
  const { views } = rt.run(code, { seed: 1 })
  assert.equal(views.get('k')!.rows[0].v, 1)
  assert.equal(views.get('d')!.rows[0].d, 2)
})

test('table(name, source) registers a view without define()', () => {
  const rt = createRuntime()
  const code = `
    table("k", [{ v: 1 }])
    table("lazy", (rand, table) => table("k").map(r => ({ v: r.v + 1 })))
  `
  const { views } = rt.run(code, { seed: 1 })
  assert.equal(views.get('k')!.rows[0].v, 1)
  assert.equal(views.get('lazy')!.rows[0].v, 2)
})

test('table() without a name is ephemeral — usable but not a view', () => {
  const rt = createRuntime()
  const code = `table([{ beat: 2, v: 1 }]).map(r => ({ ...r })).outHydra()`
  const { views } = rt.run(code, { seed: 1 })
  assert.equal([...views.keys()].filter((n) => !n.includes('(system)')).length, 0, 'no named view registered')
  assert.equal(views.get('hydra (system)')!.rows[0].v, 1, 'routed rows still reach the consumer')
})

test('multiple outX() tables combine, beat-sorted, into one visible "(system)" view', () => {
  const rt = createRuntime()
  const code = `
    rows([{ beat: 5, tag: "a" }]).outHydra()
    table([{ beat: 1, tag: "b" }]).outHydra()
  `
  const { views } = rt.run(code, { seed: 1 })
  assert.deepEqual(views.get('hydra (system)')!.rows.map((r) => r.tag), ['b', 'a'])
})

test('routing takes precedence: a view named like the consumer is NOT merged into the combined output', () => {
  const rt = createRuntime()
  const code = `
    define("hydra", () => rows([{ beat: 1, tag: "named" }]))
    rows([{ beat: 2, tag: "routed" }]).outHydra()
  `
  const { views } = rt.run(code, { seed: 1 })
  assert.deepEqual(views.get('hydra (system)')!.rows.map((r) => r.tag), ['routed'],
    'by-name is only the no-routes fallback')
  assert.deepEqual(views.get('hydra')!.rows.map((r) => r.tag), ['named'], 'the named view still cooks on its own')

  // Explicitly routing the named table is how it stays in the mix.
  const both = rt.run(`
    define("hydra", () => rows([{ beat: 1, tag: "named" }]))
    table("hydra").outHydra()
    rows([{ beat: 2, tag: "routed" }]).outHydra()
  `, { seed: 1 })
  assert.deepEqual(both.views.get('hydra (system)')!.rows.map((r) => r.tag), ['named', 'routed'])
})

test('graph specs are resolved to their cooked tables', () => {
  const rt = createRuntime()
  const code = `define("g", () => math(t => t).range(3/30).graph("value"))`
  const { graphs } = rt.run(code, { seed: 1 })
  assert.equal(graphs.length, 1)
  assert.deepEqual(graphs[0].columns, ['value'])
  assert.equal(graphs[0].table.rows.length, 3)
})

test('resolving an undefined view throws a helpful error', () => {
  const rt = createRuntime()
  assert.throws(
    () => rt.run(`define("x", (rand, table) => table("missing"))`, { seed: 1 }),
    /missing/, // the error names the missing table (exact wording is free to change)
  )
})

test('a dependency cycle is detected', () => {
  const rt = createRuntime()
  const code = `
    define("a", (rand, table) => table("b"))
    define("b", (rand, table) => table("a"))
  `
  assert.throws(() => rt.run(code, { seed: 1 }), /cycle in cook/)
})

test('a group view merges its members, beat-sorted', () => {
  const rt = createRuntime()
  const code = `
    define("a", "g", () => rows([{ beat: 5, tag: "a" }, { beat: 1, tag: "a" }]))
    define("b", "g", () => rows([{ beat: 3, tag: "b" }, { beat: 0, tag: "b" }]))
  `
  const { views, deps } = rt.run(code, { seed: 1 })
  const g = views.get('g')!.rows
  assert.deepEqual(g.map((r) => r.beat), [0, 1, 3, 5], 'concatenated then beat-sorted')
  assert.deepEqual(deps.get('g')!.sort(), ['a', 'b'])
})

test('incremental cooking reuses an unchanged physics subgraph across runs', () => {
  let bakes = 0
  const engine = {
    simulate: (rows: Row[]): Row[] => {
      bakes++
      return [...rows, { id: 'x', event: 'update', beat: 2, py: 1 }]
    },
  }
  const rt = createRuntime({ physics: () => engine })
  const codeA = `
    define("base", () => rows([{ id: "x", event: "create", motion: "dynamic" }]))
    define("sim", (rand, table) => physics(table("base")).simulate({ steps: 1 }))
    define("out", (rand, table) => table("sim").map(r => ({ ...r })))
  `
  rt.run(codeA, { seed: 1 })
  assert.equal(bakes, 1)

  // Downstream edit + seed change: physics is reused from the memo.
  const codeB = codeA.replace('table("sim").map(r => ({ ...r }))', 'table("sim").map(r => ({ ...r, tag: 2 }))')
  rt.run(codeB, { seed: 2 })
  assert.equal(bakes, 1, 'editing a downstream view did not re-bake physics')

  const codeC = codeA.replace('{ steps: 1 }', '{ steps: 2 }')
  rt.run(codeC, { seed: 3 })
  assert.equal(bakes, 2, 'changing the physics opts re-bakes')
})

test('editable() reads rows from the editable-table store and is usable like any table', () => {
  const store = createEditableTableStore()
  store.createTable('scores')
  store.addRow('scores')
  store.setCell('scores', 0, 'value', 5)

  const rt = createRuntime({ editableRows: (name, schema) => store.ensure(name, schema) })
  const code = `
    define("scores", () => editable("scores", { value: "number" }))
    define("doubled", (rand, table) => table("scores").map(r => ({ value: r.value * 2 })))
  `
  const { views } = rt.run(code, { seed: 1 })
  assert.deepEqual(views.get('scores')!.rows.map((r) => r.value), [5])
  assert.deepEqual(views.get('doubled')!.rows.map((r) => r.value), [10])
})

test('editable() edits survive across runs (unlike a computed view)', () => {
  const store = createEditableTableStore()
  const rt = createRuntime({ editableRows: (name, schema) => store.ensure(name, schema) })
  const code = `define("t", () => editable("t", { value: "number" }))`

  rt.run(code, { seed: 1 })
  store.addRow('t')
  store.setCell('t', 0, 'value', 99)

  const { views } = rt.run(code, { seed: 2 })
  assert.deepEqual(views.get('t')!.rows.map((r) => r.value), [99])
})

test('editable() re-seeds the code rows the user has not edited when the program\'s seed changes', () => {
  const store = createEditableTableStore()
  const rt = createRuntime({ editableRows: (name, schema, seedRows) => store.ensure(name, schema, seedRows) })
  const withSeed = (a: number, b: number) =>
    `define("k", () => editable("k", { v: "number" }, [{ v: ${a} }, { v: ${b} }]))`

  rt.run(withSeed(1, 2), { seed: 1 })
  store.setCell('k', 1, 'v', 99) // the user edits the second row

  // The program's seed literal changes and it re-runs: the untouched first row
  // follows the new seed, the edited second row stays pinned.
  const out = rt.run(withSeed(11, 22), { seed: 1 })
  assert.deepEqual(out.views.get('k')!.rows.map((r) => r.v), [11, 99])
})

test('table() falls back to a streaming log for undefined names; program views win; unknowns still error', () => {
  const activity: Row[] = [
    { seq: 0, t: 0, kind: 'apply', id: 'a1', at: 1000 },
    { seq: 1, t: 5, kind: 'peer-join', client: 'c1' },
  ]
  const rt = createRuntime({ logRows: (name) => (name === 'activity' ? activity : null) })
  const { views } = rt.run(
    'define("applies", (rand, table) => table("activity").filter({ kind: "apply" }))',
    { seed: 1 },
  )
  assert.deepEqual(views.get('applies')!.rows.map((r) => r.id), ['a1'])

  // A program view of the same name shadows the log (mirroring the display
  // rule: a log tab yields to a cooked view of the same name)…
  const shadowed = rt.run(`
    define("activity", () => rows([{ kind: "apply", id: "mine" }]))
    define("applies", (rand, table) => table("activity"))
  `, { seed: 1 })
  assert.deepEqual(shadowed.views.get('applies')!.rows.map((r) => r.id), ['mine'])

  // …and a name the hook doesn't serve keeps the not-found error.
  assert.throws(
    () => rt.run('define("x", (rand, table) => table("nope"))', { seed: 1 }),
    /nope/,
  )
})

test('a log that grew between runs re-materializes (its rows hash by value, so the memo cannot serve stale history)', () => {
  const activity: Row[] = [{ seq: 0, kind: 'apply', id: 'a1' }]
  const rt = createRuntime({ logRows: (name) => (name === 'activity' ? activity : null) })
  const code = 'define("applies", (rand, table) => table("activity"))'
  assert.equal(rt.run(code, { seed: 1 }).views.get('applies')!.length, 1)
  activity.push({ seq: 1, kind: 'apply', id: 'a2' })
  assert.equal(rt.run(code, { seed: 1 }).views.get('applies')!.length, 2)
})
