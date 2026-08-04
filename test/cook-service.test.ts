// Tests for off-main-thread cooking: the transfer layer (what survives the
// worker boundary) and the cook service (the worker's whole request→response
// behavior, driven directly — cook-worker.ts is only a postMessage shell).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { packRows, unpackRows, unpackCooked } from '../src/cook-transfer.js'
import { createCookService, type CookResponse } from '../src/cook-service.js'
import { createCookClient, type WorkerLike } from '../src/cook-client.js'
import { getLineage, withLineage, type Row } from '../src/lineage.js'
import { EASINGS } from '../src/dsl.js'

// Simulate the structured clone a real postMessage performs: symbol keys are
// dropped, functions would throw (the pack layer must have removed them).
function structuredCloneLike(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v))
}

test('pack/unpack round-trips functions through a structured clone', () => {
  const rows: Row[] = [{ beat: 1, ease: EASINGS.easeInOut, fn: (t: number) => t * 2 }]
  const out = unpackRows(structuredCloneLike(packRows(rows)) as Row[])
  const ease = out[0].ease as (t: number) => number
  const fn = out[0].fn as (t: number) => number
  assert.equal(ease(0.25), EASINGS.easeInOut(0.25))
  assert.equal(fn(3), 6)
})

test('pack/unpack preserves lineage across the symbol-dropping boundary', () => {
  const rows = [withLineage({ beat: 1, x: 2 }, [{ table: 'wave', index: 3 }])]
  const out = unpackRows(structuredCloneLike(packRows(rows)) as Row[])
  assert.deepEqual(getLineage(out[0]), [{ table: 'wave', index: 3 }])
  assert.deepEqual(Object.keys(out[0]), ['beat', 'x'], 'the $lineage carrier field does not leak into columns')
})

test('streaming bindings ({ $expr }) pass through untouched', () => {
  const binding = { $expr: { k: 'midi', note: 'c4', channel: null } }
  const rows: Row[] = [{ beat: 1, value: binding }]
  const out = unpackRows(structuredCloneLike(packRows(rows)) as Row[])
  assert.deepEqual(out[0].value, binding)
})

test('a shared object crosses the boundary once, not once per row', () => {
  // rasterize stamps the SAME compiled program (megabytes of baked origami
  // keyframes) onto every dense frame row; naive per-row deep copies blew
  // postMessage out of memory. Structured clone dedups shared references, so
  // pack/unpack must preserve the sharing.
  const program = { kind: 'fold-table', frames: [[0, 0, 0], [1, 1, 1]] }
  const rows: Row[] = Array.from({ length: 4 }, (_, i) => ({ frame: i, program }))
  const packed = packRows(rows)
  assert.equal(packed[0].program, packed[1].program, 'packed rows share one program object')
  const out = unpackRows(structuredClone(packed) as Row[])
  assert.equal(out[0].program, out[3].program, 'unpacked rows share one program object')
  assert.deepEqual(out[0].program, program, 'and it round-trips intact')
})



const req = (code: string, extra: Partial<Parameters<ReturnType<typeof createCookService>['handle']>[0]> = {}) => ({
  id: 1,
  code,
  seed: 1,
  dataCache: [] as Array<[string, string]>,
  tapRows: [] as Row[],
  editables: [] as Array<{ name: string; rows: Row[] }>,
  ...extra,
})

test('the service cooks a program end-to-end and the packed result unpacks to tables', () => {
  const service = createCookService()
  const resp = service.handle(req(`
define("base", "three", () => grid(2, 2).derive({
  id: r => "o" + r.i, event: "create", beat: 1, shape: "sphere",
  rx: 0, ry: 0, rz: 0, color: 0x4444ff,
}))
define("scene", () => table("three").rasterize(4/30))
`))
  assert.equal(resp.ok, true)
  if (!resp.ok) return
  const cooked = unpackCooked(structuredCloneLike(resp.cooked) as typeof resp.cooked)
  assert.equal(cooked.views.get('base')!.length, 4)
  assert.ok(cooked.scene.objects.length > 0, 'the scene store came through')
  assert.ok(getLineage(cooked.views.get('scene')!.rows[0]).length > 0, 'lineage survives the boundary')
})

