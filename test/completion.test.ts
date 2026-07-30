import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chainRoot, isExprDot, isExprNamespaceDot, isThreeDot } from '../src/completion.js'

const rootAt = (s: string): string | null => {
  const dot = s.lastIndexOf('.')
  return chainRoot(s, dot)
}
const exprAt = (s: string): boolean => {
  const dot = s.lastIndexOf('.')
  return isExprDot(s, dot)
}

test('Expr chains resolve to their expr-namespace root', () => {
  assert.equal(rootAt('expr.time().'), 'expr')
  assert.equal(rootAt('expr.field("v").gt(2).cond(1, 0).'), 'expr')
})

test('Table chains resolve to their table/rows/etc. root', () => {
  assert.equal(rootAt('table("sim").'), 'table')
  assert.equal(rootAt('physics(table("base")).simulate({ steps: 1 }).'), 'physics')
})

test('isExprDot distinguishes Expr from Table receivers', () => {
  assert.equal(exprAt('expr.field("index").add(0.05).'), true)
  assert.equal(exprAt('table("sim").'), false)
  assert.equal(exprAt('table("sim").filter(expr.field("type").eq("x")).'), false,
    'the OUTER dot is on a Table even though an Expr appears inside the args')
  assert.equal(exprAt('table("sim").filter(expr.field("type").'), true,
    'an Expr nested inside call args is detected at its own dot')
})

test('isExprNamespaceDot fires only on the bare expr global, not later in the chain', () => {
  const nsAt = (s: string): boolean => isExprNamespaceDot(s, s.lastIndexOf('.'))
  assert.equal(nsAt('expr.'), true)
  assert.equal(nsAt('derive({ py: expr.'), true)
  assert.equal(nsAt('expr.field("v").'), false, 'a call result is an Expr, not the namespace')
  assert.equal(nsAt('foo.expr.'), false, 'a member named expr is not the global')
  assert.equal(exprAt('expr.'), false, 'the namespace dot must not offer Expr methods')
})

test('nested parens and strings (with dots/parens inside) are skipped', () => {
  assert.equal(rootAt('expr.field("a.b)(c").mul( (1 + 2) ).'), 'expr')
  assert.equal(rootAt('table("x").map(r => ({ v: r.v })).'), 'table')
})

test('isThreeDot fires only right after a .three accessor', () => {
  const threeAt = (s: string): boolean => isThreeDot(s, s.lastIndexOf('.'))
  assert.equal(threeAt('box().three.'), true)
  assert.equal(threeAt('box({ id: "a" }).three.'), true)
  assert.equal(threeAt('scene.three.'), true)
  // The dot after box() offers `.three` among table methods — not the animators.
  assert.equal(threeAt('box().'), false)
  // After an animator call the receiver is a Table again, not the accessor.
  assert.equal(threeAt('box().three.rotate({ amount: 1 }).'), false)
  assert.equal(threeAt('table("scene").'), false)
})

test('non-chain receivers return null / not-Expr', () => {
  assert.equal(rootAt('(1 + 2).'), null)
  assert.equal(exprAt('(1 + 2).'), false)
})
