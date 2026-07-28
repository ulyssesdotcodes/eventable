import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wallAlignedTick, wallAlignedLoop, loopEpochsFromApplies, loopBeatsFromEvents } from '../src/playback.js'

test('wallAlignedTick is 0 exactly at the anchor instant', () => {
  assert.equal(wallAlignedTick(1000, 1000, 4), 0)
})

test('wallAlignedTick advances linearly with elapsed wall time', () => {
  assert.equal(wallAlignedTick(1000 + 1500, 1000, 4), 1.5)
})

test('wallAlignedTick wraps into [0, loopSeconds) past one loop', () => {
  assert.equal(wallAlignedTick(1000 + 4500, 1000, 4), 0.5)
  assert.equal(wallAlignedTick(1000 + 4000 * 3 + 500, 1000, 4), 0.5, 'wraps across multiple loops the same way')
})

test('wallAlignedTick handles "now" before the anchor (still non-negative)', () => {
  assert.equal(wallAlignedTick(1000 - 500, 1000, 4), 3.5)
})

test('wallAlignedTick returns 0 for a non-positive loop length', () => {
  assert.equal(wallAlignedTick(5000, 1000, 0), 0)
  assert.equal(wallAlignedTick(5000, 1000, -4), 0)
})

// --- Engine tests: the timing/loop/scrub state machine, driven through the
// injectable clock (see PlaybackClock in playback.ts) ------------------------

import {
  createPlaybackEngine, pausedMsBefore, transportStateFromEvents, playbackOrigin,
  type PlaybackEngine, type TapControl,
} from '../src/playback.js'
import { createSceneVisualizer, createHydraVisualizer, type Visualizer } from '../src/visualizer.js'
import { rasterizeRows } from '../src/rasterize.js'
import { DEFAULT_BEAT_SECONDS, DEFAULT_LOOP_BEATS } from '../src/constants.js'
import { Table, time as timeExpr, type EvalCtx } from '../src/dsl.js'
import type { Row } from '../src/lineage.js'

function fakeScene() {
  return {
    // SceneAPI's camera/renderer/scene are for screenshot tooling and the post
    // stage; nothing here reads them.
    camera: null as never,
    renderer: null as never,
    scene: null as never,
    setPost(): void {},
    calls: [] as string[],
    setParticlesEnabled(): void {},
    setParticleParam(): void {},
    setParticleTime(): void {},
    createObject(): void { this.calls.push('create') },
    updateObject(): void { this.calls.push('update') },
    destroyObject(): void { this.calls.push('destroy') },
    reset(): void { this.calls.push('reset') },
  }
}

function fakeHydra() {
  return {
    ticks: [] as number[],
    setSketch(): void { /* recorded implicitly via ticks */ },
    tick(t: number): void { this.ticks.push(t) },
    previews: [] as ({ code: string; vars: Record<string, unknown> } | null)[],
    setPreview(code: string | null, vars: Record<string, unknown>): void {
      this.previews.push(code == null ? null : { code, vars })
    },
    reset(): void { /* noop */ },
    reinit(): void { /* noop */ },
  }
}

// One shared fake time source: monotonic and epoch clocks advance together,
// and raf callbacks queue until frame() runs them.
function fakeTime(startMs: number) {
  let t = startMs
  const queue: Array<() => void> = []
  return {
    clock: {
      now: () => t,
      epochNow: () => t,
      raf: (cb: () => void) => { queue.push(cb) },
    },
    advance(ms: number): void { t += ms },
    frame(): void { for (const cb of queue.splice(0)) cb() },
  }
}

// Hydra-only program: content exists (so playback runs) with no scene rows to stage.
const HYDRA_ROWS: Row[] = [{ event: 'setCode', code: 'osc().out()', beat: 1 }]

const sceneCreate = (): Row => ({
  id: 's', event: 'create', beat: 1, shape: 'sphere',
  px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0,
})

