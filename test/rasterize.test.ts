import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rasterizeRows, buildFrameIndex, sampleFrame } from '../src/rasterize.js'
import { slider, progress, isBinding, evalExpr, type Binding } from '../src/dsl.js'
import { frameToBeat, framesToBeats } from '../src/constants.js'
import type { Row } from '../src/lineage.js'

// b: the 1-indexed beat landing on a cache frame; mb: a frame count as a beats
// span (for maxBeats). Beats are the input unit; frames are the baking grid.
const b = (frame: number): number => frameToBeat(frame)
const mb = (frame: number): number => framesToBeats(frame)

const create = (over: Row = {}): Row => ({
  id: 's', event: 'create', beat: 1, shape: 'sphere', color: 0x4a9eff,
  px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, ...over,
})

test('bakes every frame a maxBeats loop samples (span exclusive) for an object alive throughout', () => {
  const rows = rasterizeRows([create()], mb(10))
  assert.equal(rows.length, 10)
  assert.equal(rows[0].frame, 0)
  assert.equal(rows[9].frame, 9, 'frame 10 belongs to the next pass, so the pad stops at 9')
  assert.ok(rows.every((r) => r.id === 's' && r.shape === 'sphere'))
})

test('infers maxFrame from the largest event beat when omitted', () => {
  const rows = rasterizeRows([
    create(),
    { id: 's', event: 'color', beat: b(7), color: 0xffffff },
  ])
  assert.equal(rows.at(-1)!.frame, 7)
})

test('interpolates position/rotation linearly between movement keyframes', () => {
  const rows = rasterizeRows([
    create({ px: 0, py: 0, ry: 0 }),
    { id: 's', event: 'update', beat: b(10), px: 10, py: 20, pz: 0, rx: 0, ry: 4, rz: 0 },
  ], mb(10))
  const at5 = rows.find((r) => r.frame === 5)!
  assert.equal(at5.px, 5, 'halfway in x')
  assert.equal(at5.py, 10, 'halfway in y')
  assert.equal(at5.ry, 2, 'halfway in rotation y')
  assert.equal(rows.find((r) => r.frame === 0)!.px, 0)
  assert.equal(rows.find((r) => r.frame === 10)!.px, 10)
})

test('color is a step function: latest color-bearing event <= frame', () => {
  const rows = rasterizeRows([
    create({ color: 0x111111 }),
    { id: 's', event: 'color', beat: b(3), color: 0x222222 },
    { id: 's', event: 'color', beat: b(6), color: 0x333333 },
  ], mb(8))
  const colorAt = (fr: number) => rows.find((r) => r.frame === fr)!.color
  assert.equal(colorAt(0), 0x111111)
  assert.equal(colorAt(2), 0x111111)
  assert.equal(colorAt(3), 0x222222)
  assert.equal(colorAt(5), 0x222222)
  assert.equal(colorAt(6), 0x333333)
  assert.equal(colorAt(7), 0x333333)
})

test('color pulse: flashes exactly at the trigger, eases to base, newest wins', () => {
  const rows = rasterizeRows([
    create({ color: 0x4a9eff }),
    { id: 's', event: 'color', beat: b(3), color: 0xffffff, dur: mb(4), ease: (t: number) => t },
    { id: 's', event: 'color', beat: b(6), color: 0xff0000, dur: mb(4), ease: (t: number) => t },
  ], mb(12))
  const colorAt = (fr: number) => rows.find((r) => r.frame === fr)!.color
  assert.equal(colorAt(0), 0x4a9eff, 'base color before any pulse')
  assert.equal(colorAt(3), 0xffffff, 'exact flash color at the trigger frame')
  assert.notEqual(colorAt(5), 0xffffff, 'mid-decay color is a mix, not the flash')
  assert.equal(colorAt(6), 0xff0000, 'a newer pulse overrides the older one mid-decay')
  assert.equal(colorAt(10), 0x4a9eff, 'fully decayed back to the base color')
})

test('no rows before create and from destroy onward', () => {
  const rows = rasterizeRows([
    create({ beat: b(2) }),
    { id: 's', event: 'destroy', beat: b(5) },
  ], mb(8))
  const frames = new Set(rows.map((r) => r.frame))
  assert.ok(!frames.has(0) && !frames.has(1), 'absent before create')
  assert.ok(frames.has(2) && frames.has(4), 'present while alive')
  assert.ok(!frames.has(5) && !frames.has(7), 'absent from destroy onward')
})

test('multiple objects each get a row per frame they are alive', () => {
  const rows = rasterizeRows([
    create({ id: 'a' }),
    create({ id: 'b', beat: b(3) }),
  ], mb(5))
  const at4 = rows.filter((r) => r.frame === 4).map((r) => r.id).sort()
  assert.deepEqual(at4, ['a', 'b'])
  const at1 = rows.filter((r) => r.frame === 1).map((r) => r.id)
  assert.deepEqual(at1, ['a'])
})

