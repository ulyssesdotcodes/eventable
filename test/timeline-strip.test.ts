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
  sectionLayout,
  columnsFromRows,
  hitTest,
  resolveHandle,
  snap,
  snapDelta,
  dragUpdate,
  createAt,
  valuesDiffer,
  exceedsDragThreshold,
  withPreview,
  pendingTimelineRows,
  coverageBands,
  meaningfulSummary,
  type Handle,
} from '../src/timeline-strip.js'
import { sectionsFor, sectionBeat, type TimelineSection } from '../src/timeline-sections.js'
import { hydraTransitionWindows } from '../src/hydra.js'
import { postSpanWindows, postGlidePairs } from '../src/post.js'
import type { Row } from '../src/lineage.js'
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

test('gridLines: labels sit on major ticks and drop wholesale once they would collide', () => {
  assert.deepEqual(gridLines(8, 800).filter((l) => l.label).map((l) => l.beat), [1, 5, 9])
  assert.ok(gridLines(800, 800).every((l) => !l.label), '1px/beat: 4px between majors, under the 24px floor')
})

// --- handlesFor ----------------------------------------------------------------

test('handlesFor: timeline rows become until-next span handles; loop picks the lane, disabled rows drop out', () => {
  const rows = [
    { beat: 1, loop: 0 },
    { beat: 5, loop: 0 },
    { beat: 1, loop: 1, disabled: true },
  ]
  const handles = sectionLayout('timeline', rows, cols('beat', 'loop'), rows, 8).handles
  assert.deepEqual(
    handles.map((h) => ({ row: h.row, kind: h.kind, beat: h.beat, end: h.end, lane: h.lane, disabled: h.disabled })),
    [
      { row: 0, kind: 'span', beat: 1, end: 5, lane: 0, disabled: false },
      { row: 1, kind: 'span', beat: 5, end: 9, lane: 0, disabled: false },
    ],
    'row 0 runs to row 1; row 1 runs to the end of its 8-beat pass; the disabled row gets no handle',
  )
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
  const handles = sectionLayout('hydra', rows, cols('beat'), []).handles
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
  const handles = sectionLayout('post', rows, cols('beat', 'dur'), []).handles
  const barOf = (row: number) => handles.find((h) => h.row === row)!
  assert.equal(barOf(0).kind, 'point', 'a stray dur on a setCode is still a point')
  assert.deepEqual([barOf(1).kind, barOf(1).beat, barOf(1).end], ['span', 3, 5], 'explicit dur bar [beat, beat+dur)')
  assert.deepEqual([barOf(2).kind, barOf(2).beat, barOf(2).end], ['span', 6, 7], 'blank dur → 1-beat bar')
  assert.deepEqual([barOf(3).kind, barOf(3).beat, barOf(3).end], ['span', 8, 9], 'a step gate (dur 0) still spans its 1-beat default')
  assert.equal(barOf(1).endRow, undefined, 'a pulse bar has no destination arrow')
  const win = postSpanWindows(rows).find((w) => w.row === 1)!
  assert.deepEqual([barOf(1).beat, barOf(1).end], [win.start, win.end], 'the bar is the fold window, so the strip cannot drift from playback')
})

test('handlesFor: an eased setVariable stays a point, tagged with the previous same-name row it glides from', () => {
  const rows = [
    { beat: 1, event: 'setVariable', name: 'x', value: 0 }, // step (blank ease): no glide
    { beat: 5, event: 'setVariable', name: 'x', value: 1, ease: 'easeInOut' }, // eased: glides from row 0
    { beat: 7, event: 'setVariable', name: 'x', value: 2, ease: 'step' }, // explicit step: no glide
    { beat: 3, event: 'setVariable', name: 'y', value: 9, ease: 'linear' }, // eased but first of its track: no glide
  ]
  const cols4 = cols('beat')
  const handles = sectionLayout('post', rows, cols4, []).handles
  assert.deepEqual(handles.map((h) => h.kind), ['point', 'point', 'point', 'point'], 'a glide is an arrow, never a bar')
  const glideOf = (row: number) => handles.find((h) => h.row === row)!.glideFrom
  assert.equal(glideOf(1), 0, 'the eased arrival glides from the previous same-name row')
  assert.equal(glideOf(0), undefined, 'a blank-ease keyframe glides from nothing')
  assert.equal(glideOf(2), undefined, 'an explicit step glides from nothing')
  assert.equal(glideOf(3), undefined, 'the first row of a track has no previous to glide from')
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
  const arcs = sectionLayout('hydra', rows, cols('beat'), [], 8).handles.filter((h) => h.row === 2)
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
  const handles = sectionLayout('hits', rows, cols('beat'), timelineRows, 8).handles
  assert.deepEqual(
    handles.map((h) => ({ beat: h.beat, ghost: h.ghost })),
    [{ beat: 1, ghost: false }, { beat: 5, ghost: true }],
  )
})

