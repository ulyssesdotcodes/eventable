import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { buildTimeline } from '../src/timeline.js'
import {
  beatToX,
  xToBeat,
  gridLines,
  stripLayout,
  hitTest,
  resolveHandle,
  snap,
  snapDelta,
  dragUpdate,
  valuesDiffer,
  exceedsDragThreshold,
  withPreview,
  pendingTimelineRows,
  coverageBands,
  meaningfulSummary,
  type Handle,
} from '../src/timeline-strip.js'
import { hydraTransitionWindows } from '../src/hydra.js'
import { postSpanWindows, postGlidePairs } from '../src/post.js'
import type { EditableColumn } from '../src/editable-tables.js'

const cols = (...names: string[]): EditableColumn[] => names.map((name) => ({ name, type: 'number' }))

// --- geometry ----------------------------------------------------------------

test('beatToX/xToBeat round-trip: beat 1 sits at x=0, beat maxBeats+1 at the right edge', () => {
  const geometry = { width: 320, maxBeats: 16 }
  assert.equal(beatToX(geometry, 1), 0)
  assert.equal(beatToX(geometry, 17), 320)
  assert.equal(xToBeat(geometry, 0), 1)
  assert.equal(xToBeat(geometry, 320), 17)
  assert.equal(xToBeat(geometry, beatToX(geometry, 9)), 9)
})

// --- grid ----------------------------------------------------------------

test('gridLines: minor tick per beat, major every 4, labels only major', () => {
  const lines = gridLines(8, 800)
  assert.equal(lines.length, 9, 'beats 1..maxBeats+1')
  assert.deepEqual(lines.map((l) => l.kind), ['major', 'minor', 'minor', 'minor', 'major', 'minor', 'minor', 'minor', 'major'])
  assert.deepEqual(lines.filter((l) => l.label).map((l) => l.beat), [1, 5, 9])
})

test('gridLines: labels drop wholesale once major spacing collides (<24px)', () => {
  const roomy = gridLines(8, 800) // 100px/beat, 400px between majors
  const cramped = gridLines(800, 800) // 1px/beat, 4px between majors
  assert.ok(roomy.some((l) => l.label))
  assert.ok(cramped.every((l) => !l.label))
})

// --- handlesFor ----------------------------------------------------------------

test('handlesFor: timeline rows become until-next span handles; loop picks the lane, disabled rows drop out', () => {
  const rows = [
    { beat: 1, loop: 0 },
    { beat: 5, loop: 0 },
    { beat: 1, loop: 1, disabled: true },
  ]
  const handles = stripLayout('timeline', rows, cols('beat', 'loop'), rows, 8).handles
  assert.deepEqual(
    handles.map((h) => ({ row: h.row, kind: h.kind, beat: h.beat, end: h.end, lane: h.lane, disabled: h.disabled })),
    [
      { row: 0, kind: 'span', beat: 1, end: 5, lane: 0, disabled: false },
      { row: 1, kind: 'span', beat: 5, end: 9, lane: 0, disabled: false },
    ],
    'row 0 runs to row 1; row 1 runs to the end of its 8-beat pass; the disabled row gets no handle',
  )
})

test('handlesFor: with no timeline defined, a content row is identity — one non-ghost handle at its own beat', () => {
  const rows = [{ beat: 3, dur: 2 }]
  const handles = stripLayout('three', rows, cols('beat', 'dur'), []).handles
  assert.deepEqual(handles, [
    { row: 0, kind: 'span', beat: 3, end: 5, lane: 0, ghost: false, disabled: false },
  ])
})

