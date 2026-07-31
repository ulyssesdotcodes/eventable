import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTimeline, windowsFor } from '../src/timeline.js'
import { Table, createDSL } from '../src/dsl.js'
import { FRAMES_PER_BEAT } from '../src/constants.js'
import { withLineage, getLineage } from '../src/lineage.js'
import { createRuntime } from '../src/runtime.js'
import { cookProgram } from '../src/replay.js'

test('no timeline rows → identity mapping, not active', () => {
  const tl = buildTimeline([])
  assert.equal(tl.active, false)
  assert.equal(tl.beats, 0)
  assert.equal(tl.sourceBeatAt(1), 1)
  assert.equal(tl.sourceBeatAt(7.5), 7.5)
})

// --- event rows: the timeline schema ----------------------------------------

test('retime event maps its window linearly onto the source range; a lone row fills the pass', () => {
  // Play source beats 1..5 across the whole 16-beat loop — the lone row's
  // window runs from beat 1 to the end of the pass (loop beats = 16).
  const tl = buildTimeline([{ event: 'retime', beat: 1, from: 1, to: 5 }], 16)
  assert.equal(tl.active, true)
  assert.equal(tl.beats, 16, 'pass length is the loop-beats value, not the timeline extent')
  assert.equal(tl.sourceBeatAt(1), 1)
  assert.equal(tl.sourceBeatAt(9), 3, 'halfway through the loop → halfway through the source span')
  assert.equal(tl.sourceBeatAt(17), 5)
})

test('loop event cycles the source range at natural speed until the window closes', () => {
  const tl = buildTimeline([{ event: 'loop', beat: 1, from: 1, to: 5 }], 16)
  assert.equal(tl.beats, 16)
  assert.equal(tl.sourceBeatAt(3), 3)
  assert.equal(tl.sourceBeatAt(6), 2, 'second cycle restarts at `from`')
  assert.equal(tl.sourceBeatAt(16), 4, 'fourth cycle')
})

test('hold event freezes the source frame across its window', () => {
  const tl = buildTimeline([{ event: 'hold', beat: 1, from: 3 }], 8)
  assert.equal(tl.sourceBeatAt(1), 3)
  assert.equal(tl.sourceBeatAt(4.5), 3)
})

test('retime with from > to plays the source range backwards', () => {
  // A lone row's window runs to the end of the pass (loop beats = 8 here).
  const tl = buildTimeline([{ event: 'retime', beat: 1, from: 5, to: 1 }], 8)
  assert.equal(tl.sourceBeatAt(1), 5)
  assert.equal(tl.sourceBeatAt(5), 3)
  assert.equal(tl.sourceBeatAt(9), 1)
})

test('retime with an output block repeats the stretched block across its window', () => {
  // Source 1..5 stretched to half speed (an 8-beat block), looping across 16.
  const tl = buildTimeline([{ event: 'retime', beat: 1, from: 1, to: 5, outFrom: 1, outTo: 9 }], 16)
  assert.equal(tl.beats, 16)
  assert.equal(tl.sourceBeatAt(5), 3, 'halfway through the first block')
  assert.equal(tl.sourceBeatAt(10), 1.5, 'second block restarts the source')
  assert.equal(tl.sourceBeatAt(13), 3)
})

test('retime output block anchors phase: a window starting mid-block starts mid-source', () => {
  const tl = buildTimeline([{ event: 'retime', beat: 5, from: 1, to: 5, outFrom: 1, outTo: 9 }], 16)
  assert.equal(tl.sourceBeatAt(6), 3.5, 'beat 6 sits in the block that began (unheard) at beat 1')
  assert.equal(tl.sourceBeatAt(10), 1.5)
})

test('pingpong plays the source range forward then backward across its block', () => {
  // from..to 1..4 stretched into out block 5..9: forward over 5..7, backward
  // over 7..9 — each leg at twice the source's own pace.
  const tl = buildTimeline([{ event: 'pingpong', beat: 5, from: 1, to: 4, outFrom: 5, outTo: 9 }], 16)
  assert.equal(tl.sourceBeatAt(5), 1)
  assert.equal(tl.sourceBeatAt(6), 2.5)
  assert.equal(tl.sourceBeatAt(7), 4, 'the turn-around')
  assert.equal(tl.sourceBeatAt(8), 2.5)
  assert.equal(tl.sourceBeatAt(9), 1)
})

