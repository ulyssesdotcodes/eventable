import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isPostRow,
  postRows,
  buildPostIndex,
  postFrameAt,
  postCodeUpToRow,
  postStateFrames,
  foldVars,
  varTracks,
  type PostFrame,
} from '../src/post.js'
import { evalPostCode, chainSignature, collectLiveValues, sliderDeclsInCode, postVarDecls, type OpChain } from '../src/post-lang.js'
// Registers the Expr live-arg adapter post-lang consults (expr in post cells).
import '../src/expr-cell.js'
import { slider, progress, field, isBinding, evalExpr, type Binding } from '../src/dsl.js'
import { frameToBeat, beatsToFrames } from '../src/constants.js'
import { createPostVisualizer } from '../src/visualizer.js'
import type { PostAPI } from '../src/post-scene.js'
import type { Row } from '../src/lineage.js'

const b = (frame: number): number => frameToBeat(frame)
const frameAt = (rows: Row[], frame: number): PostFrame | null => postFrameAt(buildPostIndex(rows), frame)
const ops = (frame: PostFrame | null): string[] => (frame?.chain ?? []).map((o) => o.op)
const close = (a: unknown, x: number): void =>
  assert.ok(typeof a === 'number' && Math.abs(a - x) < 1e-9, `expected ~${x}, got ${a}`)
const vars = (rows: Row[], frame: number, seqLen = 0): Record<string, unknown> =>
  foldVars(buildPostIndex(rows), frame, seqLen)

test('isPostRow/postRows keep only post events', () => {
  const rows: Row[] = [
    { event: 'setCode', code: 'edges(0.2)' },
    { event: 'pulse', name: 'g', value: 1 },
    { event: 'setSource' }, // a hydra-only name — not a post event
    { code: 'x' },
  ]
  assert.equal(postRows(rows).length, 2)
  assert.equal(isPostRow(rows[0]), true)
  assert.equal(isPostRow(rows[2]), false)
})

test('the scene is implicit: a top-level op starts a chain, and set folds into vars', () => {
  const frame = frameAt([
    { beat: 1, event: 'setCode', code: 'edges((p) => p.th, 1)' },
    { beat: 1, event: 'setVariable', name: 'th', value: 0.3 },
  ], 0)!
  // `edges(0.2)` compiles to the same op list as `scene().edges(0.2)`.
  assert.deepEqual(ops(frame), ['scene', 'edges'])
  assert.equal(frame.stateId, frameAt([{ beat: 1, event: 'setCode', code: 'scene().edges((p) => p.th, 1)' }], 0)!.stateId)
  assert.deepEqual(frame.vars, { th: 0.3 })
})

test('an empty chain is passthrough (post inactive); a set-only table stays inactive', () => {
  assert.equal(frameAt([{ beat: 1, event: 'setCode', code: '' }], 0), null)
  assert.equal(frameAt([{ beat: 1, event: 'setVariable', name: 'x', value: 1 }], 0), null)
})

test('the latest chain wins and persists', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: 'blur(2)' },
    { beat: b(4), event: 'setCode', code: 'bloom(0.4)' },
  ]
  assert.deepEqual(ops(frameAt(rows, 3)), ['scene', 'blur'])
  assert.deepEqual(ops(frameAt(rows, 4)), ['scene', 'bloom'])
})

test('add appends effects (leading dot optional), including from passthrough', () => {
  assert.deepEqual(ops(frameAt([
    { beat: 1, event: 'setCode', code: 'blur(4)' },
    { beat: b(4), event: 'add', code: 'pixelate(6)' },
    { beat: b(6), event: 'add', code: '.invert()' },
  ], 6)), ['scene', 'blur', 'pixelate', 'invert'])
  // No prior chain — add starts one from the scene.
  assert.deepEqual(ops(frameAt([{ beat: 1, event: 'add', code: 'pixelate(6)' }], 0)), ['scene', 'pixelate'])
})