test('handlesFor: a fold transition draws its until-next window as a span (endRow → destination); instants stay points', () => {
  // hydra transitions wipe to the NEXT setCode ahead — the span width is that
  // window, matching hydraTransitionWindows (so the strip can't disagree with
  // playback). Every other event, and any stray column, draws a point.
  const rows = [
    { beat: 3, event: 'setCode', code: 'osc().out(o0)' },
    { beat: 5, event: 'transition' },
    { beat: 9, event: 'setCode', code: 'noise().out(o0)' },
  ]
  const handles = stripLayout('hydra', rows, cols('beat'), []).handles
  assert.equal(handles.find((h) => h.row === 0)!.kind, 'point', 'setCode is an instant')
  const t = handles.find((h) => h.row === 1)!
  const win = hydraTransitionWindows(rows)[0]
  assert.equal(t.kind, 'span')
  assert.deepEqual([t.beat, t.end, t.endRow], [win.start, win.end, win.endRow], 'span parity with the fold window')
  assert.deepEqual([t.beat, t.end, t.endRow], [5, 9, 2], 'runs to the beat-9 setCode, whose row is the arrow target')
})

test('handlesFor: a post pulse draws a bar (mirroring pulseAt); a bare pulse defaults to a 1-beat bar', () => {
  const rows = [
    { beat: 1, event: 'setCode', code: 'edges(0.2)', dur: 4 }, // stray dur → still a point
    { beat: 3, event: 'pulse', name: 'x', value: 1, dur: 2 },
    { beat: 6, event: 'pulse', name: 'x', value: 1 }, // blank dur → 1-beat bar
    { beat: 8, event: 'pulse', name: 'x', value: 1, dur: 0, ease: 'step' }, // step gate has extent
  ]
  const handles = stripLayout('post', rows, cols('beat', 'dur'), []).handles
  const barOf = (row: number) => handles.find((h) => h.row === row)!
  assert.equal(barOf(0).kind, 'point', 'a stray dur on a setCode is still a point')
  assert.deepEqual([barOf(1).kind, barOf(1).beat, barOf(1).end], ['span', 3, 5], 'explicit dur bar [beat, beat+dur)')
  assert.deepEqual([barOf(2).kind, barOf(2).beat, barOf(2).end], ['span', 6, 7], 'blank dur → 1-beat bar')
  assert.deepEqual([barOf(3).kind, barOf(3).beat, barOf(3).end], ['span', 8, 9], 'a step gate (dur 0) still spans its 1-beat default')
  assert.equal(barOf(1).endRow, undefined, 'a pulse bar has no destination arrow')
})

test('handlesFor: an eased setVariable stays a point, tagged with the previous same-name row it glides from', () => {
  const rows = [
    { beat: 1, event: 'setVariable', name: 'x', value: 0 }, // step (blank ease): no glide
    { beat: 5, event: 'setVariable', name: 'x', value: 1, ease: 'easeInOut' }, // eased: glides from row 0
    { beat: 7, event: 'setVariable', name: 'x', value: 2, ease: 'step' }, // explicit step: no glide
    { beat: 3, event: 'setVariable', name: 'y', value: 9, ease: 'linear' }, // eased but first of its track: no glide
  ]
  const cols4 = cols('beat')
  const handles = stripLayout('post', rows, cols4, []).handles
  assert.deepEqual(handles.map((h) => h.kind), ['point', 'point', 'point', 'point'], 'a glide is an arrow, never a bar')
  const glideOf = (row: number) => handles.find((h) => h.row === row)!.glideFrom
  assert.equal(glideOf(1), 0, 'the eased arrival glides from the previous same-name row')
  assert.equal(glideOf(0), undefined, 'a blank-ease keyframe glides from nothing')
  assert.equal(glideOf(2), undefined, 'an explicit step glides from nothing')
  assert.equal(glideOf(3), undefined, 'the first row of a track has no previous to glide from')
})

test('handlesFor: setCode/add/remove/layer in a post table stay points', () => {
  const rows = [
    { beat: 1, event: 'setCode', code: 'edges(0.2)' },
    { beat: 2, event: 'add', code: 'bloom(1.2)' },
    { beat: 3, event: 'remove', name: 'bloom' },
    { beat: 4, event: 'layer', code: 'noise()', mode: 'add' },
  ]
  const handles = stripLayout('post', rows, cols('beat'), []).handles
  assert.deepEqual(handles.map((h) => h.kind), ['point', 'point', 'point', 'point'])
  assert.ok(handles.every((h) => h.glideFrom === undefined && h.end === undefined))
})