// --- current-pass selection (the two pass axes) ------------------------------

test('sectionLayout: a content row past loopBeats shows only in ITS content pass, at its pass-local beat', () => {
  // No timeline, so the strip's axis is one 8-beat loop: source beat 20 plays
  // in the third pass of the content, at local beat 4 — and nowhere else.
  const rows = [{ beat: 20 }]
  const at = (content: number) => sectionLayout('hits', rows, cols('beat'), [], 8, { content, timeline: 0 }).handles
  assert.deepEqual(at(2).map((h) => ({ beat: h.beat, lane: h.lane })), [{ beat: 4, lane: 0 }], '(20 - 1) % 8 + 1 == 4')
  assert.deepEqual(at(0), [], 'the row is simply absent from the passes it does not play in')
  assert.deepEqual(at(1), [])
})

test('sectionLayout: content pass filters SOURCE beats, timeline pass selects PLACED beats — the two axes are independent', () => {
  // R1. Pass 0 of the warp holds source beat 3; pass 1 retimes source 1..9
  // across its own 8 beats. Content pass 0 is source 1..8, content pass 1 is
  // source 9..16 — a different axis, applied before the warp, not after.
  const warp = [
    { event: 'hold', beat: 1, from: 3, loop: 0 },
    { event: 'retime', beat: 1, from: 1, to: 9, loop: 1 },
  ]
  const rows = [{ beat: 3 }, { beat: 12 }]
  const at = (content: number, timeline: number) =>
    sectionLayout('hits', rows, cols('beat'), warp, 8, { content, timeline }).handles
      .map((h) => ({ row: h.row, beat: h.beat, pass: h.pass }))
  assert.deepEqual(at(0, 0), [{ row: 0, beat: 1, pass: undefined }], 'the hold shows source 3 at the top of its pass')
  assert.deepEqual(at(0, 1), [{ row: 0, beat: 3, pass: 1 }], 'the retime shows the same source beat a quarter in')
  assert.deepEqual(at(1, 1), [{ row: 1, beat: 4, pass: 1 }], 'source 12 is content-pass 1 local beat 4, placed by the retime')
  assert.deepEqual(at(1, 0), [], "content pass 1's local beat 4 is nowhere in a pass that holds source 3")
})

test('sectionLayout: a warp-moved row is inert, a row still on its stored beat carries its store source', () => {
  // OQ1: dragging survives only where the strip is not remapped. Source 1..5
  // stretches across the 8-beat pass, so the cooked row at source 1 lands on
  // beat 1 (untouched, draggable) and the one at source 3 lands on beat 5.
  const applied = [{ event: 'retime', beat: 1, from: 1, to: 5 }]
  const store = [{ beat: 1 }, { beat: 3 }]
  const resolveSource = (r: Row) => {
    const row = store.findIndex((s) => s.beat === r.beat)
    return row < 0 ? undefined : { table: 'hydra', row, beat: store[row].beat }
  }
  const handles = sectionLayout('hydra', [{ beat: 1 }, { beat: 3 }], cols('beat'), applied, 8,
    { content: 0, timeline: 0 }, resolveSource).handles
  assert.deepEqual(
    handles.map((h) => ({ beat: h.beat, source: h.source })),
    [{ beat: 1, source: { table: 'hydra', row: 0 } }, { beat: 5, source: undefined }],
  )
  assert.equal(sectionLayout('hydra', [{ beat: 1 }], cols('beat'), applied, 8).handles[0].source, undefined,
    'a section with no source resolver is read-only')
})

test('sectionLayout: the timeline section keeps live-store-row identity — a window IS its storage row', () => {
  const rows = [{ beat: 1, loop: 0 }, { beat: 5, loop: 0 }, { beat: 1, loop: 1 }]
  const pass = (timeline: number) => sectionLayout('timeline', rows, cols('beat', 'loop'), rows, 8, { content: 0, timeline }).handles
  assert.deepEqual(
    pass(1).map((h) => ({ row: h.row, beat: h.beat, end: h.end, source: h.source })),
    [{ row: 2, beat: 1, end: 9, source: { table: 'timeline', row: 2 } }],
    "only pass 2's own window, at its pass-local beats",
  )
  assert.deepEqual(pass(0).map((h) => h.row), [0, 1])
})