test('remove drops every op with the given name, even the first (next op goes top-level)', () => {
  assert.deepEqual(ops(frameAt([
    { beat: 1, event: 'setCode', code: 'blur(4).bloom(1).pixelate(6)' },
    { beat: b(4), event: 'remove', name: 'bloom' },
  ], 4)), ['scene', 'blur', 'pixelate'])
  assert.deepEqual(ops(frameAt([
    { beat: 1, event: 'setCode', code: 'blur(4).bloom(1)' },
    { beat: b(4), event: 'remove', name: 'blur' },
  ], 4)), ['scene', 'bloom'])
})

test('layer composites another chain via the chosen mode', () => {
  const chain = frameAt([
    { beat: 1, event: 'setCode', code: 'edges(0.2, 0)' },
    { beat: b(4), event: 'layer', mode: 'blend', value: 0.5, code: 'strobe(2)' },
  ], 4)!.chain
  assert.deepEqual(chain.map((o) => o.op), ['scene', 'edges', 'blend'])
  assert.deepEqual(chain[2].chainArgs![0].map((o) => o.op), ['scene', 'strobe'])
})

test('a transition wipes to the next setCode ahead, then expires to it (end-exclusive)', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: 'blur(4)' },
    { beat: 5, event: 'transition' },                  // frame 120
    { beat: 7, event: 'setCode', code: 'edges(0.2, 0)' }, // frame 180 = window end
  ]
  const idx = buildPostIndex(rows)
  // Inside the window [120, 180): the wipe. Look-ahead reveals the destination
  // (edges) as the wipe's "after" chain arg, though its setCode is at beat 7.
  const wipe = postFrameAt(idx, 150)!.chain
  assert.equal(wipe[0].op, 'transition')
  assert.deepEqual(wipe[0].chainArgs![0].map((o) => o.op), ['scene', 'blur'], 'before')
  assert.deepEqual(wipe[0].chainArgs![1].map((o) => o.op), ['scene', 'edges'], 'after (look-ahead)')
  // The window END is the setCode's own frame (end-exclusive): after stands alone.
  assert.deepEqual(ops(postFrameAt(idx, 180)), ['scene', 'edges'])
  assert.ok(postStateFrames(idx).includes(180), 'the window END is an enumerated state frame')
})

// The transition is a per-pixel mask mix (result = mix(before, after, luma(mask)))
// with NO automatic temporal sweep: time enters only through a mask that reads
// progress(). These pin the new semantics.
const wipeRows = (transition: Partial<Row>): Row[] => [
  { beat: 1, event: 'setCode', code: 'blur(4)' },
  { beat: 5, event: 'transition', ...transition }, // frame 120, window [120, 180)
  { beat: 7, event: 'setCode', code: 'edges(0.2)' }, // frame 180 = window end
]
const maskOf = (frame: PostFrame): OpChain => frame.chain[0].chainArgs![2]

test('a bare progress() mask sweeps luminance 0→1 across the window, shaped by ease', () => {
  const fnAt = (ease: unknown): ((p: { time: number }) => number) => {
    const mask = maskOf(postFrameAt(buildPostIndex(wipeRows({ code: 'progress()', ease })), 150)!)
    assert.deepEqual(mask.map((o) => o.op), ['fill'], 'a bare live-arg mask lowers to fill (uniform luminance)')
    return mask[0].args[0].value as (p: { time: number }) => number
  }
  const linear = fnAt('linear')
  close(linear({ time: 120 / 60 }), 0)  // 0 at the transition's beat
  close(linear({ time: 150 / 60 }), 0.5) // linear midpoint
  close(linear({ time: 180 / 60 }), 1)  // 1 at the next setCode's beat
  close(fnAt(undefined)({ time: 150 / 60 }), 0.5) // blank ease = linear
  close(fnAt('easeIn')({ time: 150 / 60 }), 0.25) // ease shapes progress
  close(fnAt('easeOut')({ time: 150 / 60 }), 0.75)
})

test('a static mask composites the same every frame — no automatic temporal blend — then cuts to after', () => {
  const idx = buildPostIndex(wipeRows({ code: 'gradient(0)' }))
  const at = (f: number): PostFrame => postFrameAt(idx, f)!
  assert.equal(at(120).chain[0].op, 'transition')
  // One precompiled state across the whole window, identical live values: the
  // composite never moves on its own (mix depends only on the frozen mask luma).
  assert.equal(at(120).stateId, at(179).stateId, 'no per-frame state')
  assert.deepEqual(collectLiveValues(at(120).chain, {}), collectLiveValues(at(150).chain, {}))
  assert.deepEqual(ops(at(180)), ['scene', 'edges'], 'past the window: after only')
})