test('handlesFor: a post pulse bar has parity with postSpanWindows (strip can\'t drift from playback)', () => {
  const rows = [{ beat: 3, event: 'pulse', name: 'x', value: 1, dur: 2 }]
  const win = postSpanWindows(rows).find((w) => w.row === 0)!
  const bar = stripLayout('post', rows, cols('beat', 'dur'), []).handles.find((h) => h.row === 0)!
  assert.deepEqual([bar.beat, bar.end], [win.start, win.end], 'bar matches the fold window')
})

test('postGlidePairs: only named-ease keyframes pair, each with the previous same-name row', () => {
  const rows = [
    { beat: 1, event: 'setVariable', name: 'x', value: 0 },
    { beat: 5, event: 'setVariable', name: 'x', value: 1, ease: 'easeIn' },
    { beat: 4, event: 'setVariable', name: 'y', value: 2, ease: 'linear' }, // first of y: no pair
    { beat: 2, event: 'pulse', name: 'x', value: 1 }, // pulses aren't keyframes
  ]
  assert.deepEqual(postGlidePairs(rows), [{ row: 1, from: 0 }], 'x-row-1 glides from x-row-0; y-row-2 is first; pulse ignored')
})

test('handlesFor: a wrapped fold transition (destination earlier in the loop) renders two arcs', () => {
  // The transition at beat 7 wipes to the beat-2 setCode of the next pass, so
  // its window wraps the 8-beat loop: a tail arc to the strip end and a head
  // arc from the start to the destination, the arrowhead (endRow) on the head.
  const rows = [
    { beat: 2, event: 'setCode', code: 'a().out(o0)' },
    { beat: 6, event: 'setCode', code: 'b().out(o0)' },
    { beat: 7, event: 'transition' },
  ]
  const arcs = stripLayout('hydra', rows, cols('beat'), [], 8).handles.filter((h) => h.row === 2)
  assert.equal(arcs.length, 2, 'a wrapped window is a tail arc + a head arc')
  const tail = arcs.find((h) => h.endRow === undefined)!
  const head = arcs.find((h) => h.endRow !== undefined)!
  assert.deepEqual([tail.beat, tail.end], [7, 9], 'tail: transition → strip end (loopBeats + 1)')
  assert.deepEqual([head.beat, head.end], [1, 2], 'head: strip start → destination beat')
  assert.equal(head.endRow, 0, 'arrowhead targets the earlier setCode')
})

test('handlesFor: a content row played by a loop event gets one handle per placement, first primary, rest ghosts', () => {
  const timelineRows = [{ event: 'loop', beat: 1, from: 1, to: 5 }]
  const rows = [{ id: 'a', beat: 1 }]
  // Loop-beats 8 closes the pass at beat 9 — two 4-beat cycles.
  const handles = stripLayout('hits', rows, cols('beat'), timelineRows, 8).handles
  assert.deepEqual(
    handles.map((h) => ({ beat: h.beat, ghost: h.ghost })),
    [{ beat: 1, ghost: false }, { beat: 5, ghost: true }],
  )
})

// --- handlesFor: phase 5 (lanes + pass wrapping) ----------------------------

test('handlesFor: a content row placed across a multi-pass timeline lands each ghost in its own pass lane', () => {
  // Two "loop" passes, each cycling source 1..5 twice across their own
  // 8-beat span — a content row at source beat 3 (the cycle's midpoint)
  // lands twice per pass, once per cycle.
  const timelineRows = [
    { event: 'loop', beat: 1, from: 1, to: 5, loop: 0 },
    { event: 'loop', beat: 1, from: 1, to: 5, loop: 1 },
  ]
  const rows = [{ beat: 3 }]
  const handles = stripLayout('hits', rows, cols('beat'), timelineRows, 8).handles
  assert.deepEqual(
    handles.map((h) => ({ beat: h.beat, lane: h.lane, ghost: h.ghost })),
    [
      { beat: 3, lane: 0, ghost: false },
      { beat: 7, lane: 0, ghost: true },
      { beat: 3, lane: 1, ghost: true },
      { beat: 7, lane: 1, ghost: true },
    ],
    'pass 2\'s placements repeat pass 1\'s local shape, just in lane 1',
  )
})