function makeEngine(
  time: ReturnType<typeof fakeTime>,
  extra: {
    tapControl?: TapControl
    onLoop?: () => void
    onLoopBeats?: (n: number) => void
    onPause?: () => void
    pausedMsBefore?: (wallMs: number) => number
  } = {},
): PlaybackEngine {
  const engine = createPlaybackEngine(
    [createSceneVisualizer(fakeScene()), createHydraVisualizer(fakeHydra())],
    { clock: time.clock, ...extra },
  )
  engine.load({ sceneRows: [], timelineRows: [], hydraRows: HYDRA_ROWS })
  return engine
}

test('pressing play joins the wall-aligned beat grid instead of starting at 0', () => {
  // Epoch 1000ms into an 8s loop (16 beats × 0.5 s/beat) → phase 2 beats.
  const time = fakeTime(1000)
  const engine = makeEngine(time)
  engine.toggle()
  const vs = engine.viewState()
  assert.equal(vs.state, 'playing')
  assert.equal(vs.pos, (1 / (DEFAULT_LOOP_BEATS * DEFAULT_BEAT_SECONDS) % 1) * DEFAULT_LOOP_BEATS)
  assert.equal(vs.pos, 2)
})

test('the playhead advances at the anchored tempo, one frame at a time', () => {
  const time = fakeTime(1000)
  const engine = makeEngine(time)
  engine.toggle() // playing at pos 2
  time.advance(1000) // +2 beats at 0.5 s/beat
  time.frame()
  assert.equal(engine.viewState().pos, 4)
})

test('pause freezes the position; resume continues from it', () => {
  const time = fakeTime(1000)
  const engine = makeEngine(time)
  engine.toggle()
  time.advance(1000)
  time.frame()
  engine.toggle() // pause at 4
  assert.equal(engine.viewState().state, 'paused')
  time.advance(5000)
  assert.equal(engine.viewState().pos, 4, 'paused position ignores wall time')
  engine.toggle() // resume
  assert.equal(engine.viewState().pos, 4)
  time.advance(500)
  time.frame()
  assert.equal(engine.viewState().pos, 5)
})

test('a loop wrap re-derives the wall-aligned phase and fires onLoop', () => {
  const time = fakeTime(1000)
  let loops = 0
  const engine = makeEngine(time, { onLoop: () => loops++ })
  engine.toggle() // pos 2, startTime anchored so position() = 2
  // Push position past the 16-beat end: 15 more beats of wall time.
  time.advance(7500) // position() = 17; epoch = 8500 → phase (8.5 % 8)/0.5 = 1
  time.frame()
  assert.equal(loops, 1)
  assert.equal(engine.viewState().pos, 1, 'wrap lands on the wall-aligned phase, not just pos % maxBeats')
})

test('with loop off, reaching the end parks the playhead at maxBeats and goes idle', () => {
  const time = fakeTime(0)
  const engine = makeEngine(time)
  engine.setLoop(false)
  engine.toggle() // phase 0 at epoch 0
  time.advance(DEFAULT_LOOP_BEATS * DEFAULT_BEAT_SECONDS * 1000 + 100)
  time.frame()
  const vs = engine.viewState()
  assert.equal(vs.state, 'idle')
  assert.equal(vs.pos, DEFAULT_LOOP_BEATS)
})

test('scrub previews the dragged position (thumb frozen at the drag)', () => {
  const time = fakeTime(0)
  const engine = makeEngine(time)
  engine.scrub(3)
  const vs = engine.viewState()
  assert.equal(vs.scrubPos, 3)
  assert.equal(vs.pos, 3)
})

test('scrubbing while paused commits the playhead for the next resume', () => {
  const time = fakeTime(1000)
  const engine = makeEngine(time)
  engine.toggle() // playing at 2
  engine.toggle() // paused at 2
  engine.scrub(6)
  engine.endScrub()
  assert.equal(engine.viewState().pos, 6)
  engine.toggle() // resume from the scrubbed beat
  time.advance(500)
  time.frame()
  assert.equal(engine.viewState().pos, 7)
})