test('pingpong blocks repeat across the window, and .retime places rows on both legs', () => {
  const tl = buildTimeline([{ event: 'pingpong', beat: 1, from: 1, to: 3, outFrom: 1, outTo: 5 }], 16)
  assert.equal(tl.sourceBeatAt(2), 2, 'forward leg')
  assert.equal(tl.sourceBeatAt(4), 2, 'backward leg')
  assert.equal(tl.sourceBeatAt(6), 2, 'second block over')
  // A bare next row closes the pingpong window at one block, so a source beat
  // lands exactly twice — once each way.
  const out = new Table([{ id: 'a', beat: 2 }])
    .retime([{ event: 'pingpong', beat: 1, from: 1, to: 3, outFrom: 1, outTo: 5 }, { event: 'retime', beat: 5 }]).rows
  assert.deepEqual(out.map((r) => r.beat), [2, 4], 'once on the way out, once on the way back')
})

test('speed event advances from `from` at `rate` source beats per playback beat', () => {
  const tl = buildTimeline([{ event: 'speed', beat: 1, from: 1, rate: 0.5 }], 8)
  assert.equal(tl.sourceBeatAt(9), 5, 'half speed: 8 playback beats cover 4 source beats')
})

test('playback beats before the first row play unmapped; disabled rows are ignored', () => {
  const tl = buildTimeline([
    { event: 'hold', beat: 9, from: 2 },
    { event: 'retime', beat: 1, disabled: true },
  ], 16)
  assert.equal(tl.beats, 16)
  assert.equal(tl.sourceBeatAt(3), 3, 'before the first (enabled) row → identity')
  assert.equal(tl.sourceBeatAt(12), 2)
})

test('zero-filled cells from the table panel read as unset', () => {
  // Blank cells in an editable table conform to 0 (schemas fill defaults), so
  // a hand-entered retime row arrives with outFrom/outTo/rate/loop all 0 —
  // it must behave exactly like the sparse row a program would write.
  const tl = buildTimeline([
    { event: 'retime', beat: 1, from: 1, to: 5, outFrom: 0, outTo: 0, rate: 0, loop: 0, disabled: false },
  ], 16)
  assert.equal(tl.beats, 16)
  assert.equal(tl.sourceBeatAt(9), 3)
})

test('events compose: a bare retime, then a looped section — windows run until-next', () => {
  const tl = buildTimeline([
    { event: 'retime', beat: 1 },
    { event: 'loop', beat: 9, from: 1, to: 3 },
  ], 16)
  assert.equal(tl.sourceBeatAt(5), 5, 'the bare retime is identity across its window (beats 1..9)')
  assert.equal(tl.sourceBeatAt(10), 2)
  assert.equal(tl.sourceBeatAt(12), 2, 'the 2-beat section cycles across beats 9..17')
})

// --- windowsFor: the shared until-next window helper -------------------------

test('windowsFor: rows cover until-next, the last row runs to the end of its pass', () => {
  // Two rows in pass 0 (loop-beats 8): the first runs to the second, the
  // second to the end of the pass. No gaps, no overlaps, no `dur`.
  const wins = windowsFor([{ event: 'retime', beat: 1 }, { event: 'hold', beat: 5, from: 2 }], 8)
  assert.deepEqual(wins, [
    { row: 0, beat: 1, end: 5, lane: 0 },
    { row: 1, beat: 5, end: 9, lane: 0 },
  ])
})

test('windowsFor: a later pass (via loop, or a beat past the pass length) extends the sequence', () => {
  const viaLoop = windowsFor([{ event: 'retime', beat: 1, loop: 0 }, { event: 'retime', beat: 1, loop: 1 }], 8)
  assert.deepEqual(viaLoop, [
    { row: 0, beat: 1, end: 9, lane: 0 },
    { row: 1, beat: 1, end: 9, lane: 1 },
  ])
  // A lone row at beat 12 (loop-beats 8) reaches into pass 1, so its window
  // runs to the end of pass 1 (beat 17 on its own pass-0 axis).
  const viaBeat = windowsFor([{ event: 'retime', beat: 12 }], 8)
  assert.deepEqual(viaBeat, [{ row: 0, beat: 12, end: 17, lane: 0 }])
})

// --- legacy sparse keyframes { beat, source } still work ---------------------