test('handlesFor: a content row whose beat runs past loopBeats wraps into a later pass, tagged but still in lane 0', () => {
  // No timeline defined, so there's no lane to place a later pass into —
  // only a badge (see notes/timeline-strip-plan.md "Beats past maxBeats").
  const rows = [{ beat: 20 }]
  const handles = stripLayout('hits', rows, cols('beat'), [], 8).handles
  assert.deepEqual(
    handles.map((h) => ({ beat: h.beat, lane: h.lane, pass: h.pass })),
    [{ beat: 4, lane: 0, pass: 2 }],
    '(20 - 1) % 8 + 1 == 4, in the third 8-beat pass',
  )
})

// --- laneLayout + sub-lane packing ------------------------------------------

test('laneLayout: a two-pass timeline reserves one lane per pass even with no content handles', () => {
  const twoPassTimeline = [
    { event: 'hold', beat: 1, from: 1, loop: 0 },
    { event: 'hold', beat: 1, from: 1, loop: 1 },
  ]
  const { laneCount, passBase } = stripLayout('scene', [], cols('beat', 'dur'), twoPassTimeline)
  assert.deepEqual({ laneCount, passBase }, { laneCount: 2, passBase: [0, 1] })
})

test('sub-lane packing: overlapping spans stack into sub-lanes, disjoint spans share one, deterministically', () => {
  // A plain dur-column table: 1..4 and 3..6 overlap, so they pack into
  // sub-lanes 0 and 1; 7..9 is clear of both, back to lane 0.
  const rows = [
    { beat: 7, dur: 2 },
    { beat: 1, dur: 3 },
    { beat: 3, dur: 3 },
  ]
  const columns = cols('beat', 'dur')
  const laneOf = () => stripLayout('scene', rows, columns, []).handles
    .sort((a, b) => a.beat - b.beat).map((h) => h.lane)
  assert.deepEqual(laneOf(), [0, 1, 0], 'first-fit by start: 1..4 → 0, 3..6 → 1, 7..9 → 0')
  assert.deepEqual(laneOf(), laneOf(), 'deterministic')
  assert.equal(stripLayout('scene', rows, columns, []).laneCount, 2)
})

// --- out tracks (multi-track strip) -----------------------------------------

test('out tracks: bands stack under the interactive table, handles tagged with their track; every given track keeps a band (the transport widens on the same list)', () => {
  const { handles, tracks, laneCount } = stripLayout('timeline', [{ beat: 1 }], cols('beat', 'loop'), [], 8, {
    tracks: [
      { name: 'three', rows: [{ beat: 3, dur: 2 }] },
      { name: 'post', rows: [] },
      { name: 'hydra', rows: [{ beat: 2, event: 'setCode', code: 'osc().out(o0)' }] },
    ],
    timelineRows: [],
  })
  assert.deepEqual(
    tracks.map((t) => ({ name: t.name, base: t.base, end: t.end, interactive: t.interactive, track: t.track })),
    [
      { name: 'timeline', base: 0, end: 1, interactive: true, track: undefined },
      { name: 'three', base: 1, end: 2, interactive: false, track: 0 },
      { name: 'post', base: 2, end: 3, interactive: false, track: 1 },
      { name: 'hydra', base: 3, end: 4, interactive: false, track: 2 },
    ],
    'interactive band first, then one band per given out view — an empty one stays, just with no handles',
  )
  assert.equal(laneCount, 4)
  const three = handles.find((h) => h.track === 0)!
  assert.deepEqual([three.kind, three.beat, three.end, three.lane], ['span', 3, 5, 1], 'a dur column inferred from the cooked rows still draws a bar')
  assert.equal(handles.some((h) => h.track === 1), false)
  assert.equal(handles.find((h) => h.track === 2)!.lane, 3)
})

