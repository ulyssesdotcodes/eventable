import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLangEnv } from '../scripts/gen-lang-env.js'
import { createLangService } from '../src/lang-service.js'
import {
  curatedDocFor, DSL_BUILTIN_DOCS, TABLE_METHOD_DOCS, EXPR_NAMESPACE_DOCS, EXPR_METHOD_DOCS, THREE_METHOD_DOCS,
} from '../src/editor-support.js'

// One env + service for the whole file: building the env runs a real tsc
// declaration emit (~seconds), and the service reuses its program across
// queries exactly as the worker does.
const env = buildLangEnv()
const svc = createLangService(env)

const namesAt = (text: string, pos = text.length): string[] => {
  const res = svc.completionsAt(text, pos)
  assert.ok(res, `expected completions at ${pos} in ${JSON.stringify(text)}`)
  return res.entries.map((e) => e.name)
}

test('env: DSL surface enumerated from dsl.ts, declarations + libs present', () => {
  assert.ok(env.surfaceProps.includes('expr'))
  assert.ok(env.surfaceProps.includes('table'))
  assert.ok(env.surfaceProps.includes('origami'))
  assert.ok(env.files['/dts/dsl.d.ts'].includes('DSLSurface'))
  assert.ok(env.files['/globals.d.ts'].includes('const expr:'))
  assert.ok(env.files['/lib.es2022.d.ts'])
})

test('member completions on a Table chain come from the checker', () => {
  const names = namesAt('const t = table("sim")\nt.')
  for (const m of ['map', 'filter', 'rasterize', 'three', 'concat', 'rows']) {
    assert.ok(names.includes(m), `expected Table member ${m}`)
  }
  assert.ok(!names.includes('add'), 'Expr methods must not appear on a Table')
  assert.ok(!names.some((n) => n.startsWith('_')), 'internals are filtered out')
})

test('Expr chains complete Expr methods, not Table ones', () => {
  const names = namesAt('expr.field("v").gt(2).')
  for (const m of ['add', 'and', 'cond', 'mul']) assert.ok(names.includes(m), `expected Expr member ${m}`)
  assert.ok(!names.includes('rasterize'), 'Table methods must not appear on an Expr')
})

test('the expr namespace completes its sources', () => {
  const res = svc.completionsAt('expr.', 'expr.'.length)
  assert.ok(res && res.isMemberCompletion)
  const names = res.entries.map((e) => e.name)
  for (const m of ['field', 'lit', 'idx', 'midi', 'slider', 'time']) {
    assert.ok(names.includes(m), `expected expr.${m}`)
  }
})

test('a chain the old heuristic could not type still completes', () => {
  // The receiver is a local const holding a Table — no field()/table() chain
  // root in sight of the dot, so only the checker can answer this.
  const names = namesAt('const scene = t.box().concat(t.sphere())\nconst out = scene\nout.')
  assert.ok(names.includes('rasterize'))
  assert.ok(names.includes('three'))
})

test('.three completes the scene animators', () => {
  const res = svc.completionsAt('t.box().three.', 't.box().three.'.length)
  assert.ok(res && res.isMemberCompletion)
  for (const m of ['rotate', 'scale', 'move']) assert.ok(res.entries.some((e) => e.name === m), `expected animator ${m}`)
})

test('a scene builder completes its own props, each documented', () => {
  // The builders take typed props (not a bare Row), so a "{" inside the call
  // offers that shape's fields — the size fields it reads, the shared scene
  // fields, and for a light its own kind/intensity/….
  const mesh = namesAt('t.sphere({ ')
  for (const f of ['r', 'h', 'px', 'color', 'id']) assert.ok(mesh.includes(f), `expected scene field ${f}`)
  const light = namesAt('t.pointLight({ ')
  for (const f of ['kind', 'intensity', 'distance', 'groundColor']) {
    assert.ok(light.includes(f), `expected light field ${f}`)
  }
  // `kind` is the union, so its string literals complete too.
  const kinds = namesAt('t.light({ kind: "')
  for (const k of ['ambient', 'hemisphere']) assert.ok(kinds.includes(k), `expected light kind ${k}`)

  const d = svc.detailsAt('t.sphere({ ', 't.sphere({ '.length, 'r')
  assert.ok(d && d.docs.length > 0, 'a prop carries its hover doc')
})