test('editable() serves the snapshot when present, else conformed seeds, and reports declarations', () => {
  const service = createCookService()
  const program = `
editable("notes", { beat: "number", x: "number" }, [{ beat: 1, x: 5 }])
define("out", (rand, table) => table("notes"))
`
  const fresh = service.handle(req(program))
  assert.equal(fresh.ok, true)
  if (!fresh.ok) return
  assert.deepEqual(fresh.declared, [{ name: 'notes', schema: { beat: 'number', x: 'number' }, seedRows: [{ beat: 1, x: 5 }] }])
  assert.deepEqual(unpackCooked(fresh.cooked).views.get('out')!.rows.map((r) => ({ beat: r.beat, x: r.x })), [{ beat: 1, x: 5 }])

  const edited = service.handle(req(program, { id: 2, editables: [{ name: 'notes', rows: [{ beat: 2, x: 9 }] }] }))
  assert.equal(edited.ok, true)
  if (!edited.ok) return
  assert.deepEqual(unpackCooked(edited.cooked).views.get('out')!.rows.map((r) => ({ beat: r.beat, x: r.x })), [{ beat: 2, x: 9 }])
})

// A computed table is the natural thing to hand editable() as a seed
// (editable("post", schemas.post, paper.folds().flatMap(…))). It used to ride
// back in the declaration as a live Table, which structured clone rejects —
// the response never left the worker and the cook hung forever.
test('a table seeds an editable, and the declaration crosses the boundary as plain rows', () => {
  const service = createCookService()
  const resp = service.handle(req(`
define("src", () => rows([{ beat: 1, x: 2 }]))
editable("notes", { beat: "number", x: "number" }, table("src"))
`))
  assert.equal(resp.ok, true)
  if (!resp.ok) return
  structuredClone(resp)
  assert.deepEqual(resp.declared[0].seedRows!.map((r) => ({ beat: r.beat, x: r.x })), [{ beat: 1, x: 2 }])
})

test('tap rows flow into tempo() and a broken program returns an error response', () => {
  const service = createCookService()
  const taps = [{ beat: 0, time: 0 }, { beat: 1, time: 250 }]
  const resp = service.handle(req('define("t", () => rows([{ beat: 1, bs: tempo() }]))', { tapRows: taps }))
  assert.equal(resp.ok, true)
  if (resp.ok) assert.equal(unpackCooked(resp.cooked).views.get('t')!.rows[0].bs, 0.25)

  const broken = service.handle(req('not a program ('))
  assert.equal(broken.ok, false)
  if (!broken.ok) assert.ok(broken.error.length > 0)
})

test('the client resolves each cook against its own response id', async () => {
  // A fake worker wired straight to a real service, answering out of order.
  const service = createCookService()
  let listener: ((e: { data: unknown }) => void) | null = null
  const held: CookResponse[] = []
  const fakeWorker: WorkerLike = {
    addEventListener: (_t, cb) => { listener = cb },
    postMessage: (msg) => { held.push(service.handle(structuredCloneLike(msg) as Parameters<typeof service.handle>[0])) },
  }
  const client = createCookClient(fakeWorker)
  const a = client.cook({ code: 'define("a", () => rows([{ beat: 1 }]))', seed: 1, dataCache: new Map(), tapRows: [], editables: [] })
  const b = client.cook({ code: 'broken (', seed: 1, dataCache: new Map(), tapRows: [], editables: [] })
  // Deliver b's response first, then a's.
  listener!({ data: structuredCloneLike(held[1]) })
  listener!({ data: structuredCloneLike(held[0]) })
  const aOut = await a
  assert.equal(aOut.cooked.views.get('a')!.length, 1)
  await assert.rejects(b)
})