test('a blank transition mask is static black: before holds through the window, then a delayed cut', () => {
  const idx = buildPostIndex(wipeRows({}))
  const tr = postFrameAt(idx, 150)!.chain[0]
  assert.deepEqual(maskOf(postFrameAt(idx, 150)!).map((o) => o.op), ['fill'])
  assert.equal(maskOf(postFrameAt(idx, 150)!)[0].args[0].value, 0, 'blank → fill(0), a black mask')
  assert.deepEqual(tr.chainArgs![0].map((o) => o.op), ['scene', 'blur'], 'before shows for the window')
  assert.deepEqual(ops(postFrameAt(idx, 180)), ['scene', 'edges'], 'cut to after at the next setCode')
})

test('a progress().oneSub() mask chain is a live uniform whose reveal grows before→after', () => {
  const idx = buildPostIndex(wipeRows({ code: 'gradient(0).thresh(progress().oneSub())' }))
  const ids = [120, 135, 150, 179].map((f) => postFrameAt(idx, f)!.stateId)
  assert.equal(new Set(ids).size, 1, 'a progress() mask adds no per-frame cache key')
  const mask = maskOf(postFrameAt(idx, 150)!)
  assert.deepEqual(mask.map((o) => o.op), ['gradient', 'thresh'])
  assert.equal(mask[1].args[0].cls, 'live', "thresh's edge is the live (oneSub'd) progress arg")
  const edge = mask[1].args[0].value as (p: { time: number }) => number
  // ascending thresh: pixels above `edge` show after. oneSub falls edge 1 → 0,
  // so at the start nothing is above it (fully before) and at the end all of the
  // gradient [0,1] is (fully after) — the reveal grows monotonically.
  close(edge({ time: 120 / 60 }), 1) // progress 0 → edge 1 → fully before
  close(edge({ time: 180 / 60 }), 0) // progress 1 → edge 0 → fully after
  assert.ok(edge({ time: 135 / 60 }) > edge({ time: 165 / 60 }), 'the edge falls as the wipe runs')
})

test('oneSub reflects any live-arg handle (1 − value) and composes', () => {
  // On a bare progress() crossfade mask, oneSub reverses the sweep direction.
  const fill = maskOf(postFrameAt(buildPostIndex(wipeRows({ code: 'progress().oneSub()' })), 150)!)
  assert.deepEqual(fill.map((o) => o.op), ['fill'])
  const f = fill[0].args[0].value as (p: { time: number }) => number
  close(f({ time: 120 / 60 }), 1) // 1 − 0
  close(f({ time: 180 / 60 }), 0) // 1 − 1
  // slider/val handles carry it too (1 − value), and it double-composes back.
  close((evalPostCode('blur(slider("r").oneSub())')[1].args[0].value as (p: Record<string, unknown>) => number)({ sliders: { r: 0.3 } }), 0.7)
  close((evalPostCode('blur(val("g", 4).oneSub().oneSub())')[1].args[0].value as (p: Record<string, unknown>) => number)({ g: 4 }), 4)
})

test('progress in a wrapped transition window reads across the loop seam', () => {
  // loopFrames 120, seqLen 240; the transition at frame 210 wraps to the first
  // setCode next pass, so its window [210, 270) crosses the seam.
  const rows: Row[] = [
    { beat: 2, event: 'setCode', code: 'blur(4)' },        // frame 30
    { beat: 5, event: 'setCode', code: 'edges(0.2)' },     // frame 120
    { beat: 8, event: 'transition', code: 'progress()' },  // frame 210
  ]
  const idx = buildPostIndex(rows)
  const fnAt = (frame: number): ((p: { time: number }) => number) =>
    maskOf(postFrameAt(idx, frame, 120)!)[0].args[0].value as (p: { time: number }) => number
  close(fnAt(210)({ time: 210 / 60 }), 0)        // window start
  close(fnAt(230)({ time: 230 / 60 }), 20 / 60)  // before the seam
  close(fnAt(10)({ time: 10 / 60 }), 40 / 60)    // after it (dist 40 via wrap, not a clamp to 0)
})