test('globals include the DSL surface, console, and the ES library', () => {
  const names = namesAt('exp', 3)
  for (const g of ['expr', 'define', 'three', 't', 'console', 'Math']) assert.ok(names.includes(g), `expected global ${g}`)
})

test('quickinfo shows the complete signature', () => {
  const text = 't.box({ id: "a" }).rasterize(8)'
  const qi = svc.quickInfoAt(text, text.indexOf('rasterize') + 1)
  assert.ok(qi)
  assert.match(qi.display, /rasterize\(.*\): Table/)
  assert.equal(text.slice(qi.start, qi.end), 'rasterize')
})

test('quickinfo resolves overloads and locals', () => {
  const text = 'const t = table("x").map(r => r)\nt'
  const onMap = svc.quickInfoAt(text, text.indexOf('map') + 1)
  assert.ok(onMap)
  assert.match(onMap.display, /Table\.map/)
  assert.match(onMap.display, /overload/)
  const onLocal = svc.quickInfoAt(text, text.length - 1)
  assert.ok(onLocal)
  assert.match(onLocal.display, /const t: Table/)
})

test('completion details resolve the full member type', () => {
  const text = 'const t = table("sim")\nt.fil'
  const det = svc.detailsAt(text, text.length, 'filter')
  assert.ok(det)
  assert.match(det.display, /\(method\) Table\.filter/)
  assert.match(det.display, /Expr/)
})