// --- sub-lane packing --------------------------------------------------------

test('sub-lane packing: overlapping spans stack into sub-lanes, disjoint spans share one, deterministically', () => {
  // A plain dur-column table: 1..4 and 3..6 overlap, so they pack into
  // sub-lanes 0 and 1; 7..9 is clear of both, back to lane 0.
  const rows = [
    { beat: 7, dur: 2 },
    { beat: 1, dur: 3 },
    { beat: 3, dur: 3 },
  ]
  const columns = cols('beat', 'dur')
  const laneOf = () => sectionLayout('scene', rows, columns, []).handles
    .sort((a, b) => a.beat - b.beat).map((h) => h.lane)
  assert.deepEqual(laneOf(), [0, 1, 0], 'first-fit by start: 1..4 → 0, 3..6 → 1, 7..9 → 0')
  assert.equal(sectionLayout('scene', rows, columns, []).laneCount, 2)
})

// --- out-view sections -------------------------------------------------------

test('out sections: cooked rows place through the APPLIED timeline, not the live rows being edited', () => {
  // Applied warp stretches source 1..5 across the 8-beat pass; the live store
  // rows have dropped it (a pending edit). Playback still warps by the applied
  // rows, so the out section's indicator must sit where playback will show the
  // beat — source 3, the stretch midpoint, at playback beat 5.
  const applied = [{ event: 'retime', beat: 1, from: 1, to: 5 }]
  const cooked = [{ id: 'a', event: 'update', beat: 3 }]
  assert.equal(sectionLayout('three', cooked, columnsFromRows(cooked), applied, 8).handles[0].beat, 5,
    'the out view follows the applied warp')
  assert.equal(sectionLayout('three', cooked, columnsFromRows(cooked), [], 8).handles[0].beat, 3,
    'a section placed through the live (identity) rows stays at its own beat')
})

test('out sections: a dur column inferred from cooked rows still draws a bar', () => {
  const rows = [{ beat: 3, dur: 2 }]
  const { handles, laneCount } = sectionLayout('three', rows, columnsFromRows(rows), [], 8)
  assert.deepEqual([handles[0].kind, handles[0].beat, handles[0].end, handles[0].lane], ['span', 3, 5, 0])
  assert.equal(laneCount, 1, 'a section is only as tall as its own overlapping spans')
})

test('out sections: a hydra transition span keeps fold-window parity on its own band', () => {
  const rows = [
    { beat: 3, event: 'setCode', code: 'osc().out(o0)' },
    { beat: 5, event: 'transition' },
    { beat: 9, event: 'setCode', code: 'noise().out(o0)' },
  ]
  const { handles } = sectionLayout('hydra', rows, columnsFromRows(rows), [])
  const t = handles.find((h) => h.row === 1)!
  const win = hydraTransitionWindows(rows)[0]
  assert.deepEqual([t.kind, t.beat, t.end, t.endRow], ['span', win.start, win.end, win.endRow])
})

// --- sectionsFor -------------------------------------------------------------

test('sectionsFor: the warp leads, then one band per out view with placeable rows, then the automation plots', () => {
  const sections = sectionsFor({
    cooked: {
      views: new Map([['hydra', { rows: [] }], ['post', { rows: [] }]]),
      hydraRows: [{ beat: 1, event: 'setCode', code: 'osc().out(o0)' }],
      baubleRows: [],
      postRows: [{ beat: 2, event: 'setVariable', name: 'glow', value: 0.5 }],
    },
    particleRows: [],
    timelineRows: [{ event: 'retime', beat: 1 }],
    sliderRows: [{ id: 'a', value: 0.5, beat: 1 }],
    midiRows: [],
    passes: { hydra: { pass: 1, loops: 2 } },
  })
  assert.deepEqual(
    sections.map((s) => ({ name: s.name, kind: s.kind, view: s.view, drag: s.drag })),
    [
      { name: 'timeline', kind: 'timeline', view: 'timeline', drag: 'rows' },
      { name: 'hydra', kind: 'events', view: 'hydra', drag: 'lineage' },
      { name: 'post', kind: 'events', view: 'post', drag: 'lineage' },
      { name: 'slider', kind: 'channel', view: 'slider', drag: 'none' },
      { name: 'post vars', kind: 'channel', view: 'post', drag: 'none' },
    ],
    'bauble/particles/midi have nothing to show, so they get no band',
  )
  assert.deepEqual(sections.find((s) => s.name === 'hydra')!.pass, { pass: 1, loops: 2 }, 'each out band carries its own content pass')
  assert.deepEqual(sections.find((s) => s.name === 'slider')!.channel, { idCol: 'id', valueCol: 'value' })
  assert.deepEqual(sections.find((s) => s.name === 'post vars')!.rows.map((r) => r.name), ['glow'])
})