test('buildFrameIndex + sampleFrame give O(1) lookups', () => {
  const rows = rasterizeRows([create({ id: 'a' }), create({ id: 'b' })], mb(5))
  const fi = buildFrameIndex(rows)
  assert.equal(fi.maxFrame, 4)
  assert.deepEqual(sampleFrame(fi, 2).map((r) => r.id).sort(), ['a', 'b'])
  assert.deepEqual(sampleFrame(fi, 2.9).map((r) => r.id).sort(), ['a', 'b'], 'a fractional playhead floors to its cache frame')
  assert.deepEqual(sampleFrame(fi, 99), [])
  assert.deepEqual(sampleFrame(fi, -1), [])
})

test('sampleFrame eases transform fields between cache frames', () => {
  const rows = rasterizeRows([
    create({ px: 0, py: 0, ry: 0 }),
    { id: 's', event: 'update', beat: b(10), px: 10, py: 20, pz: 0, rx: 0, ry: 4, rz: 0 },
  ], mb(10))
  const fi = buildFrameIndex(rows)

  // Frame 4 bakes px=4; frame 5 bakes px=5. Halfway between → 4.5.
  const half = sampleFrame(fi, 4.5)[0]
  assert.equal(half.px, 4.5, 'position eased half a frame')
  assert.equal(half.ry, 1.8, 'rotation eased half a frame')

  // Integer frames and frac 0 are plain lookups.
  assert.equal(sampleFrame(fi, 4)[0].px, 4)
  // Past the last frame, no next frame to ease toward → hold.
  assert.equal(sampleFrame(fi, 10)[0].px, 10)
})

test('sampleFrame does not blend discrete fields (color) or eased ids that vanish', () => {
  const rows = rasterizeRows([
    create({ id: 'a', color: 0x111111, px: 0 }),
    { id: 'a', event: 'update', beat: b(4), px: 8 },
    create({ id: 'b', beat: b(2), px: 0 }),
    { id: 'b', event: 'destroy', beat: b(3) },
  ], mb(4))
  const fi = buildFrameIndex(rows)
  const at = sampleFrame(fi, 2.5)
  const a = at.find((r) => r.id === 'a')!
  assert.equal(a.color, 0x111111, 'color is not interpolated')
  assert.equal(a.px, 5, 'a eased between frame 2 (px=4) and 3 (px=6)')
  assert.equal(at.find((r) => r.id === 'b')!.px, 0, 'an id gone at the next frame is held, not eased')
})

test('empty input yields an empty cache', () => {
  assert.deepEqual(rasterizeRows([], mb(5)), [])
  assert.deepEqual(rasterizeRows(null), [])
  const fi = buildFrameIndex([])
  assert.equal(fi.maxFrame, 0)
  assert.deepEqual(sampleFrame(fi, 0), [])
})

test('an ease function on the destination keyframe shapes the segment', () => {
  const easeIn = (t: number): number => t * t
  const rows = rasterizeRows([
    create({ px: 0, wings: 0 }),
    { id: 's', event: 'update', beat: b(10), px: 10, wings: 1, ease: easeIn },
  ], mb(10))
  const at5 = rows.find((r) => r.frame === 5)!
  assert.equal(at5.px, 2.5, 'position eased quadratically')
  assert.equal(at5.wings, 0.25, 'custom numeric eased the same way')
})

test("a 'step' ease makes a HOLD keyframe: the field holds, then jumps on the beat", () => {
  const rows = rasterizeRows([
    create({ px: 0 }),
    { id: 's', event: 'update', beat: b(10), px: 10, ease: 'step' }, // keyframe on frame 10
  ], mb(12))
  const pxAt = (fr: number): unknown => rows.find((r) => r.frame === fr)!.px
  assert.equal(pxAt(5), 0, 'holds the previous keyframe — no ramp')
  assert.equal(pxAt(9), 0, 'right up to the beat')
  assert.equal(pxAt(10), 10, 'jumps exactly on the keyframe frame')
})

test('numeric tracks glide across keyframes that omit them', () => {
  const rows = rasterizeRows([
    create({ ry: 0, wings: 0 }),
    { id: 's', event: 'update', beat: b(4), wings: 1 },   // no ry
    { id: 's', event: 'update', beat: b(10), ry: 5 },      // no wings
  ], mb(10))
  const at5 = rows.find((r) => r.frame === 5)!
  assert.equal(at5.ry, 2.5, 'ry glides through the wings-only keyframe')
  assert.equal(at5.wings, 1, 'wings holds after its own last keyframe')
  const at2 = rows.find((r) => r.frame === 2)!
  assert.equal(at2.wings, 0.5, 'wings ramp unaffected by the later ry keyframe')
})