test('out tracks: rows place through the APPLIED timeline, not the live rows being edited', () => {
  // Applied warp stretches source 1..5 across the 8-beat pass; the live store
  // rows have dropped it (a pending edit). Playback still warps by the applied
  // rows, so the out track's indicator must sit where playback will show the
  // beat — source 3, the stretch midpoint, at playback beat 5.
  const applied = [{ event: 'retime', beat: 1, from: 1, to: 5 }]
  const { handles } = stripLayout('hits', [{ beat: 3 }], cols('beat'), [], 8, {
    tracks: [{ name: 'three', rows: [{ id: 'a', event: 'update', beat: 3 }] }],
    timelineRows: applied,
  })
  assert.equal(handles.find((h) => h.track === undefined)!.beat, 3, 'the open table still follows the live (identity) rows')
  assert.equal(handles.find((h) => h.track === 0)!.beat, 5, 'the out view follows the applied warp')
})

test('out tracks: a multi-pass timeline keeps an out band flat — later passes fold onto the same placements instead of stacking lanes', () => {
  const twoPass = [
    { event: 'loop', beat: 1, from: 1, to: 5, loop: 0 },
    { event: 'loop', beat: 1, from: 1, to: 5, loop: 1 },
  ]
  const { handles, tracks, passBase } = stripLayout('', [], [], [], 8, {
    tracks: [{ name: 'three', rows: [{ beat: 3 }] }],
    timelineRows: twoPass,
  })
  assert.deepEqual(passBase, [], 'no open table, no pass lanes')
  assert.deepEqual(tracks, [{ name: 'three', base: 0, end: 1, interactive: false, track: 0 }])
  assert.deepEqual(
    handles.map((h) => ({ beat: h.beat, lane: h.lane, pass: h.pass })),
    [
      { beat: 3, lane: 0, pass: undefined },
      { beat: 7, lane: 0, pass: undefined },
    ],
    "pass 2's identical placements dedupe away — the band stays one lane tall",
  )
})

test('out tracks: a hydra transition span keeps fold-window parity on its own band', () => {
  const rows = [
    { beat: 3, event: 'setCode', code: 'osc().out(o0)' },
    { beat: 5, event: 'transition' },
    { beat: 9, event: 'setCode', code: 'noise().out(o0)' },
  ]
  const { handles } = stripLayout('', [], [], [], undefined, { tracks: [{ name: 'hydra', rows }], timelineRows: [] })
  const t = handles.find((h) => h.row === 1)!
  const win = hydraTransitionWindows(rows)[0]
  assert.deepEqual([t.kind, t.beat, t.end, t.endRow], ['span', win.start, win.end, win.endRow])
})

// --- coverageBands -----------------------------------------------------------

test('coverageBands: each pass\'s segments map onto its own local axis, tagged with that pass\'s lane and event kind', () => {
  const timelineRows = [
    { event: 'hold', beat: 1, from: 1, loop: 0 },
    { event: 'hold', beat: 1, from: 1, loop: 1 },
  ]
  assert.deepEqual(
    coverageBands(timelineRows, 8).map((b) => ({ p0: b.p0, p1: b.p1, lane: b.lane, kind: b.kind })),
    [
      { p0: 1, p1: 9, lane: 0, kind: 'hold' },
      { p0: 1, p1: 9, lane: 1, kind: 'hold' },
    ],
  )
})

test('coverageBands: no active timeline yields no bands', () => {
  assert.deepEqual(coverageBands([]), [])
})

// --- pendingTimelineRows ----------------------------------------------------

test('pendingTimelineRows: a row whose live beat or pass drifted from the applied cook is pending; a disabled row is skipped (the applied view excludes it too)', () => {
  const rows = [
    { beat: 1, loop: 0 },
    { beat: 20, disabled: true },
    { beat: 9, loop: 0 },
  ]
  const applied = [
    { beat: 1, loop: 0 },
    { beat: 9, loop: 1 }, // row 2's pass moved after Apply
  ]
  assert.deepEqual(pendingTimelineRows(rows, applied), new Set([2]))
})

test('pendingTimelineRows: an unapplied trailing row past the applied cook length is pending', () => {
  const rows = [{ beat: 1 }, { beat: 9 }]
  const applied = [{ beat: 1 }]
  assert.deepEqual(pendingTimelineRows(rows, applied), new Set([1]))
})

// --- hitTest ----------------------------------------------------------------