test('setLoopBeats clamps to a whole beat >= 1 and resizes the loop', () => {
  const time = fakeTime(0)
  const engine = makeEngine(time)
  engine.setLoopBeats(2.4)
  assert.equal(engine.viewState().loopBeats, 2)
  assert.equal(engine.viewState().maxBeats, 2)
  engine.setLoopBeats(0)
  assert.equal(engine.viewState().loopBeats, DEFAULT_LOOP_BEATS)
})

test('the loop is the GUI beat count regardless of how much scene content is baked', () => {
  const time = fakeTime(0)
  const engine = makeEngine(time)
  // 4 beats of baked scene content in the default 16-beat loop: content never
  // stretches (or shrinks) the loop, it just plays inside it.
  engine.load({ sceneRows: rasterizeRows([sceneCreate()], 4), timelineRows: [], hydraRows: [] })
  assert.equal(engine.viewState().maxBeats, DEFAULT_LOOP_BEATS)
  engine.setLoopBeats(3)
  assert.equal(engine.viewState().maxBeats, 3)
})

test('setLoopBeats reports a real change through onLoopBeats (clamped no-ops stay silent)', () => {
  const time = fakeTime(0)
  const seen: number[] = []
  const engine = makeEngine(time, { onLoopBeats: (n) => seen.push(n) })
  engine.setLoopBeats(8)
  engine.setLoopBeats(8.2) // clamps to 8 — unchanged
  engine.setLoopBeats(4)
  assert.deepEqual(seen, [8, 4])
})

test('retempo re-anchors to the new tapped tempo without moving a paused playhead', () => {
  const time = fakeTime(1000)
  let taps: Row[] = []
  const tapControl: TapControl = {
    tap: () => {},
    clear: () => {},
    rows: () => taps,
    anchor: () => (taps.length >= 2 ? (taps[0].time as number) : null),
  }
  const engine = makeEngine(time, { tapControl })
  engine.toggle() // playing at 2 (default tempo)
  engine.toggle() // paused at 2
  taps = [{ beat: 0, time: 1000 }, { beat: 1, time: 1250 }] // 0.25 s/beat → 240 bpm
  engine.retempo()
  const vs = engine.viewState()
  assert.equal(vs.pos, 2, 'paused playhead keeps its beat position across a tempo change')
  assert.equal(vs.bpm, 240)
  // Resume: the clock now advances at the new tempo.
  engine.toggle()
  time.advance(250)
  time.frame()
  assert.equal(engine.viewState().pos, 3)
})

// --- pausedMsBefore — the wall→musical clock shift ---------------------------

test('pausedMsBefore sums closed pause/play pairs elapsed before t', () => {
  const events: Row[] = [
    { kind: 'playback-pause', at: 1000 },
    { kind: 'playback-play', at: 1500 },
    { kind: 'playback-pause', at: 2000 },
    { kind: 'playback-play', at: 2200 },
  ]
  assert.equal(pausedMsBefore(events, 1000), 0, 'right at the pause boundary, no elapsed pause yet')
  assert.equal(pausedMsBefore(events, 1500), 500)
  assert.equal(pausedMsBefore(events, 3000), 700, 'both closed pairs: 500 + 200')
})

test('pausedMsBefore counts an open (unclosed) pause up to t', () => {
  const events: Row[] = [{ kind: 'playback-pause', at: 1000 }]
  assert.equal(pausedMsBefore(events, 1000), 0)
  assert.equal(pausedMsBefore(events, 4000), 3000)
})

test('pausedMsBefore ignores events with a missing or invalid at', () => {
  const events: Row[] = [
    { kind: 'playback-pause' }, // no `at`
    { kind: 'playback-pause', at: 'nope' }, // not a number
    { kind: 'playback-pause', at: NaN },
  ]
  assert.equal(pausedMsBefore(events, 9000), 0)
})

test('pausedMsBefore treats a lone leading play (or no events at all) as zero pause', () => {
  assert.equal(pausedMsBefore([{ kind: 'playback-play', at: 1000 }], 9000), 0)
  assert.equal(pausedMsBefore([], 9000), 0)
})