test('generators and ops compile and are usable as chains and combine sources', () => {
  // The canonical idiom set (wipe / iris / clock / dissolve).
  assert.deepEqual(evalPostCode('gradient(0).thresh(progress().oneSub())').map((o) => o.op), ['gradient', 'thresh'])
  assert.deepEqual(evalPostCode('gradient(Math.PI).polar().thresh(progress().oneSub(), 0.3)').map((o) => o.op), ['gradient', 'polar', 'thresh'])
  assert.deepEqual(evalPostCode('gradient(Math.PI / 2).polar().thresh(progress().oneSub())').map((o) => o.op), ['gradient', 'polar', 'thresh'])
  assert.deepEqual(evalPostCode('noise(3).thresh(progress().oneSub())').map((o) => o.op), ['noise', 'thresh'])
  assert.deepEqual(evalPostCode('stripes(8).polar()').map((o) => o.op), ['stripes', 'polar'])
  assert.deepEqual(evalPostCode('voronoi(8, 0.5).thresh(progress().oneSub())').map((o) => o.op), ['voronoi', 'thresh'])
  // a generator's structural arg bakes (selecting a shader path), its scale stays live
  assert.equal(evalPostCode('noise(3, 3)')[0].args[1].cls, 'structural')
  assert.notEqual(chainSignature(evalPostCode('gradient(0, 1)')), chainSignature(evalPostCode('gradient(0)')))
  // a generator drives a combine's branch, not only a mask
  assert.deepEqual(evalPostCode('blur(4).mask(gradient(0))')[2].chainArgs![0].map((o) => o.op), ['gradient'])
  // thresh top-level runs on the scene luminance — a content-aware wipe
  assert.deepEqual(evalPostCode('edges(0.2).thresh(progress().oneSub())').map((o) => o.op), ['scene', 'edges', 'thresh'])
  assert.equal(evalPostCode('gradient((p) => p.a)')[0].args[0].cls, 'live', 'generator args are live')
})

test('a wrapped post window runs to a setCode across the loop boundary', () => {
  // No setCode ahead this pass → the window wraps to the next pass's first
  // setCode. loopFrames 120: maxIndex 180 → 2 passes, seqLen 240.
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: 'blur(4)' },      // frame 0
    { beat: 5, event: 'setCode', code: 'edges(0.2)' },   // frame 120
    { beat: 7, event: 'transition' },                    // frame 180
  ]
  const idx = buildPostIndex(rows)
  const L = 120
  // Frame 0: window covers [180,240), inactive here — the plain start chain.
  assert.deepEqual(ops(postFrameAt(idx, 0, L)), ['scene', 'blur'])
  // Frame 210: wiping from edges (code at the transition beat) to the wrapped
  // destination blur — a seamless loop back to the start.
  const wipe = postFrameAt(idx, 210, L)!.chain
  assert.equal(wipe[0].op, 'transition')
  assert.deepEqual(wipe[0].chainArgs![0].map((o) => o.op), ['scene', 'edges'], 'before')
  assert.deepEqual(wipe[0].chainArgs![1].map((o) => o.op), ['scene', 'blur'], 'after wraps to start')
})

test('prev() is an explicit feedback head usable as a branch arg', () => {
  const chain = frameAt([{ beat: 1, event: 'setCode', code: 'blend(prev().mosaic(4), 0.4)' }], 0)!.chain
  assert.deepEqual(chain.map((o) => o.op), ['scene', 'blend'])
  assert.deepEqual(chain[1].chainArgs![0].map((o) => o.op), ['prev', 'mosaic'])
})

test('a structural arg change selects a different state; a live change does not', () => {
  const s1 = frameAt([{ beat: 1, event: 'setCode', code: 'edges(0.9, 1)' }], 0)!
  const live = frameAt([{ beat: 1, event: 'setCode', code: 'edges(0.1, 1)' }], 0)!
  const struct = frameAt([{ beat: 1, event: 'setCode', code: 'edges(0.1, 2)' }], 0)!
  assert.equal(s1.stateId, live.stateId)
  assert.notEqual(live.stateId, struct.stateId)
})