test('hitTest: an edge wins over the body within tolerance; background misses return null', () => {
  const geometry = { width: 400, maxBeats: 16 }
  const handles: Handle[] = [
    { row: 0, kind: 'span', beat: 1, end: 9, lane: 0, ghost: false, disabled: false },
  ]
  const startX = beatToX(geometry, 1)
  const midX = beatToX(geometry, 5)
  assert.deepEqual(hitTest(handles, geometry, startX + 2, 0), { row: 0, part: 'start' })
  assert.deepEqual(hitTest(handles, geometry, midX, 0), { row: 0, part: 'body' })
  assert.equal(hitTest(handles, geometry, geometry.width, 0), null, 'no handle in lane at that x')
})

// --- snap ----------------------------------------------------------------

test('snap: quarter-beat by default, whole beats under coarse, unsnapped under free, clamped to >= 1', () => {
  assert.equal(snap(3.1), 3.0, 'nearest quarter')
  assert.equal(snap(3.13), 3.25)
  assert.equal(snap(3.6, { mode: 'coarse' }), 4)
  assert.equal(snap(3.567, { mode: 'free' }), 3.567)
  assert.equal(snap(-2), 1, 'clamped to the first beat')
})

// --- dragUpdate ----------------------------------------------------------------

test('dragUpdate move on a span only writes beat — dur (a length) rides along, preserving duration', () => {
  const handle: Handle = { row: 2, kind: 'span', beat: 5, end: 13, lane: 0, ghost: false, disabled: false }
  const { row, values } = dragUpdate(handle, 'body', 3)
  assert.equal(row, 2)
  assert.deepEqual(values, { beat: 8 })
})

test('dragUpdate end-edge drag writes dur back, respecting the minimum span', () => {
  const handle: Handle = { row: 0, kind: 'span', beat: 5, end: 6, lane: 0, ghost: false, disabled: false }
  // Dragging the end edge far to the left would collapse the span below minSpan.
  const { values } = dragUpdate(handle, 'end', -10, { minSpan: 0.25 })
  assert.deepEqual(values, { dur: 0.25 })
})

test('dragUpdate on a derived transition span: the end edge retargets the destination row, start/move move the transition', () => {
  const handle: Handle = { row: 1, kind: 'span', beat: 3, end: 8, lane: 0, ghost: false, disabled: false, derived: true, endRow: 2 }
  const end = dragUpdate(handle, 'end', 2)
  assert.equal(end.row, 2, 'the end edge belongs to the destination setCode')
  assert.deepEqual(end.values, { beat: 10 }, 'moves the destination beat, never a dur')
  assert.deepEqual([dragUpdate(handle, 'start', -1).row, dragUpdate(handle, 'start', -1).values], [1, { beat: 2 }], 'a start edge moves only the transition row')
  assert.deepEqual(dragUpdate(handle, 'body', 1).values, { beat: 4 })
})

test('dragUpdate maps a content-table drop back through the timeline sourceBeatAt', () => {
  // Half speed: source 1..5 stretched across playback 1..9 (loop-beats 8).
  const timeline = buildTimeline([{ event: 'retime', beat: 1, from: 1, to: 5 }], 8)
  const handle: Handle = { row: 0, kind: 'point', beat: 1, lane: 0, ghost: false, disabled: false }
  // Drag the handle from playback beat 1 to playback beat 5 (the midpoint).
  const { values } = dragUpdate(handle, 'body', 4, { timeline })
  assert.equal(values.beat, timeline.sourceBeatAt(5), 'stored source beat matches the visual landing spot')
  assert.equal(values.beat, 3)
})

test('dragUpdate maps a wrapped ghost back through its own pass, not pass 0', () => {
  // Two holds a pass apart, each freezing on a different source beat — the
  // only way to tell which pass's sourceBeatAt actually ran.
  const timeline = buildTimeline([
    { event: 'hold', beat: 1, from: 3, loop: 0 },
    { event: 'hold', beat: 1, from: 7, loop: 1 },
  ])
  const handle: Handle = { row: 0, kind: 'point', beat: 2, lane: 1, ghost: true, disabled: false, pass: 1 }
  const { values } = dragUpdate(handle, 'body', 0, { timeline })
  assert.equal(values.beat, 7, "pass 2's hold source (7), not pass 1's (3)")
})