test('signature help reports params and the active argument', () => {
  const text = 'table("x").orderBy('
  const sh = svc.signatureHelpAt(text, text.length, '(')
  assert.ok(sh)
  const item = sh.signatures[sh.activeSignature]
  assert.match(item.prefix, /orderBy\($/)
  assert.equal(item.params.length, 2)
  assert.match(item.params[0].label, /key/)
  assert.equal(sh.activeParameter, 0)

  const text2 = 'table("x").orderBy("beat", '
  const sh2 = svc.signatureHelpAt(text2, text2.length, ',')
  assert.ok(sh2)
  assert.equal(sh2.activeParameter, 1)
})

test('schemas namespace completes its members, each documented on hover', () => {
  const text = 'editable("hydra", schemas.'
  const res = svc.completionsAt(text, text.length)
  assert.ok(res && res.isMemberCompletion)
  const names = res.entries.map((e) => e.name)
  for (const s of ['hydra', 'sliders', 'path', 'origami']) assert.ok(names.includes(s), `expected schemas.${s}`)

  const text2 = 'editable("hydra", schemas.hydra)'
  const qi = svc.quickInfoAt(text2, text2.indexOf('.hydra') + 2)
  assert.ok(qi)
  assert.match(qi.display, /hydra/, 'hover resolves the concrete schema type')
  assert.ok(qi.docs.length > 0)

  // The bare global carries the surface member's JSDoc too (the generator
  // copies it onto the generated const — an indexed-access type alone
  // wouldn't), and every schema member has a docstring.
  const onGlobal = svc.quickInfoAt(text2, text2.indexOf('schemas') + 1)
  assert.ok(onGlobal && onGlobal.docs.length > 0, 'the bare global carries docs')
  for (const s of ['sliders', 'path', 'origami'] as const) {
    const t = `schemas.${s}`
    const d = svc.quickInfoAt(t, t.length - 1)
    assert.ok(d && d.docs.length > 0, `expected a docstring on schemas.${s}`)
  }
})

test('no answers inside an unparseable mess still return gracefully', () => {
  const qi = svc.quickInfoAt('((((', 2)
  assert.equal(qi, null)
})

const hydraSvc = createLangService(env, 'hydra')

test('hydra: generators, sources, outputs, and expr are globals; the DSL is not', () => {
  const res = hydraSvc.completionsAt('os', 2)
  assert.ok(res)
  const names = res.entries.map((e) => e.name)
  for (const g of ['osc', 'noise', 'src', 'shape', 'voronoi', 's0', 'o0', 'expr']) {
    assert.ok(names.includes(g), `expected hydra global ${g}`)
  }
  assert.ok(!names.includes('table'), 'DSL surface must not leak into hydra sketches')
})

test('hydra: chains complete the modifier methods', () => {
  const text = 'osc(10).'
  const res = hydraSvc.completionsAt(text, text.length)
  assert.ok(res && res.isMemberCompletion)
  const names = res.entries.map((e) => e.name)
  for (const m of ['modulate', 'kaleid', 'rotate', 'color', 'out']) {
    assert.ok(names.includes(m), `expected chain method ${m}`)
  }
  assert.ok(!names.includes('rasterize'), 'Table methods must not appear on a hydra chain')
})

test('hydra: quickinfo resolves the generated signatures with their docs', () => {
  const text = 'osc(10).modulate(noise(3), 0.2).out(o0)'
  const onOsc = hydraSvc.quickInfoAt(text, 1)
  assert.ok(onOsc)
  assert.match(onOsc.display, /osc\(.*\): HydraChain/)
  assert.match(onOsc.docs, /default/i, 'docs carry the generated defaults')
  const onModulate = hydraSvc.quickInfoAt(text, text.indexOf('modulate') + 1)
  assert.ok(onModulate)
  assert.match(onModulate.display, /modulate\(.*\): HydraChain/)
})

test('hydra: signature help works on generator calls', () => {
  const text = 'osc('
  const sh = hydraSvc.signatureHelpAt(text, text.length, '(')
  assert.ok(sh)
  const item = sh.signatures[sh.activeSignature]
  assert.match(item.prefix, /osc\($/)
  assert.equal(item.params.length, 3)
  assert.match(item.params[0].label, /frequency/)
})

test('hydra: the DSL program keeps its own surface (no hydra leak)', () => {
  const names = namesAt('osc', 3)
  assert.ok(!names.includes('osc'), 'hydra generators must not leak into the DSL program')
})

test('curatedDocFor picks the doc table from the chain context', () => {
  const t1 = 'table("x").map'
  assert.equal(curatedDocFor(t1, t1.indexOf('map'), 'map'), TABLE_METHOD_DOCS.map)
  const t2 = 'expr.field("v").gt'
  assert.equal(curatedDocFor(t2, t2.indexOf('gt'), 'gt'), EXPR_METHOD_DOCS.gt)
  const t3 = 't.box().three.rotate'
  assert.equal(curatedDocFor(t3, t3.indexOf('rotate'), 'rotate'), THREE_METHOD_DOCS.rotate)
  const t4 = 'expr.time'
  assert.equal(curatedDocFor(t4, t4.indexOf('time'), 'time'), EXPR_NAMESPACE_DOCS.time)
  assert.equal(curatedDocFor('expr', 0, 'expr'), DSL_BUILTIN_DOCS.expr)
  assert.equal(curatedDocFor('const x = 1', 6, 'x'), null)
})

test('expr cells: the "=" surface completes bare sources and chain methods', () => {
  const exprSvc = createLangService(env, 'expr')
  const bare = exprSvc.completionsAt('sl', 2)
  assert.ok(bare)
  const bareNames = bare.entries.map((e) => e.name)
  for (const m of ['slider', 'sin', 'progress', 'loop', 'clamp', 'tau', 'field']) {
    assert.ok(bareNames.includes(m), `expected bare ${m} in the expr surface`)
  }
  assert.ok(!bareNames.includes('table'), 'DSL surface must not leak into expr cells')
  const chain = exprSvc.completionsAt('slider("h").', 'slider("h").'.length)
  assert.ok(chain)
  const chainNames = chain.entries.map((e) => e.name)
  for (const m of ['mul', 'sin', 'clamp', 'lerp']) {
    assert.ok(chainNames.includes(m), `expected Expr member ${m} on a bare slider() chain`)
  }
})

test('post cells: the chain surface completes fx ops AND generator heads', () => {
  const postSvc = createLangService(env, 'post')
  const bare = postSvc.completionsAt('bl', 2)
  assert.ok(bare)
  const bareNames = bare.entries.map((e) => e.name)
  // Heads are globals only — they start a chain from a synthesised field — so a
  // fx-only surface silently hides every generator (the regression this pins).
  for (const m of ['blur', 'bloom', 'mask', 'scene', 'prev', 'gradient', 'noise', 'voronoi', 'stripes', 'fill']) {
    assert.ok(bareNames.includes(m), `expected bare ${m} in the post surface`)
  }
  const chain = postSvc.completionsAt('noise(4).', 'noise(4).'.length)
  assert.ok(chain)
  const chainNames = chain.entries.map((e) => e.name)
  for (const m of ['thresh', 'polar', 'blend']) {
    assert.ok(chainNames.includes(m), `expected PostChain member ${m} on a generator head`)
  }
})