test('a setVariable track steps by default: the value holds, then jumps on the beat', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setVariable', name: 'th', value: 0.2 },
    { beat: 5, event: 'setVariable', name: 'th', value: 0.5 }, // frame 120, blank ease = step
  ]
  close(vars(rows, 60).th, 0.2)  // holds the previous keyframe
  close(vars(rows, 119).th, 0.2) // right up to the beat
  close(vars(rows, 120).th, 0.5) // jumps exactly on the beat
})

test('a named ease glides from the previous keyframe, arriving exactly on the beat', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setVariable', name: 'th', value: 0.2 },
    { beat: 5, event: 'setVariable', name: 'th', value: 0.5, ease: 'linear' }, // ramp occupies frames 0..120
  ]
  close(vars(rows, 0).th, 0.2)   // the ramp reaches back to the previous keyframe
  close(vars(rows, 60).th, 0.35) // midpoint (linear)
  close(vars(rows, 120).th, 0.5) // arrives ON beat 5, not after it
})

test('repeating a value holds, then a named-ease row ramps out of the hold', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setVariable', name: 'th', value: 0.2 },
    { beat: 5, event: 'setVariable', name: 'th', value: 0.2, ease: 'linear' }, // repeat → flat hold
    { beat: 9, event: 'setVariable', name: 'th', value: 0.8, ease: 'linear' }, // frame 240
  ]
  close(vars(rows, 60).th, 0.2)  // first segment glides 0.2→0.2 = a hold
  close(vars(rows, 180).th, 0.5) // second segment midpoint: 0.2 → 0.8
  close(vars(rows, 240).th, 0.8)
})

test('a looping track wraps: a named-ease first keyframe glides in from the last', () => {
  const seqLen = beatsToFrames(8) // 8-beat loop; maxIndex 120 → content cycle 240 == 8 beats
  const rows: Row[] = [
    { beat: 1, event: 'setVariable', name: 'th', value: 0.2, ease: 'linear' }, // frame 0, first row named
    { beat: 5, event: 'setVariable', name: 'th', value: 0.8 },                  // frame 120, step
  ]
  close(vars(rows, 60, seqLen).th, 0.2)  // [0,120): step into beat 5 → holds 0.2
  close(vars(rows, 180, seqLen).th, 0.5) // wrap segment glides the last value 0.8 → the first 0.2
  close(vars(rows, 240, seqLen).th, 0.2) // wf 0: arrived back at the first keyframe
  // Drop the first row's ease and the last value just holds across the boundary.
  const stepFirst = rows.map((r, i) => (i === 0 ? { ...r, ease: undefined } : r))
  close(vars(stepFirst, 180, seqLen).th, 0.8)
})

test('varTracks: each setVariable name\'s rows, frame-ordered, for the timeline pane\'s variables section', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: 'blur(4)' }, // not a setVariable row — excluded
    { beat: 5, event: 'setVariable', name: 'th', value: 0.5 },
    { beat: 1, event: 'setVariable', name: 'th', value: 0.2 },
    { beat: 3, event: 'setVariable', name: 'g', value: 0.9 },
  ]
  const tracks = varTracks(buildPostIndex(rows))
  assert.deepEqual([...tracks.keys()], ['th', 'g'])
  assert.deepEqual(tracks.get('th')!.map((r) => r.value), [0.2, 0.5], 'frame order, not storage order')
  assert.deepEqual(tracks.get('g')!.map((r) => r.value), [0.9])
})

test('pulse adds a decaying (default easeOut) contribution that stacks and expires', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setVariable', name: 'g', value: 0.3 },
    { beat: 3, event: 'pulse', name: 'g', value: 1, dur: 1 }, // frame 60..90, default easeOut
    { beat: 3, event: 'pulse', name: 'g', value: 0.5, dur: 1 },
  ]
  close(vars(rows, 60).g, 1.8)   // onset: 0.3 + (1 + 0.5)·env(0)=1
  close(vars(rows, 75).g, 0.675) // midpoint easeOut env=0.25: 0.3 + 1.5·0.25
  close(vars(rows, 90).g, 0.3)   // expired: inert
})