test('pausedMsBefore is idempotent under interleaved authors recording the same transition twice', () => {
  const events: Row[] = [
    { kind: 'playback-pause', at: 1000, client: 'a' },
    { kind: 'playback-pause', at: 1001, client: 'b' }, // both paused near-simultaneously
    { kind: 'playback-play', at: 2000, client: 'a' },
    { kind: 'playback-play', at: 2001, client: 'b' },
  ]
  assert.equal(pausedMsBefore(events, 3000), 1000, 'the redundant pause/play pair contributes nothing extra')
})

// --- transportStateFromEvents — the room's current play/pause state ----------

test('transportStateFromEvents reads the latest event by at (not encounter order); null with nothing recorded', () => {
  assert.equal(transportStateFromEvents([]), null)
  assert.equal(transportStateFromEvents([{ kind: 'playback-play', at: 1000 }]), 'playing')
  assert.equal(
    transportStateFromEvents([
      { kind: 'playback-play', at: 1000 },
      { kind: 'playback-pause', at: 500 }, // logged later but wall-earlier
    ]),
    'playing',
  )
})

// --- playbackOrigin — the musical grid's origin absent a tap tempo -----------

test('playbackOrigin prefers a tap anchor over anything on the activity table', () => {
  assert.equal(playbackOrigin([{ kind: 'session-start', at: 100 }], 999), 999)
})

test('playbackOrigin falls back to the earliest session-start; a playback-play is never an origin', () => {
  assert.equal(
    playbackOrigin([{ kind: 'session-start', at: 500 }, { kind: 'playback-play', at: 900 }], null),
    500,
    'the room began before anyone pressed play',
  )
  // A recorded play is usually a resume — adopting it would re-base the grid
  // mid-session (the snap-at-wrap regression), so solo stays epoch-anchored.
  assert.equal(playbackOrigin([{ kind: 'playback-play', at: 700 }], null), 0)
})

test('playbackOrigin is the Unix epoch with no taps and no activity events (or only invalid ones)', () => {
  assert.equal(playbackOrigin([], null), 0)
  assert.equal(playbackOrigin([{ kind: 'session-start' }, { kind: 'playback-play', at: 'x' }], null), 0)
})

// --- pause()/play() and the pause-shifted resume regression ------------------

test('pause() and play() are idempotent, and pause() from idle lands frozen on the wall-aligned position', () => {
  const time = fakeTime(1000) // matches the "pressing play" test's numbers: phase 2 beats
  const engine = makeEngine(time)
  engine.pause() // idle → paused directly, no ticking first
  assert.equal(engine.viewState().state, 'paused')
  assert.equal(engine.viewState().pos, 2, 'lands where a client playing since the anchor would be')
  engine.pause() // already paused — no-op
  assert.equal(engine.viewState().pos, 2)
  engine.play() // resumes from the frozen position
  assert.equal(engine.viewState().state, 'playing')
  assert.equal(engine.viewState().pos, 2)
  engine.play() // already playing — no-op
  assert.equal(engine.viewState().state, 'playing')
})

test('onPause fires on every transition into paused, including pause() from idle; never on a no-op', () => {
  const time = fakeTime(0)
  let pauses = 0
  const engine = makeEngine(time, { onPause: () => pauses++ })
  engine.pause() // idle → paused
  assert.equal(pauses, 1)
  engine.pause() // already paused
  assert.equal(pauses, 1)
  engine.play()
  engine.pause() // playing → paused
  assert.equal(pauses, 2)
})

