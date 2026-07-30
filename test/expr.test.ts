import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Table, createDSL, field, lit, midi, slider, progress, hashOf, isStreamingNode, evalExpr } from '../src/dsl.js'
import { getLineage, withLineage, type Row } from '../src/lineage.js'
import { buildTimeline } from '../src/timeline.js'

const t = (rows: Row[]): Table => new Table(rows)

test('map(template) builds rows from Expr + literals', () => {
  const out = t([{ a: 1 }, { a: 2 }]).map({ b: field('a').add(10), c: 5 })
  assert.deepEqual(out.rows, [{ b: 11, c: 5 }, { b: 12, c: 5 }])
})

test('arithmetic chains evaluate left-to-right', () => {
  const out = t([{ a: 2 }]).map({ v: field('a').mul(3).add(1).sub(2) })
  assert.deepEqual(out.rows, [{ v: 5 }]) // 2*3=6, +1=7, -2=5
})

test('and/or/not compose predicates', () => {
  const base = t([
    { event: 'collision', other: 'floor' },
    { event: 'collision', other: 'wall' },
    { event: 'update', other: 'floor' },
  ])
  const out = base.filter(field('event').eq('collision').and(field('other').eq('floor')))
  assert.deepEqual(out.rows, [{ event: 'collision', other: 'floor' }])
})

test('cond picks a value declaratively', () => {
  const out = t([{ v: 1 }, { v: 9 }]).map({ big: field('v').gt(5).cond('yes', 'no') })
  assert.deepEqual(out.rows, [{ big: 'no' }, { big: 'yes' }])
})

test('emit fans each row out to one or many rows from templates', () => {
  const out = t([{ i: 0 }, { i: 1 }]).emit([{ x: field('i') }, { x: field('i').add(10) }])
  assert.deepEqual(out.rows, [{ x: 0 }, { x: 10 }, { x: 1 }, { x: 11 }])
})

test('call nodes evaluate through the registry: sin, clamp, lerp', () => {
  const out = t([{ a: 0.5 }]).map({
    s: lit(Math.PI / 2).sin(),
    c: field('a').clamp(0, 0.2),
    l: lit(0).lerp(10, field('a')),
  })
  assert.deepEqual(out.rows, [{ s: 1, c: 0.2, l: 5 }])
})

test('streaming-ness propagates through call args', () => {
  assert.equal(isStreamingNode(lit(1).sin().node), false)
  assert.equal(isStreamingNode(slider('x').sin().node), true)
  assert.equal(isStreamingNode(lit(0).lerp(slider('x'), 0.5).node), true)
})

test('unsubstituted progress() is streaming and reads 1 — the graceful degrade', () => {
  assert.equal(isStreamingNode(progress().node), true)
  assert.equal(evalExpr(progress().node, {}, 0), 1)
})

test('hashOf is structural: same graph+input hash equal, any change differs', () => {
  const base = t([{ v: 1 }]).map({ v: field('v').clamp(0, 1) })
  assert.equal(hashOf(base), hashOf(t([{ v: 1 }]).map({ v: field('v').clamp(0, 1) })))
  assert.notEqual(hashOf(base), hashOf(t([{ v: 1 }]).map({ v: field('v').clamp(0, 2) })), 'arg')
  assert.notEqual(hashOf(base), hashOf(t([{ v: 1 }]).map({ v: field('v').abs() })), 'fn')
  assert.notEqual(hashOf(base), hashOf(t([{ v: 2 }]).map({ v: field('v').clamp(0, 1) })), 'input rows')
  const filt = t([{ v: 1 }]).filter(field('v').gt(1))
  assert.notEqual(hashOf(filt), hashOf(t([{ v: 1 }]).filter(field('v').gt(2))), 'filter spec')
  // Retargeting a midi binding must invalidate the cook memo — the one axis
  // here with a user-visible failure mode.
  const bind = t([{ id: 'x' }]).derive({ amount: midi('c4') })
  assert.equal(hashOf(bind), hashOf(t([{ id: 'x' }]).derive({ amount: midi('c4') })))
  assert.notEqual(hashOf(bind), hashOf(t([{ id: 'x' }]).derive({ amount: midi('e4') })), 'midi note')
})

test('Expr verbs carry lineage forward', () => {
  const base = new Table([withLineage({ v: 5 }, [{ table: 'src', index: 0 }])])
  const out = base.filter(field('v').gt(1)).map({ v: field('v') })
  assert.deepEqual(getLineage(out.rows[0]), [{ table: 'src', index: 0 }])
})

// time is an absolute UTC epoch ms (see tap-log.ts), not time-since-first-tap —
// pick an arbitrary base instant and space rows beatSeconds apart from it.
const TAP_BASE_MS = 1_700_000_000_000
const tapRowsAt = (beatSeconds: number, n = 3): Row[] =>
  Array.from({ length: n }, (_, i) => ({ beat: i, time: TAP_BASE_MS + i * beatSeconds * 1000 }))
const dslWithTaps = (rows: Row[] = []) => createDSL({
  defineLazy() {}, defineConst() {}, addGraph() {}, resolve() { return new Table() },
  tapRows: () => rows,
})

test('tempo() derives the beat length from the taps table, else falls back', () => {
  assert.equal(dslWithTaps(tapRowsAt(0.4)).tempo(), 0.4)
  assert.equal(dslWithTaps([]).tempo(), 0.5, 'default fallback is 120 BPM')
  assert.equal(dslWithTaps(tapRowsAt(0, 1)).tempo(0.25), 0.25, 'one tap is not enough')
})

test('beats(n) builds an identity remap spanning n beats', () => {
  // Tempo is automatic in playback, so the timeline itself is just a
  // playback→source remap: the count-beat loop mapped identity.
  const tl = buildTimeline(dslWithTaps(tapRowsAt(0.5)).beats(16).rows)
  assert.equal(tl.beats, 16)
  assert.equal(tl.sourceBeatAt(9), 9)
})

test('beats(n, { fit }) maps a source span across the beat window', () => {
  // fit: 4 maps 4 source-beats (beats 1..5) across the whole 16-beat loop.
  const tl = buildTimeline(dslWithTaps(tapRowsAt(0.5)).beats(16, { fit: 4 }).rows)
  assert.equal(tl.beats, 16)
  assert.equal(tl.sourceBeatAt(9), 3)
})

test('beats() is tempo-independent — identical rows regardless of taps', () => {
  assert.deepEqual(dslWithTaps([]).beats(4).rows, dslWithTaps(tapRowsAt(0.25)).beats(4).rows)
})