test('keyframe rows interpolate within multiple keyframes (a warped section)', () => {
  // Hold source at beat 1 for the first half, then run 1→9 over the second half.
  const tl = buildTimeline([
    { beat: 1, source: 1 },
    { beat: 5, source: 1 },
    { beat: 9, source: 9 },
  ])
  assert.equal(tl.sourceBeatAt(3), 1, 'held in the first section')
  assert.equal(tl.sourceBeatAt(5), 1)
  assert.equal(tl.sourceBeatAt(7), 5, 'halfway through the second section')
  assert.equal(tl.sourceBeatAt(9), 9)
})

test('keyframe reverse: source runs backwards as playback advances', () => {
  const tl = buildTimeline([{ beat: 1, source: 5 }, { beat: 5, source: 1 }])
  assert.equal(tl.sourceBeatAt(1), 5)
  assert.equal(tl.sourceBeatAt(3), 3)
  assert.equal(tl.sourceBeatAt(5), 1)
})

test('cookProgram surfaces timelineRows from a defined timeline view', () => {
  const rt = createRuntime()
  const code = `
    define("base", () => rows([{ id: "s", event: "create", beat: 1, shape: "sphere",
      color: 0x4a9eff, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
    define("scene", () => table("base").rasterize(2))
    define("timeline", () => beats(16, { fit: 4 }))
  `
  const cooked = cookProgram(rt, code, 1)
  const tl = buildTimeline(cooked.timelineRows)
  assert.equal(tl.beats, 16)
  assert.equal(tl.sourceBeatAt(9), 3, 'the 4-beat source span is stretched across the loop')
})

test('cookProgram yields no timeline rows when none is defined', () => {
  const rt = createRuntime()
  const code = `
    define("three", () => rows([{ id: "s", event: "create", beat: 1, shape: "box",
      color: 1, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
  `
  const cooked = cookProgram(rt, code, 1)
  assert.deepEqual(cooked.timelineRows, [])
  assert.equal(buildTimeline(cooked.timelineRows).active, false)
})

// --- multi-loop sequences: the `loop` column next to `beat` ------------------

test('a loop column gives each pass its own remap; the playhead wraps every pass', () => {
  // Pass 0 plays source 1..5 forward; pass 1 plays it in reverse. Pass length
  // is the loop-beats value (4 here), so the playhead wraps every 4 beats.
  const tl = buildTimeline([
    { beat: 1, loop: 0, source: 1 },
    { beat: 5, loop: 0, source: 5 },
    { beat: 1, loop: 1, source: 5 },
    { beat: 5, loop: 1, source: 1 },
  ], 4)
  assert.equal(tl.loops, 2)
  assert.equal(tl.beats, 4, 'the playhead wraps every pass, not once per sequence')
  assert.equal(tl.sourceBeatAt(1, 0), 1)
  assert.equal(tl.sourceBeatAt(3, 0), 3)
  assert.equal(tl.sourceBeatAt(3, 1), 3, 'reverse pass, halfway')
  assert.equal(tl.sourceBeatAt(5, 1), 1)
  assert.equal(tl.sourceBeatAt(3, 2), 3, 'the loop argument wraps modulo the pass count')
})

test('event rows take the loop column too', () => {
  const tl = buildTimeline([
    { event: 'retime', beat: 1, loop: 0 },
    { event: 'retime', beat: 1, from: 5, to: 1, loop: 1 },
  ], 4)
  assert.equal(tl.loops, 2)
  assert.equal(tl.beats, 4)
  assert.equal(tl.sourceBeatAt(3, 0), 3)
  assert.equal(tl.sourceBeatAt(3, 1), 3, 'reverse pass, halfway')
  assert.equal(tl.sourceBeatAt(5, 1), 1)
})

test('rows without a loop column keep single-loop behavior (loops = 1, loop arg ignored)', () => {
  const tl = buildTimeline([{ event: 'retime', beat: 1, from: 1, to: 5 }], 16)
  assert.equal(tl.loops, 1)
  assert.equal(tl.sourceBeatAt(9), tl.sourceBeatAt(9, 3))
})

// --- .retime(timeline): warp any beat table through a timeline table ----------

test('retime through a loop event duplicates rows once per cycle', () => {
  const content = new Table([
    { id: 'a', beat: 1 },
    { id: 'b', beat: 3 },
  ])
  // The bare next row closes the loop window at beat 9 — two 4-beat cycles.
  const out = content.retime([{ event: 'loop', beat: 1, from: 1, to: 5 }, { event: 'retime', beat: 9 }]).rows
  assert.deepEqual(
    out.map((r) => [r.id, r.beat]),
    [['a', 1], ['a', 5], ['b', 3], ['b', 7]],
  )
})