test('resume continues from the paused musical moment across a loop wrap — the snap-back regression', () => {
  const time = fakeTime(1000)
  const transportEvents: Row[] = []
  const engine = makeEngine(time, { pausedMsBefore: (wallMs) => pausedMsBefore(transportEvents, wallMs) })
  engine.toggle() // playing at pos 2 (epoch 1000 into the default 8s loop)
  time.advance(1000)
  time.frame() // pos 4
  engine.toggle() // pause at pos 4
  transportEvents.push({ kind: 'playback-pause', at: time.clock.epochNow() }) // at 2000
  time.advance(7000) // paused for 7s of wall time
  transportEvents.push({ kind: 'playback-play', at: time.clock.epochNow() }) // at 9000
  engine.toggle() // resume — still shows 4, unaffected by the paused wall time
  assert.equal(engine.viewState().pos, 4)
  // 7s more of wall time at 0.5 s/beat = 14 beats past the resume, wrapping
  // the 16-beat loop once: 4 + 14 = 18 → 18 - 16 = 2. Without the pause
  // shift, the wall-aligned re-derivation at wrap would instead jump to
  // wherever raw wall time says (here, phase 0) — the bug this feature fixes.
  time.advance(7000)
  time.frame()
  assert.equal(engine.viewState().pos, 2, 'wraps to where 4 + 14 elapsed beats would land, not raw wall time')
})

test('passesSince (multi-pass content) is unaffected by a pause spanning the loop epoch and now', () => {
  const time = fakeTime(0)
  const hydra = fakeHydra()
  const sketches: (string | null)[] = []
  hydra.setSketch = (s?: { code: string } | null) => { sketches.push(s?.code ?? null) }
  // A pause from 500ms to 1500ms sits wholly between the loop epoch (0, the
  // default with no apply stamp) and "now" once the clock reaches 2000ms —
  // 1000ms of paused wall time that must not count toward pass advancement.
  const transportEvents: Row[] = [
    { kind: 'playback-pause', at: 500 },
    { kind: 'playback-play', at: 1500 },
  ]
  const engine = createPlaybackEngine([createHydraVisualizer(hydra)], {
    clock: time.clock,
    pausedMsBefore: (wallMs) => pausedMsBefore(transportEvents, wallMs),
  })
  engine.setLoopBeats(2)
  engine.load({ sceneRows: [], timelineRows: [], hydraRows: [
    { event: 'setCode', code: 'a', beat: 1 },
    { event: 'setCode', code: 'b', beat: 3 },
  ] })
  engine.toggle() // epoch 0 → phase 0, pass 0
  assert.equal(sketches.at(-1), 'a.out(o0)')
  // Raw wall time to reach one loop of MUSICAL time: 1s of loop plus the 1s
  // the pause ate = 2s of wall time.
  time.advance(2000)
  time.frame()
  assert.equal(sketches.at(-1), 'b.out(o0)', 'exactly pass 1, matching one loop of musical (not wall) time elapsed')
})

test('the engine feeds ctx.loop() — whole loops since the origin (activity-log start)', () => {
  const time = fakeTime(1000) // session start (origin) at epoch 1000
  let seen: EvalCtx | null = null
  const capture: Visualizer = {
    load(): void {},
    hasContent: () => true,
    applyFrame(frame): Row[] { seen = frame.ctx; return [] },
    clear(): void {},
    blank(): void {},
  }
  const engine = createPlaybackEngine([capture], {
    clock: time.clock,
    // main.ts wires tapControl.anchor to playbackOrigin over the activity log;
    // here the origin (earliest session-start) is epoch 1000.
    tapControl: { tap(): void {}, clear(): void {}, rows: () => [], anchor: () => 1000 },
  })
  engine.load({ sceneRows: [], timelineRows: [], hydraRows: HYDRA_ROWS })
  engine.toggle() // play from the origin
  assert.equal(seen!.loop!(), 0, 'the first pass is loop 0')
  // The default 16-beat loop at 0.5 s/beat spans 8s of wall time per pass.
  time.advance(8000); time.frame()
  assert.equal(seen!.loop!(), 1, 'one whole loop elapsed')
  time.advance(8000); time.frame()
  assert.equal(seen!.loop!(), 2, 'two whole loops elapsed')
})

// --- wallAlignedLoop — the quotient companion to wallAlignedTick -------------