// --- drag gesture helpers (phase 4) ----------------------------------------

test('exceedsDragThreshold: below the threshold is a click, beyond it a drag, diagonal movement included', () => {
  assert.equal(exceedsDragThreshold(2, 0), false)
  assert.equal(exceedsDragThreshold(3, 0), false, 'exactly at the threshold is still a click')
  assert.equal(exceedsDragThreshold(4, 0), true)
  assert.equal(exceedsDragThreshold(3, 1), true, 'diagonal distance can exceed the threshold even though neither component alone does')
})

test('snapDelta: snaps the point the drag actually moves, not the raw delta, so an off-grid start still lands on-grid', () => {
  // Handle starts at beat 3.1, off the quarter grid. Adding the raw delta
  // would land at 3.6; snapDelta's returned delta must instead land the
  // anchor exactly where snap() would put 3.6 — not the same as snapping
  // the raw 0.5 delta on its own.
  const anchor = 3.1
  const rawDBeats = 0.5
  assert.equal(anchor + snapDelta(anchor, rawDBeats), snap(anchor + rawDBeats))
  assert.notEqual(snapDelta(anchor, rawDBeats), snap(rawDBeats), 'not the same as snapping the delta in isolation')
  assert.equal(snapDelta(anchor, rawDBeats, { mode: 'free' }), rawDBeats, 'free mode is a pass-through')
})

test('withPreview: patches one row with a drag-in-progress payload, leaving the rest and a no-op untouched', () => {
  const rows = [{ beat: 1 }, { beat: 5, dur: 2 }]
  assert.deepEqual(withPreview(rows, null), rows)
  const patched = withPreview(rows, { row: 1, values: { beat: 7 } })
  assert.deepEqual(patched, [{ beat: 1 }, { beat: 7, dur: 2 }])
  assert.deepEqual(rows[1], { beat: 5, dur: 2 }, 'the original row is untouched')
})

test('valuesDiffer: true only when a payload actually changes a stored field', () => {
  assert.equal(valuesDiffer({ beat: 3 }, { beat: 3 }), false)
  assert.equal(valuesDiffer({ beat: 3, end: 5 }, { beat: 3, end: 5.5 }), true)
})

test('resolveHandle: picks the specific ghost placement under the pointer, not just any handle on that row', () => {
  const geometry = { width: 800, maxBeats: 16 }
  const handles: Handle[] = [
    { row: 0, kind: 'point', beat: 1, lane: 0, ghost: false, disabled: false },
    { row: 0, kind: 'point', beat: 9, lane: 0, ghost: true, disabled: false },
  ]
  const xNearGhost = beatToX(geometry, 9)
  const hit = hitTest(handles, geometry, xNearGhost, 0)
  assert.deepEqual(hit, { row: 0, part: 'body' })
  const handle = resolveHandle(handles, geometry, hit!, xNearGhost, 0)
  assert.equal(handle?.ghost, true, 'the ghost placement actually under the pointer, not the primary one')
})

test('meaningfulSummary: identity columns per event type, never position', () => {
  const timelineCols: EditableColumn[] = [
    { name: 'beat', type: 'number' }, { name: 'loop', type: 'number' },
    { name: 'event', type: 'enum', options: ['retime', 'loop', 'hold', 'speed'] },
    { name: 'from', type: 'number' }, { name: 'to', type: 'number' },
    { name: 'disabled', type: 'boolean' },
  ]
  assert.deepEqual(
    meaningfulSummary({ beat: 1, loop: 0, event: 'retime', from: 1, to: 4, disabled: false }, timelineCols),
    ['retime', 'from 1', 'to 4'],
    'event kind unlabeled, params labeled, beat/loop/disabled-false skipped',
  )
  const codeCols: EditableColumn[] = [
    { name: 'beat', type: 'number' },
    { name: 'event', type: 'string' },
    { name: 'code', type: 'code', language: 'hydra' },
  ]
  const sketch = 'osc(10, 0.1)\n  .rotate(1)\n  .out(o0)'
  assert.deepEqual(meaningfulSummary({ beat: 3, event: 'setCode', code: sketch }, codeCols), ['setCode', 'osc(10, 0.1)'])
  const longLine = 'x'.repeat(80)
  assert.ok(meaningfulSummary({ code: longLine }, [{ name: 'code', type: 'code' }])[0].endsWith('…'), 'long code truncates')
})