test('a pulse with blank/0 dur defaults to a 1-beat envelope (no longer silently inert)', () => {
  const rows: Row[] = [{ beat: 3, event: 'pulse', name: 'g', value: 1 }] // window [60, 90)
  close(vars(rows, 60).g, 1)                            // fires at onset
  assert.ok((vars(rows, 75).g as number) > 0, 'still decaying mid-beat')
  close(vars(rows, 90).g, 0)                            // one beat later, done
})

test("a 'step' pulse is a square gate: full value across the window, then off", () => {
  const rows: Row[] = [
    { beat: 3, event: 'pulse', name: 'g', value: 1, dur: 1, ease: 'step' }, // window [60, 90)
  ]
  close(vars(rows, 60).g, 1) // full value at onset
  close(vars(rows, 75).g, 1) // held, no easeOut decay
  close(vars(rows, 89).g, 1)
  close(vars(rows, 90).g, 0) // gate closes
})

// ── expression values in set/pulse rows ──────────────────────────────────────

const resolveAt = (v: unknown, sliderValue: number): unknown =>
  evalExpr((v as Binding).$expr, {}, 0, { slider: () => sliderValue })

test("progress() in a set value sweeps the row's reign — its beat to the next same-name row", () => {
  const rows: Row[] = [
    { beat: 1, event: 'setVariable', name: 'v', value: progress().toJSON() }, // reign [frame 0, 120)
    { beat: 5, event: 'setVariable', name: 'v', value: 1 },                    // frame 120
  ]
  assert.equal(typeof vars(rows, 60).v, 'number', 'progress-only exprs bake to plain numbers')
  close(vars(rows, 0).v, 0)
  close(vars(rows, 60).v, 0.5) // halfway through the reign
  close(vars(rows, 120).v, 1)  // the next keyframe takes over
})

test('a named-ease glide to an expression target emits a per-frame-resolving lerp composite', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setVariable', name: 'v', value: 1 },
    { beat: 5, event: 'setVariable', name: 'v', value: slider('x').toJSON(), ease: 'linear' }, // frames 0..120
  ]
  const mid = vars(rows, 60).v // u = 0.5 across the segment [beat 1, beat 5]
  assert.ok(isBinding(mid), 'the glide resolves per frame, not at fold')
  close(resolveAt(mid, 5), 3) // 1 + (5 - 1) · 0.5
  // arrives on the beat: eased u = 1 leaves the target expression alone
  close(resolveAt(vars(rows, 120).v, 5), 5)
})

test('a pulse stacks over an expression base instead of being dropped', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setVariable', name: 'g', value: slider('x').toJSON() },
    { beat: 3, event: 'pulse', name: 'g', value: 1, dur: 1 }, // frames 60..90
  ]
  close(resolveAt(vars(rows, 60).g, 2), 3) // base 2 + 1·env(0)
  close(resolveAt(vars(rows, 90).g, 2), 2) // expired pulse leaves the bare base
})

test('field() in a value cell reads its own row, not sibling vars', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setVariable', name: 'beat', value: 99 }, // a sibling var named like a column
    { beat: 3, event: 'setVariable', name: 'v', value: field('beat').toJSON() },
  ]
  assert.equal(vars(rows, 60).v, 3, "the row's own beat column, substituted at fold time")
})

test('substitution never mutates the source nodes (cook memo safety)', () => {
  const value = progress().mul(2).toJSON()
  const snapshot = JSON.parse(JSON.stringify(value))
  const rows: Row[] = [
    { beat: 1, event: 'setVariable', name: 'v', value },     // reign [0, 60)
    { beat: 3, event: 'setVariable', name: 'v', value: 5 },
  ]
  vars(rows, 15)
  vars(rows, 45)
  vars(rows, 60)
  assert.deepEqual(value, snapshot)
})