test('wallAlignedLoop counts completed loops since the anchor', () => {
  assert.equal(wallAlignedLoop(1000, 1000, 4), 0)
  assert.equal(wallAlignedLoop(1000 + 3999, 1000, 4), 0, 'still inside the first loop')
  assert.equal(wallAlignedLoop(1000 + 4000, 1000, 4), 1, 'increments exactly at the wrap')
  assert.equal(wallAlignedLoop(1000 + 4000 * 3 + 500, 1000, 4), 3)
})

test('wallAlignedLoop and wallAlignedTick are the quotient/remainder of one division', () => {
  const anchorMs = 1000, loopSeconds = 4, nowMs = anchorMs + 10500
  const elapsed = (nowMs - anchorMs) / 1000
  assert.equal(
    wallAlignedLoop(nowMs, anchorMs, loopSeconds) * loopSeconds + wallAlignedTick(nowMs, anchorMs, loopSeconds),
    elapsed,
  )
})

test('wallAlignedLoop returns 0 for a non-positive loop length', () => {
  assert.equal(wallAlignedLoop(5000, 1000, 0), 0)
  assert.equal(wallAlignedLoop(5000, 1000, -4), 0)
})

// --- loopEpochsFromApplies — shared loop epochs from stamped apply pulses ----

test('loopEpochsFromApplies keeps the newest apply stamp per changed kind', () => {
  const epochs = loopEpochsFromApplies([
    { kind: 'apply', changed: ['scene', 'hydra'], at: 1000 },
    { kind: 'apply', changed: ['scene'], at: 5000 },
  ])
  assert.deepEqual(epochs, { scene: 5000, hydra: 1000 })
})

test('loopEpochsFromApplies ignores non-apply events and unstamped (legacy) pulses', () => {
  const epochs = loopEpochsFromApplies([
    { kind: 'peer-join', at: 1 },
    { kind: 'session-start' },
    { kind: 'apply' }, // legacy pulse, no stamp
    { kind: 'apply', changed: ['timeline'], at: 2000 },
    { kind: 'apply', changed: [], at: 9000 }, // a run that changed nothing
  ])
  assert.deepEqual(epochs, { timeline: 2000 })
})

test('a stamped apply without a changed list counts for every kind', () => {
  assert.deepEqual(loopEpochsFromApplies([{ kind: 'apply', at: 7 }]), { scene: 7, timeline: 7, hydra: 7, bauble: 7, post: 7 })
})

// --- loopBeatsFromEvents — the loop length folded off the activity table -----

test('loopBeatsFromEvents keeps the newest set-loop-beats, ignoring other events and junk values', () => {
  assert.equal(loopBeatsFromEvents([
    { kind: 'apply', at: 1 },
    { kind: 'set-loop-beats', beats: 8, at: 2 },
    { kind: 'set-loop-beats', beats: 0, at: 3 },   // < 1 — ignored
    { kind: 'set-loop-beats', beats: 'x', at: 4 }, // not a number — ignored
    { kind: 'set-loop-beats', beats: 12, at: 5 },
  ]), 12)
  assert.equal(loopBeatsFromEvents([{ kind: 'apply', at: 1 }]), null, 'null with none recorded')
  assert.equal(loopBeatsFromEvents([]), null)
})

test('the pending-edit preview runs the editor buffer against the applied frame, leaving the output alone', () => {
  const time = fakeTime(0)
  const hydra = fakeHydra()
  const applied: (string | null)[] = []
  hydra.setSketch = (s?: { code: string } | null) => { applied.push(s?.code ?? null) }
  let pending: string | null = null
  const engine = createPlaybackEngine([createHydraVisualizer(hydra, () => pending)], { clock: time.clock })
  engine.load({ sceneRows: [], timelineRows: [], hydraRows: [
    { event: 'setCode', code: 'osc(1)', beat: 1 },
    { event: 'setVariable', name: 'freq', value: 7, beat: 1 },
  ] })
  // Paused: typing moves no playhead, so refresh() is what lands the preview.
  engine.toggle()
  engine.toggle()
  pending = 'osc(2).out(o0)'
  engine.refresh()
  assert.equal(hydra.previews.at(-1)?.code, 'osc(2).out(o0)')
  assert.equal(hydra.previews.at(-1)?.vars.freq, 7, 'the preview sees the frame’s folded variables')
  assert.equal(applied.at(-1), 'osc(1).out(o0)', 'the visible output still shows the applied sketch')
})