test('meaningfulSummary: caps entries and is empty for a position-only row', () => {
  const wide: EditableColumn[] = Array.from({ length: 8 }, (_v, i) => ({ name: `c${i}`, type: 'number' as const }))
  const row = Object.fromEntries(wide.map((c, i) => [c.name, i + 1]))
  assert.equal(meaningfulSummary(row, wide).length, 4)
  assert.deepEqual(meaningfulSummary({ beat: 2, dur: 1 }, [{ name: 'beat', type: 'number' }, { name: 'dur', type: 'number' }]), [])
})

// Regression tripwire (the coverage↔passBase order bug that left the table
// panel unmounted): createMemo/createComputed run their body *eagerly* at
// creation, so one whose body synchronously reads a reactive binding declared
// lower in the SAME function scope hits that binding's temporal dead zone and
// throws at first render — a browser-only crash the model tests never
// instantiate. Walks each src/ui component's AST for exactly that forward
// reference: per scope, ignoring nested (deferred) closures and property
// names, so a hover/handler reading a later binding stays legitimately fine.
test('ui components: no eager memo reads a reactive binding declared below it', () => {
  const uiDir = fileURLToPath(new URL('../src/ui', import.meta.url))
  const REACTIVE = new Set(['createSignal', 'createMemo', 'createStore', 'createComputed'])
  const EAGER = new Set(['createMemo', 'createComputed'])
  const calleeName = (init?: ts.Expression): string | undefined =>
    init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) ? init.expression.text : undefined
  const violations: string[] = []

  // Reactive bindings declared directly in one function scope, and where.
  const scopeDecls = (stmts: readonly ts.Statement[]): Map<string, number> => {
    const decls = new Map<string, number>()
    for (const st of stmts) {
      if (!ts.isVariableStatement(st)) continue
      for (const d of st.declarationList.declarations) {
        if (!(calleeName(d.initializer) && REACTIVE.has(calleeName(d.initializer)!))) continue
        if (ts.isIdentifier(d.name)) decls.set(d.name.text, d.pos)
        else if (ts.isArrayBindingPattern(d.name)) for (const el of d.name.elements) if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) decls.set(el.name.text, d.pos)
      }
    }
    return decls
  }

  const scanEagerBody = (node: ts.Node, memoPos: number, decls: Map<string, number>, file: string): void => {
    const walk = (n: ts.Node): void => {
      if (ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isFunctionDeclaration(n)) return // deferred
      if (ts.isPropertyAccessExpression(n)) return walk(n.expression) // skip the property name
      if (ts.isPropertyAssignment(n)) return walk(n.initializer) // skip the key
      if (ts.isIdentifier(n)) {
        const at = decls.get(n.text)
        if (at !== undefined && at > memoPos) violations.push(`${file}: eager memo reads '${n.text}' declared lower in the same scope`)
        return
      }
      ts.forEachChild(n, walk)
    }
    walk(node)
  }

  const visit = (n: ts.Node, file: string): void => {
    if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) && n.body && ts.isBlock(n.body)) {
      const decls = scopeDecls(n.body.statements)
      for (const st of n.body.statements) {
        if (!ts.isVariableStatement(st)) continue
        for (const d of st.declarationList.declarations) {
          const init = d.initializer
          if (calleeName(init) && EAGER.has(calleeName(init)!)) {
            const cb = (init as ts.CallExpression).arguments[0]
            if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) scanEagerBody(cb.body, st.pos, decls, file)
          }
        }
      }
    }
    ts.forEachChild(n, (c) => visit(c, file))
  }

  for (const file of readdirSync(uiDir).filter((f) => f.endsWith('.tsx'))) {
    const sf = ts.createSourceFile(file, readFileSync(`${uiDir}/${file}`, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    visit(sf, file)
  }
  assert.deepEqual(violations, [], violations.join('\n'))
})