test('postCodeUpToRow samples the fold at the row’s frame (runtime parity, look-ahead)', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: 'blur(3)' },
    { beat: b(4), event: 'add', code: 'pixelate(6)' },
  ]
  assert.equal(postCodeUpToRow(rows, 0), 'blur(3)')
  assert.equal(postCodeUpToRow(rows, 1), 'blur(3).pixelate(6)')

  const wipeRows: Row[] = [
    { beat: 1, event: 'setCode', code: 'blur(3)' },
    { beat: 5, event: 'transition' },                  // frame 120
    { beat: 7, event: 'setCode', code: 'edges(0.2)' }, // frame 180 = window end
  ]
  // The transition row's popover is the wipe composite the runtime shows there,
  // with the destination revealed via look-ahead — not the bare before chain.
  const at1 = postCodeUpToRow(wipeRows, 1)!
  assert.ok(at1.startsWith('transition('))
  assert.ok(at1.includes('edges(0.2)'))
  // The destination setCode row (a window end, end-exclusive) shows plain after.
  assert.equal(postCodeUpToRow(wipeRows, 2), 'edges(0.2)')
})

test('warm-compile audit: no frame of a loop introduces an unenumerated state', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: 'edges((p) => p.th, 1)' },
    { beat: 1, event: 'setVariable', name: 'th', value: 0.2 },
    { beat: 9, event: 'add', code: 'bloom((p) => p.glow)' },
    { beat: 11, event: 'remove', name: 'bloom' },
    { beat: 13, event: 'transition' },                                   // frame 360
    { beat: 15, event: 'setCode', code: 'blend(prev().mosaic(4), 0.5)' }, // frame 420 = window end
  ]
  const L = beatsToFrames(16) // 16-beat loop, seqLen 480
  const idx = buildPostIndex(rows)
  const stateFrames = postStateFrames(idx, L)
  const enumerated = new Set<string>()
  for (const f of stateFrames) { const fr = postFrameAt(idx, f, L); if (fr) enumerated.add(fr.stateId) }
  for (let f = 0; f < Math.max(...stateFrames) + L; f++) {
    const fr = postFrameAt(idx, f, L)
    if (fr) assert.ok(enumerated.has(fr.stateId), `frame ${f} state "${fr.stateId}" was not precompiled`)
  }
})

test('the post visualizer precompiles with the real loopFrames — no state compiles on a beat', () => {
  // A transition as the LAST post event wipes back to the start across the loop
  // seam: its folded state exists only under the real loopFrames. The visualizer
  // must give setProgram that loopFrames (not 0), or the wipe state compiles
  // lazily inside setFrame — the getProgramParameter stall on apply/playback.
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: 'blur(4)' },
    { beat: 5, event: 'setCode', code: 'edges(0.2)' },
    { beat: 7, event: 'transition', code: 'gradient(0).thresh(progress().oneSub())' },
  ]
  const L = beatsToFrames(8)

  // A fake engine that precompiles exactly as post-scene's setProgram does, then
  // flags any setFrame state it never precompiled (the lazy compile).
  const precompiled = new Set<string>()
  let lazy = 0
  const fakePost: PostAPI = {
    setProgram(index, loopFrames): void {
      precompiled.clear()
      for (const sf of postStateFrames(index, loopFrames)) {
        const fr = postFrameAt(index, sf, loopFrames)
        if (fr) precompiled.add(fr.stateId)
      }
    },
    setFrame(frame): void { if (frame && !precompiled.has(frame.stateId)) lazy++ },
    setPreview(): void {},
    render: () => false,
    resize(): void {},
    reset(): void {},
  }

  const viz = createPostVisualizer(fakePost)
  viz.load({ sceneRows: [], hydraRows: [], postRows: rows })
  const idx = buildPostIndex(rows)
  const maxIndex = idx.reduce((m, r) => Math.max(m, r.index as number), 0)
  const loops = Math.floor(maxIndex / L) + 1
  for (let pass = 0; pass < loops; pass++) {
    for (let f = 0; f < L; f++) {
      viz.applyFrame({ srcFrameF: f, loopFrames: L, ctx: null, passAt: () => pass, bpm: 120 })
    }
  }
  assert.equal(lazy, 0, 'a post state compiled lazily — setProgram under-enumerated (wrong loopFrames)')
})

test('op-list lowering: live-by-default, structural where the registry says, signature masks live', () => {
  const chain = evalPostCode('edges((p) => p.th, 1).blur(3)')
  assert.equal(chain[1].args[0].cls, 'live')       // threshold: a function
  assert.equal(typeof chain[1].args[0].value, 'function')
  assert.deepEqual(chain[1].args[1], { cls: 'structural', value: 1 }) // colorMode baked
  assert.equal(chainSignature(chain), chainSignature(evalPostCode('edges(0.9, 1).blur(0)')), 'live literals are masked')
  assert.deepEqual(collectLiveValues(chain, { th: 0.4 }), [0.4, 3]) // resolved in binding order
})