test('streaming logs ride the request: table("activity") resolves, and a declared editable always has a (possibly empty) history', () => {
  const service = createCookService()
  const program = `
editable("notes", { x: "number" }, [{ x: 1 }])
define("edits", (rand, table) => table("notes·events"))
define("applies", (rand, table) => table("activity"))
`
  // First cook of a fresh table: the store has no "notes·events" yet, but
  // declaring editable("notes") guarantees the history reads as empty rather
  // than table-not-found.
  const resp = service.handle(req(program, {
    logs: [{ name: 'activity', rows: [{ seq: 0, kind: 'apply', id: 'a1' }] }],
  }))
  assert.equal(resp.ok, true)
  if (!resp.ok) return
  const cooked = unpackCooked(resp.cooked)
  assert.deepEqual(cooked.views.get('applies')!.rows.map((r) => r.id), ['a1'])
  assert.equal(cooked.views.get('edits')!.length, 0)

  // Once the store has history, the request carries it and the view sees it.
  const later = service.handle(req(program, {
    id: 2,
    editables: [{ name: 'notes', rows: [{ x: 2 }] }],
    logs: [
      { name: 'activity', rows: [] },
      { name: 'notes·events', rows: [{ seq: 3, kind: 'set-cell', row: 0, col: 'x', value: 2 }] },
    ],
  }))
  assert.equal(later.ok, true)
  if (later.ok) {
    assert.deepEqual(unpackCooked(later.cooked).views.get('edits')!.rows.map((r) => r.kind), ['set-cell'])
  }
})

test('slider declarations — expr.slider and post-cell slider() — ride the response, one per name, last wins', () => {
  const service = createCookService()
  const resp = service.handle(req(`
define("v", () => rows([{ beat: 1 }]).derive({
  py: expr.slider("height", 0, 2),
  pz: expr.slider("depth"),
  pw: expr.slider("height", 0, 4),
}))
define("post", () => rows([{ beat: 1, event: "setCode", code: 'blur(slider("glow", 1, 5))' }]))
`))
  assert.equal(resp.ok, true)
  if (!resp.ok) return
  assert.deepEqual(
    resp.sliders,
    [{ id: 'height', min: 0, max: 4 }, { id: 'depth' }, { id: 'glow', min: 1, max: 5 }],
    'one per name (last declaration wins); omitted min/max stay unset; post cells scanned too',
  )
})

test('expr.slider in a hydra code cell declares through the cook', () => {
  const service = createCookService()
  const resp = service.handle(req('editable("hydra", schemas.hydra)', {
    editables: [{
      name: 'hydra',
      rows: [{ beat: 1, event: 'setCode', code: 'osc(expr.slider("h", 0, 2)).out(o0)', out: 'o0' }],
    }],
  }))
  assert.ok(resp.ok)
  assert.ok(resp.sliders.some((s) => s.id === 'h' && s.min === 0 && s.max === 2))
})

// Typed arrays are what per-frame geometry and run-length tracks will be made
// of; structured clone handles them natively, so packing must leave them
// alone rather than walking them into { 0: …, 1: … }.
test('typed arrays cross the boundary as typed arrays, still shared', () => {
  const verts = new Float32Array([0, 1, 2, 3])
  const rows: Row[] = [{ id: 'p', frame: 0, verts }, { id: 'p', frame: 1, verts }]
  const packed = packRows(rows)
  assert.ok(packed[0].verts instanceof Float32Array, 'not rebuilt as a plain object')
  assert.equal(packed[0].verts, packed[1].verts, 'and still one object')
  const out = unpackRows(packed)
  assert.ok(out[0].verts instanceof Float32Array)
  assert.deepEqual([...(out[0].verts as Float32Array)], [0, 1, 2, 3])
})