// --- beat-derived passes: content past the loop's end plays in later passes --

test('a hydra event past the loop plays once the wall-aligned pass reaches it', () => {
  const time = fakeTime(0)
  const hydra = fakeHydra()
  const sketches: (string | null)[] = []
  hydra.setSketch = (s?: { code: string } | null) => { sketches.push(s?.code ?? null) }
  const engine = createPlaybackEngine([createHydraVisualizer(hydra)], { clock: time.clock })
  engine.setLoopBeats(2)
  // Beat 3 is past the 2-beat loop → the second pass's first beat.
  engine.load({ sceneRows: [], timelineRows: [], hydraRows: [
    { event: 'setCode', code: 'a', beat: 1 },
    { event: 'setCode', code: 'b', beat: 3 },
  ] })
  engine.toggle() // epoch 0 → phase 0, pass 0
  assert.equal(sketches.at(-1), 'a.out(o0)')
  time.advance(2 * DEFAULT_BEAT_SECONDS * 1000) // one full loop → pass 1
  time.frame()
  assert.equal(sketches.at(-1), 'b.out(o0)', 'pass 1 reaches the beat-3 event')
  time.advance(2 * DEFAULT_BEAT_SECONDS * 1000) // pass 2 wraps back to pass 0
  time.frame()
  assert.equal(sketches.at(-1), 'a.out(o0)', 'the sequence wraps to pass 0')
})

test('the engine supplies ctx.time: a time() binding resolves to source seconds', () => {
  const time = fakeTime(0)
  const states: Row[] = []
  const scene = {
    ...fakeScene(),
    createObject: (s: Record<string, unknown>): void => { states.push(s as Row) },
    updateObject: (s: Record<string, unknown>): void => { states.push(s as Row) },
  }
  const engine = createPlaybackEngine([createSceneVisualizer(scene)], { clock: time.clock })
  const rows = new Table([sceneCreate()]).derive({ ry: timeExpr() }).rows
  engine.load({ sceneRows: rasterizeRows(rows, 4), timelineRows: [], hydraRows: [] })
  engine.toggle() // epoch 0 → phase 0
  assert.equal(states.at(-1)!.ry, 0)
  time.advance(1000) // 2 beats at 0.5 s/beat → 1 s of source time
  time.frame()
  assert.equal(states.at(-1)!.ry, 1, 'ry follows the playback clock in seconds')
})

test('scene: content past the loop plays in later passes; short content resets every loop', () => {
  const viz = createSceneVisualizer(fakeScene())
  const at = (srcFrameF: number, loopFrames: number, pass = 0) =>
    viz.applyFrame({ srcFrameF, loopFrames, ctx: null, passAt: () => pass })[0]

  // px glides 0 → 20 across beats 1..21 (600 frames): a 16-beat loop
  // (480 frames) makes a two-loop, 32-beat sequence.
  viz.load({ sceneRows: rasterizeRows([
    sceneCreate(),
    { id: 's', event: 'update', beat: 21, px: 20 },
  ], 16), hydraRows: [] })
  assert.equal(at(240, 480, 0).px, 8, 'pass 0, beat 9')
  assert.equal(at(60, 480, 1).px, 18, 'pass 1 continues the glide (beat 19)')
  assert.equal(at(300, 480, 1).px, 20, 'past the last event the pose holds to the sequence end')
  assert.equal(at(240, 480, 2).px, 8, 'pass 2 wraps back to the beginning')

  // A last event on beat 13 fits the loop — it resets every 16 beats,
  // whatever the wall-aligned pass count says.
  viz.load({ sceneRows: rasterizeRows([
    sceneCreate(),
    { id: 's', event: 'update', beat: 13, px: 12 },
  ], 16), hydraRows: [] })
  assert.equal(at(300, 480, 7).px, 10, 'beat 11 of any loop')
})