test('the hydra-style ops lower: geometry/colour fx are live, modulate carries its modulator chain', () => {
  const chain = evalPostCode('scale(1.2).rotate(0.3).scrollX(0.1).kaleid(4).hue(0.1).saturate(1.5).modulate(prev(), 0.2).fade(0.4)')
  assert.deepEqual(chain.map((o) => o.op),
    ['scene', 'scale', 'rotate', 'scrollX', 'kaleid', 'hue', 'saturate', 'modulate', 'fade'])
  assert.equal(chain[1].args[0].cls, 'live') // scale amount is a uniform, no recompile on change
  const modulate = chain.find((o) => o.op === 'modulate')!
  assert.equal(modulate.kind, 'combine')
  assert.equal(modulate.args[0].cls, 'live') // amount
  assert.deepEqual(modulate.chainArgs![0].map((o) => o.op), ['prev']) // the modulator feeds off prev()
})

test('a broken chain (unknown op, or a last-line comment) surfaces its error', () => {
  // The cook compiles every state, so these throws reach the user instead of
  // being swallowed. A trailing `//` comment is the classic case: the wrapping
  // `return (...)` can't close past it.
  assert.throws(() => evalPostCode('noSuchOp()'))
  assert.throws(() => frameAt([{ beat: 1, event: 'setCode', code: 'noSuchOp()' }], 0))
  assert.throws(() => frameAt([{ beat: 1, event: 'setCode', code: 'edges(0.2)\n// glow' }], 0))
})

test('slider() is a live arg reading props.sliders; sliderDeclsInCode scans a cell for declarations', () => {
  const chain = evalPostCode('blur(slider("r", 2, 8))')
  assert.deepEqual(collectLiveValues(chain, { sliders: { r: 4 } }), [4], 'reads the slider per frame')
  assert.deepEqual(collectLiveValues(chain, {}), [2], 'falls back to min before the slider exists')
  assert.deepEqual(collectLiveValues(evalPostCode('blur(slider("r"))'), {}), [0], 'no min → 0')
  assert.deepEqual(sliderDeclsInCode('.blur(slider("r", 2, 8))'), [{ id: 'r', min: 2, max: 8 }], 'leading-dot fragments scan too')
  assert.deepEqual(sliderDeclsInCode('broken('), [], 'a mid-edit cell declares nothing')
})

test('val("name", initial) is a live arg reading the folded variable, with the initial as fallback', () => {
  const chain = evalPostCode('blur(val("rad", 4))')
  assert.deepEqual(collectLiveValues(chain, { rad: 9 }), [9], 'reads the folded variable per frame')
  assert.deepEqual(collectLiveValues(chain, {}), [4], 'the initial is the fallback')
  const frame = frameAt([
    { beat: 1, event: 'setCode', code: 'blur(val("rad", 4))' },
    { beat: 1, event: 'setVariable', name: 'rad', value: 2 },
  ], 0)!
  assert.deepEqual(collectLiveValues(frame.chain, frame.vars), [2], 'a set row (the fold materializes one) drives it')
  assert.deepEqual(
    postVarDecls('bloom(val("glow", 0.5)).blur(val("rad"))'),
    [{ name: 'glow', value: 0.5 }, { name: 'rad', value: 0 }],
    'declarations scan textually; no value → 0',
  )
})

test('an Expr as a live arg resolves per frame and declares its slider', () => {
  const chain = evalPostCode('bloom(expr.slider("r", 2, 8).mul(2))')
  assert.equal(collectLiveValues(chain, { sliders: { r: 3 } })[0], 6)
  assert.ok(sliderDeclsInCode('bloom(expr.slider("r", 2, 8))').some((d) => d.id === 'r' && d.min === 2 && d.max === 8))
  const viaMidi = evalPostCode('blur(expr.midi("c4"))')
  assert.equal(collectLiveValues(viaMidi, { $midi: () => 0.5 })[0], 0.5)
})