// --- expression keyframes join the per-field track scan ----------------------

test('a numeric/expr/numeric sandwich samples the expr in its span — no lerp-through', () => {
  const rows = rasterizeRows([
    create({ py: 0 }),
    { id: 's', event: 'update', beat: b(4), py: slider('h').toJSON() },
    { id: 's', event: 'update', beat: b(8), py: 8 },
  ], mb(10))
  const pyAt = (fr: number): unknown => rows.find((r) => r.frame === fr)!.py
  assert.equal(pyAt(2), 0, 'the numeric segment holds — no lerp toward the expr keyframe')
  assert.ok(isBinding(pyAt(5)), 'the expr keyframe streams through its span')
  assert.equal(evalExpr((pyAt(5) as Binding).$expr, {}, 0, { slider: () => 2 }), 2)
  assert.equal(pyAt(8), 8, 'the next numeric keyframe steps in — never a blend through the expr')
  assert.equal(pyAt(9), 8)
})

test('non-reserved numerics get the same expr treatment (light intensity)', () => {
  const rows = rasterizeRows([
    { id: 'l', event: 'create', beat: 1, shape: 'light', intensity: 1 },
    { id: 'l', event: 'update', beat: b(3), intensity: slider('bright').toJSON() },
  ], mb(6))
  const at = (fr: number): unknown => rows.find((r) => r.frame === fr)!.intensity
  assert.equal(at(1), 1)
  assert.ok(isBinding(at(4)), 'the numeric track no longer clobbers the expr update')
})

test('a keyframe expression sees per-field segment progress and bakes to numbers', () => {
  const value = progress().mul(10).toJSON()
  const snapshot = JSON.parse(JSON.stringify(value))
  const rows = rasterizeRows([
    create({ py: 0 }),
    { id: 's', event: 'update', beat: b(3), py: value },
    { id: 's', event: 'update', beat: b(7), py: 10 }, // the py segment's end
  ], mb(8))
  const pyAt = (fr: number): unknown => rows.find((r) => r.frame === fr)!.py
  assert.equal(pyAt(3), 0, 'progress-only exprs land as plain numbers')
  assert.equal(pyAt(5), 5, 'u is the elapsed fraction of the per-field segment')
  assert.equal(pyAt(7), 10)
  assert.deepEqual(value, snapshot, 'per-frame substitution clones — the source node is untouched')
})

test("a keyframe's own dur overrides the progress window", () => {
  const rows = rasterizeRows([
    create({ py: 0 }),
    { id: 's', event: 'update', beat: b(3), dur: mb(2), py: progress().toJSON() },
  ], mb(9))
  const pyAt = (fr: number): unknown => rows.find((r) => r.frame === fr)!.py
  assert.equal(pyAt(4), 0.5)
  assert.equal(pyAt(6), 1, 'clamped once the dur window closes')
})

test('a string ease from a table cell resolves via EASINGS', () => {
  const rows = rasterizeRows([
    create({ px: 0 }),
    { id: 's', event: 'update', beat: b(10), px: 10, ease: 'easeIn' },
  ], mb(10))
  assert.equal(rows.find((r) => r.frame === 5)!.px, 2.5, 't² at the midpoint')
})

// --- the absolute beat axis: events past maxBeats form later passes ----------

test('events past the maxBeats span keep baking — passes are playback\'s concern', () => {
  const rows = rasterizeRows([
    create({ px: 0 }),
    { id: 's', event: 'update', beat: b(8), px: 8 },
  ], mb(4))
  // The cache is one absolute grid; the beat-8 keyframe (frame 8) extends it
  // past the 4-frame loop span, and the glide crosses the boundary like any
  // other segment. Playback wraps the playhead into it in loop-length passes.
  assert.equal(rows.at(-1)!.frame, 8)
  assert.equal(rows.find((r) => r.frame === 4)!.px, 4, 'halfway through the cross-boundary glide')
  assert.equal(rows.find((r) => r.frame === 8)!.px, 8)
  assert.ok(rows.every((r) => !('loop' in r)), 'baked rows carry no pass column')
})

test('a maxBeats arg extends a shorter bake so the final pose holds to the loop\'s last frame', () => {
  const rows = rasterizeRows([
    create({ px: 0 }),
    { id: 's', event: 'update', beat: b(2), px: 2 },
  ], mb(6))
  assert.equal(rows.at(-1)!.frame, 5)
  assert.equal(rows.find((r) => r.frame === 5)!.px, 2, 'held, not extrapolated')
})