test('retime through a retime stretch rescales beat spacing and dur', () => {
  const content = new Table([{ id: 'a', beat: 3, dur: 2 }])
  // Half speed: source 1..5 across playback 1..9 (window closed by a next row).
  const out = content.retime([{ event: 'retime', beat: 1, from: 1, to: 5 }, { event: 'retime', beat: 9 }]).rows
  assert.deepEqual(out.map((r) => [r.beat, r.dur]), [[5, 4]])
})

test('retime drops rows no event plays; non-beat rows pass through', () => {
  const content = new Table([
    { id: 'late', beat: 10 },
    { id: 'meta' },
  ])
  const out = content.retime([{ event: 'loop', beat: 1, from: 1, to: 5 }]).rows
  assert.deepEqual(out.map((r) => r.id), ['meta'])
})

test('retime through a repeating retime block places rows once per repeat, dur stretched', () => {
  const content = new Table([{ id: 'a', beat: 3, dur: 2 }])
  // An 8-beat block (out 1..9) tiled across the default 16-beat loop.
  const out = content.retime([
    { event: 'retime', beat: 1, from: 1, to: 5, outFrom: 1, outTo: 9 },
  ]).rows
  assert.deepEqual(out.map((r) => [r.beat, r.dur]), [[5, 4], [13, 4]])
})

test('retime carries each source row\'s lineage onto every placed copy', () => {
  const src = withLineage({ id: 'a', beat: 1 }, [{ table: 'melody', index: 0 }])
  const out = new Table([src]).retime([{ event: 'loop', beat: 1, from: 1, to: 5 }, { event: 'retime', beat: 9 }]).rows
  assert.equal(out.length, 2)
  for (const r of out) assert.deepEqual(getLineage(r), [{ table: 'melody', index: 0 }])
})

test('retime loops a subsection of an origami fold sequence', () => {
  const dsl = createDSL(null)
  const paper = dsl.origami().steps([
    { step: 'diag', p1: '0,0', p2: '1,1', move: '0.667,0.333', beat: 1, dur: 2 },
    { step: 'collapse', p1: '0,0.5', p2: '1,0.5', move: '0.333,0.167', kind: 'reverse', beat: 4, dur: 2 },
  ])
  const spawn = paper.spawn({ id: 'sheet' })
  // First fold plays straight; the second fold's window (source 4..7) loops
  // three times — the sheet folds shut, eases back open, folds shut again.
  const warp = [
    { event: 'retime', beat: 1 },
    { event: 'loop', beat: 4, from: 4, to: 7 },
  ]
  const scene = spawn.concat(paper.sequence().retime(warp)).rasterize(13)
  const foldAt = (b: number): number => {
    const row = scene.rows.find((r) => r.frame === Math.round((b - 1) * FRAMES_PER_BEAT) && r.id === 'sheet')!
    return row.fold as number
  }
  assert.equal(foldAt(3), 1, 'the first fold lands on the straight clock')
  assert.equal(foldAt(6), 2, 'the second fold lands in the first cycle')
  assert.equal(foldAt(8), 1.5, 'mid-swing inside a repeat')
  assert.equal(foldAt(9), 2, 'landed again in the second cycle')
  assert.equal(foldAt(12), 2, 'and in the third')
})

test('retime with an empty timeline is a no-op', () => {
  const content = new Table([{ id: 'a', beat: 2 }])
  assert.deepEqual(content.retime([]).rows, [{ id: 'a', beat: 2 }])
})

test('a user timeline table (editable, schemas.timeline) remaps other tables in a program', () => {
  const rt = createRuntime({ editableRows: (_name, _schema, seedRows) => seedRows ?? [] })
  const code = `
    define("warp", () => editable("warp", schemas.timeline, [
      { event: "loop", beat: 1, from: 1, to: 5 },
      { event: "retime", beat: 9 },
    ]))
    define("hits", () => rows([{ id: "x", beat: 2 }]).retime(table("warp")))
  `
  const result = rt.run(code, { seed: 1 })
  const hits = result.views.get('hits')!
  assert.deepEqual(hits.rows.map((r) => r.beat), [2, 6])
})