test('sectionBeat: a band with content passes counts its own; a flat one reports the warp\'s pass', () => {
  const band = (pass: { pass: number; loops: number }): TimelineSection =>
    ({ name: 'hydra', kind: 'events', view: 'hydra', rows: [], pass, drag: 'lineage' })
  const at = { srcBeat: 2.5, loopBeats: 8, timelinePass: 1, timelineLoops: 3 }
  assert.deepEqual(sectionBeat(band({ pass: 2, loops: 3 }), at), { beat: 18.5, pass: 2, loops: 3 },
    'content pass 2 of an 8-beat loop sits 16 beats past the source beat')
  assert.deepEqual(sectionBeat(band({ pass: 0, loops: 1 }), at), { beat: 2.5, pass: 1, loops: 3 },
    'no content passes of its own: playback\'s timeline pass, at the plain source beat')
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
  assert.deepEqual(coverageBands([]), [], 'no active timeline yields no bands')
})

// --- pendingTimelineRows ----------------------------------------------------

test('pendingTimelineRows: a row whose beat or pass drifted from the applied cook is pending, as is one past its end; a disabled row is skipped', () => {
  const rows = [
    { beat: 1, loop: 0 },
    { beat: 20, disabled: true },
    { beat: 9, loop: 0 },
    { beat: 17 },
  ]
  const applied = [
    { beat: 1, loop: 0 },
    { beat: 9, loop: 1 }, // row 2's pass moved after Apply
  ]
  assert.deepEqual(pendingTimelineRows(rows, applied), new Set([2, 3]))
})

// --- hitTest ----------------------------------------------------------------

test('hitTest: a span is grabbable across its body and a little past either edge; background misses return null', () => {
  const geometry = { width: 400, maxBeats: 16 }
  const handles: Handle[] = [
    { row: 0, kind: 'span', beat: 1, end: 9, lane: 0, ghost: false, disabled: false },
  ]
  const startX = beatToX(geometry, 1)
  const midX = beatToX(geometry, 5)
  assert.equal(hitTest(handles, geometry, startX - 4, 0), 0, 'just outside the start edge still grabs the span')
  assert.equal(hitTest(handles, geometry, midX, 0), 0)
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

test('dragUpdate on a span only writes beat — dur (a length) rides along, preserving duration', () => {
  const handle: Handle = { row: 2, kind: 'span', beat: 5, end: 13, lane: 0, ghost: false, disabled: false }
  const { row, values } = dragUpdate(handle, 3)
  assert.equal(row, 2)
  assert.deepEqual(values, { beat: 8 })
})

test('dragUpdate maps a content-table drop back through the timeline sourceBeatAt', () => {
  // Half speed: source 1..5 stretched across playback 1..9 (loop-beats 8).
  const timeline = buildTimeline([{ event: 'retime', beat: 1, from: 1, to: 5 }], 8)
  const handle: Handle = { row: 0, kind: 'point', beat: 1, lane: 0, ghost: false, disabled: false }
  // Drag the handle from playback beat 1 to playback beat 5 (the midpoint).
  const { values } = dragUpdate(handle, 4, { timeline })
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
  const { values } = dragUpdate(handle, 0, { timeline })
  assert.equal(values.beat, 7, "pass 2's hold source (7), not pass 1's (3)")
})

test('createAt seeds a keyframe in the band\'s own store table at the snapped source beat, and refuses a read-only band', () => {
  // Half speed: source 1..5 stretched across playback 1..9 (loop-beats 8).
  const timeline = buildTimeline([{ event: 'retime', beat: 1, from: 1, to: 5 }], 8)
  const editable: Handle[] = [
    { row: 0, kind: 'point', beat: 1, lane: 0, ghost: false, disabled: false, source: { table: 'path', row: 0 } },
  ]
  assert.deepEqual(createAt(editable, 4.9), { table: 'path', values: { beat: 5 } }, 'quarter-snapped')
  assert.deepEqual(
    createAt(editable, 5, { timeline })?.values, { beat: timeline.sourceBeatAt(5) },
    'stored in source space, like a drag drop',
  )
  const cooked = editable.map((h) => ({ ...h, source: undefined }))
  assert.equal(createAt(cooked, 5), null, 'nothing traceable behind the band — creates nothing')
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
  assert.equal(hit, 0)
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
