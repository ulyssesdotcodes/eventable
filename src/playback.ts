// Playback engine — all timing/loop/scrub state, zero DOM. The engine only
// tells each Visualizer which source frame to reconcile to; the transport view
// (ui/transport.tsx) is a humble renderer of PlaybackViewState.

import { buildTimeline, type Timeline } from './timeline.js'
import { activeLineage } from './lineage.js'
import type { EvalCtx } from './dsl.js'
import { FPS, FRAMES_PER_BEAT, DEFAULT_BEAT_SECONDS, DEFAULT_LOOP_BEATS, beatsToFrames } from './constants.js'
import type { Row } from './lineage.js'
import { contentPasses, type CookedVisualRows, type PassState, type Visualizer, type VisualizerKind } from './visualizer.js'
import { beatSecondsFromTaps } from './tap-log.js'

export interface TapControl {
  tap(): void
  clear(): void
  rows(): Row[]
  // Wall-clock epoch (ms) "beat 0" anchors to: the first tap once two taps
  // establish a tempo, else (main.ts wires this) the session's origin per
  // playbackOrigin below, else the Unix epoch (see wallAlignedPhase). Null
  // only for a caller with no origin fallback of its own.
  anchor?(): number | null
}

// Elapsed time since the anchor instant, wrapped into one loop. Anchoring to
// an absolute instant (not to when Play was pressed) keeps independently-
// started clients in phase purely from their own system clocks.
export function wallAlignedTick(nowMs: number, anchorMs: number, loopSeconds: number): number {
  if (loopSeconds <= 0) return 0
  let phase = ((nowMs - anchorMs) / 1000) % loopSeconds
  if (phase < 0) phase += loopSeconds
  return phase
}

// Which pass of the loop "now" falls in on the same wall-aligned grid.
// Multi-loop sequences place content by the DIFFERENCE between this value now
// and at the content's loop epoch, so a re-cook restarts a sequence at pass 0
// while the phase within the loop stays put.
export function wallAlignedLoop(nowMs: number, anchorMs: number, loopSeconds: number): number {
  if (loopSeconds <= 0) return 0
  return Math.floor((nowMs - anchorMs) / 1000 / loopSeconds)
}

export type PlayState = 'idle' | 'playing' | 'paused'

// Pushed to the transport view on every state change and animation frame; the
// view renders it verbatim — no playback decisions live on the DOM side.
export interface PlaybackViewState {
  state: PlayState
  // Playhead position, in elapsed beats.
  pos: number
  // Frozen at the drag position while scrubbing so the ticking engine doesn't
  // fight the drag.
  scrubPos: number
  maxBeats: number
  // Source beat at `pos` (timeline-mapped; equals pos+1 with no timeline).
  srcBeat: number
  timelineActive: boolean
  loop: boolean
  loopBeats: number
  // Tapped tempo in BPM, or null until two taps establish one.
  bpm: number | null
  // Each registered visualizer's current CONTENT pass (SOURCE space, after the
  // timeline warp — see visualizer.ts's passOffset). Keyed by kind; a kind with
  // no visualizer registered (tests) or particles (no Visualizer of its own —
  // its section reads srcBeat/timelinePass directly, unwrapped) has no entry.
  // A section's effective beat for kind K is
  // passes[K].pass * loopBeats + srcBeat.
  passes: Partial<Record<VisualizerKind, PassState>>
  // The engine's own TIMELINE pass, on the extended PLAYBACK axis, BEFORE the
  // warp: the shared pass count modulo timeline.loops when the timeline has
  // more than one pass, else 0. A different axis from each kind's own entry in
  // `passes`, though both wrap the same counter.
  timelinePass: number
}

export interface PlaybackOptions {
  // srcBeats is a 1-indexed beat — the unit every table's `beat` column uses.
  onTick?: (tick: number, active: Map<string, Set<number>>, srcBeats: number) => void
  onPlay?: () => void
  // Mirrors onPlay for a pause: fires on every transition into 'paused',
  // whether from a local toggle/pause() or a programmatic one (main.ts drives
  // the latter to mirror a peer's transport event — see pause() below).
  onPause?: () => void
  // Called each time the loop wraps.
  onLoop?: () => void
  tapControl?: TapControl
  // Resolves midi() bindings against the live MIDI table at the playhead's
  // *source* frame — the same coordinate events are recorded in.
  midiCtxAt?: (srcFrame: number) => EvalCtx | null
  // Same for slider() bindings; its ctx also carries sliders(), which each
  // hydra sketch reads as `props.sliders`.
  sliderCtxAt?: (srcFrame: number) => EvalCtx | null
  // Fired when setLoopBeats actually changes the loop length — main.ts records
  // it on the activity table so the count syncs and replays with the session.
  onLoopBeats?: (n: number) => void
  // Wall→musical shift: this module's own pausedMsBefore fold over the
  // activity events (main.ts wires it). Absent means never paused.
  pausedMsBefore?: (wallMs: number) => number
}

// Injectable clocks/scheduler so tests can drive timing deterministically.
export interface PlaybackClock {
  // Monotonic ms — the beat clock (performance.now).
  now?: () => number
  // Wall-clock epoch ms — the cross-client phase anchor (Date.now).
  epochNow?: () => number
  // Schedule the next animation frame (requestAnimationFrame).
  raf?: (cb: () => void) => void
}

export interface PlaybackEngineOptions extends PlaybackOptions {
  onViewChange?: (vs: PlaybackViewState) => void
  clock?: PlaybackClock
}

// Fold the activity event stream into the loop length: the newest
// 'set-loop-beats' event wins, null with none recorded. Riding the activity
// table gives the count sync, persistence, and scrub-replay for free.
export function loopBeatsFromEvents(events: Row[]): number | null {
  let out: number | null = null
  for (const e of events ?? []) {
    if (e.kind === 'set-loop-beats' && typeof e.beats === 'number' && e.beats >= 1) out = Math.round(e.beats)
  }
  return out
}

// Fold the activity event stream into the loop epoch — the instant every
// multi-pass sequence counts its passes from. ONE epoch for every kind on
// purpose: a per-kind epoch let two multi-pass tracks count from different
// origins and sit a pass apart forever.
//
// It moves only on an apply that DROPPED the pass the playhead was on — the
// cook it brought in spans fewer passes than that. An apply that still has
// that pass leaves it alone, so a run of edits keeps the piece playing instead
// of snapping back to pass 0 on every Apply; the first apply always anchors
// it, since a session has to start somewhere. Each apply carries the pass
// count it cooked (see programPasses) and its author's absolute clock, so
// every replica — late joiners included — folds the same epoch off the log.
// `passesBetween` is the engine's own wall-aligned pass distance.
export function loopEpochFromApplies(events: Row[], passesBetween: (fromMs: number, toMs: number) => number): number {
  let epoch = 0
  let span = 0
  for (const e of events ?? []) {
    if (e.kind !== 'apply' || typeof e.at !== 'number') continue
    // Legacy applies (recorded before the column) read as single-pass, which
    // keeps the fold on the session's first apply rather than guessing.
    const passes = typeof e.passes === 'number' && e.passes >= 1 ? Math.floor(e.passes) : 1
    if (span === 0 || passesBetween(epoch, e.at) % span >= passes) epoch = e.at
    span = passes
  }
  return epoch
}

// How many passes a cooked program spans at a loop length: its longest track's
// content, or the timeline's own pass axis. Recorded on every apply for the
// fold above.
export function programPasses(cooked: LoadedRows, loopBeats: number): number {
  return Math.max(
    contentPasses(cooked, beatsToFrames(loopBeats)),
    buildTimeline(cooked.timelineRows ?? [], loopBeats).loops,
  )
}

// --- Transport (play/pause) folds -------------------------------------------
// Play/pause ride the activity table (main.ts records/echo-guards them, same
// pattern as loopBeatsFromEvents above); these are the pure folds over that
// stream the engine and main.ts both need.

export type TransportState = 'playing' | 'paused'

interface TransportEvent { kind: 'playback-play' | 'playback-pause'; at: number }

// Valid playback-play/-pause events, sorted chronologically by `at`. An event
// with a missing/invalid `at` can't be placed on the wall-clock axis
// pausedMsBefore walks, so it's dropped rather than guessed at; the stable
// sort keeps encounter order on ties (simultaneous stamps from different
// authors), so the fold stays deterministic without a tie-break field.
function transportEvents(events: Row[]): TransportEvent[] {
  const out: TransportEvent[] = []
  for (const e of events ?? []) {
    if ((e.kind === 'playback-play' || e.kind === 'playback-pause') && typeof e.at === 'number' && Number.isFinite(e.at)) {
      out.push({ kind: e.kind, at: e.at })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

// The room's current transport state: the latest playback-play/-pause event
// by wall time, regardless of author — a peer's pause pauses the room just as
// well as the local user's. Null with nothing recorded (a solo session that
// has never touched play/pause, or a room mid-join): callers that need a
// default (drive the engine, decide whether to autoplay) treat null as
// playing; main.ts's echo guard deliberately does not, so a session's very
// first play still gets recorded rather than looking like a no-op echo.
export function transportStateFromEvents(events: Row[]): TransportState | null {
  const evs = transportEvents(events)
  if (!evs.length) return null
  return evs[evs.length - 1].kind === 'playback-pause' ? 'paused' : 'playing'
}

// Total ms the transport has spent paused before wall time `t` — a state
// machine over play/pause events sorted by `at`. A pause with no closing play
// at-or-before `t` is "open" and counts up to `t` itself, so a still-paused
// room keeps accumulating; a pause right at `t` itself has contributed zero
// (the instant of pausing, not yet any elapsed pause). The machine is
// idempotent on a repeated same-kind event (two authors racing to record the
// same transition), not just main.ts's recorder: a redundant pause/play is a
// no-op here too. A lone leading play (or no events at all) contributes zero.
export function pausedMsBefore(events: Row[], t: number): number {
  let paused = 0
  let pauseStart: number | null = null
  for (const e of transportEvents(events)) {
    if (e.at > t) break
    if (e.kind === 'playback-pause') pauseStart ??= e.at
    else if (pauseStart != null) { paused += e.at - pauseStart; pauseStart = null }
  }
  if (pauseStart != null) paused += t - pauseStart
  return paused
}

// The musical grid's origin (the wall-clock ms "beat 0" anchors to) absent a
// tap tempo: the earliest session-start on the activity table — the "first
// join" stand-in (worker/room.ts's peer-join carries no domain `at` field,
// only the event-log's internal `t` bookkeeping stamp, which is NOT a
// reliable wall clock: it's relative-to-log-start for a client's own events
// and absolute only for the server's, so nothing here reads it). Solo
// sessions record no session-start and fall back to the Unix epoch, exactly
// like today. Deliberately NOT a playback-play: the first *recorded* play is
// usually a resume (the open-page autoplay records nothing), and adopting it
// would retroactively move the anchor mid-session — the playhead would snap
// at the next loop wrap. An origin must predate all playback or not exist.
export function playbackOrigin(events: Row[], tapAnchorMs: number | null): number {
  if (tapAnchorMs != null) return tapAnchorMs
  let earliest: number | null = null
  for (const e of events ?? []) {
    if (e.kind === 'session-start' && typeof e.at === 'number' && Number.isFinite(e.at)) {
      if (earliest == null || e.at < earliest) earliest = e.at
    }
  }
  return earliest ?? 0
}

// What load() consumes — the timeline is the engine's own (it remaps time, it
// doesn't render). replay's CookedResult is structurally assignable.
export type LoadedRows = CookedVisualRows & {
  timelineRows: Row[]
  // The activity log the loop epoch is folded off (see loopEpochFromApplies);
  // absent leaves the epoch where it is.
  activity?: Row[]
}

export interface PlaybackAPI {
  load(cooked: LoadedRows): void
  // Re-anchor the beat clock after a tap-tempo change — content sits on a
  // fixed beat grid, so only the playhead's rate changes; nothing re-cooks.
  retempo(): void
  // The content/source position (a 1-indexed beat) currently on screen. Live
  // MIDI events are stamped here, so a recorded sweep's speed follows the
  // timeline mapping.
  currentSourceBeats(): number
  // No-op if already playing (or nothing loaded). Lands idle straight into
  // 'playing' (startFresh), same as toggle() from idle.
  play(): void
  // play()'s mirror: no-op if already paused (or nothing loaded). From idle
  // it lands frozen on the wall-aligned musical position rather than ticking
  // first — the shape a late joiner into an already-paused room needs (see
  // main.ts's bootRoom, which drives play()/pause() directly to mirror a
  // peer's transport state rather than going through the local toggle()).
  pause(): void
  // On PlaybackAPI (not just the engine) so main.ts can fold the loop length
  // back out of activity events.
  setLoopBeats(n: number): void
  // Re-render the frame already on screen, for a change that alters what it
  // draws without moving the playhead — the behind-editor preview, which must
  // land while paused too.
  refresh(): void
}

export interface PlaybackEngine extends PlaybackAPI {
  toggle(): void
  setLoop(on: boolean): void
  // Preview a drag position without committing the playhead; endScrub commits.
  scrub(pos: number): void
  endScrub(): void
  viewState(): PlaybackViewState
}

export function createPlaybackEngine(
  visualizers: Visualizer[],
  { onTick, onPlay, onPause, onLoop, tapControl, midiCtxAt, sliderCtxAt, onLoopBeats, onViewChange, clock, pausedMsBefore: pausedMsBeforeCb }: PlaybackEngineOptions = {},
): PlaybackEngine {
  const now = clock?.now ?? ((): number => performance.now())
  const epochNow = clock?.epochNow ?? ((): number => Date.now())
  const raf = clock?.raf ?? ((cb: () => void): void => { requestAnimationFrame(cb) })

  // Wall→musical: every wall instant the wall-aligned math touches goes through
  // this first (wallAlignedPhase/passesSince below), so a resume continues from
  // the paused musical moment instead of the paused span reappearing as a jump.
  const musical = (wallMs: number): number => wallMs - (pausedMsBeforeCb?.(wallMs) ?? 0)

  let state: PlayState = 'idle'
  // The playhead is measured in BEATS: live position is
  // ((now - startTime)/1000)/anchorBeatSec. Re-anchoring (play, tempo change,
  // loop wrap, scrub) is the only place the tapped tempo enters — between
  // anchors a loop runs at one steady tempo.
  let startTime: number | null = null
  let anchorBeatSec = DEFAULT_BEAT_SECONDS
  let pausedBeat = 0
  // The live timeline rows, kept so a loop-beats change can rebuild the warp:
  // a timeline's pass length is now the GUI loop-beats, not its own extent.
  let timelineRows: Row[] = []
  let timeline: Timeline = buildTimeline([])
  // Absolute instant ALL pass counting is based on (see loopEpochFromApplies).
  // The timeline warp and every visualizer count from this one instant, so
  // tracks spanning several passes are always on the same one. 0 (the Unix
  // epoch) until an apply anchors it.
  let loopEpoch = 0
  let maxBeats = 0 // loop length in beats
  let isScrubbing = false
  let scrubPos = 0
  let loop = true
  // The loop length for every visualizer — the GUI "beats" control. Content
  // whose beat runs past it forms later passes rather than stretching the
  // loop; only an active timeline overrides it.
  let loopBeats = DEFAULT_LOOP_BEATS
  // The position most recently shown to the view.
  let shownPos = 0

  // Seconds per beat, from the tapped tempo. The whole of how tempo enters
  // playback: it scales how fast the beat clock advances, never where content
  // sits on the (fixed) beat grid.
  function beatSeconds(): number {
    return beatSecondsFromTaps(tapControl?.rows()) ?? DEFAULT_BEAT_SECONDS
  }

  function tappedBpm(): number | null {
    const bs = beatSecondsFromTaps(tapControl?.rows())
    return bs == null ? null : 60 / bs
  }

  function viewState(): PlaybackViewState {
    const passes: Partial<Record<VisualizerKind, PassState>> = {}
    for (const v of visualizers) passes[v.kind] = v.currentPass()
    return {
      state,
      pos: shownPos,
      scrubPos: isScrubbing ? scrubPos : Math.min(shownPos, maxBeats),
      maxBeats,
      srcBeat: sourceBeatAt(shownPos),
      timelineActive: timeline.active,
      loop,
      loopBeats,
      bpm: tappedBpm(),
      passes,
      timelinePass: timelinePassNow(),
    }
  }

  function emit(pos: number = shownPos): void {
    shownPos = pos
    onViewChange?.(viewState())
  }

  // Which pass of the timeline (the extended PLAYBACK axis, before the warp)
  // is current. Timeline.sourceBeatAt re-derives the same modulo internally,
  // so passing this pre-modulo'd value through it is a no-op — computing it
  // once here is what lets viewState() surface it too.
  function timelinePassNow(): number {
    return timeline.loops > 1 ? passesSince(loopEpoch) % timeline.loops : 0
  }

  // Source beat shown at playhead beat `pos` (0-based elapsed beats): the
  // timeline remaps the 1-indexed playback beat to a 1-indexed source beat
  // (identity with no timeline); a multi-loop timeline also remaps by pass.
  function sourceBeatAt(pos: number): number {
    return timeline.sourceBeatAt(pos + 1, timelinePassNow())
  }

  function applyAt(pos: number): void {
    // Fractional cache frame: the playhead sweeps continuously — each
    // visualizer interpolates between cache frames however it needs to.
    const srcBeat = sourceBeatAt(pos)
    const srcFrameF = (srcBeat - 1) * FRAMES_PER_BEAT
    // midi()/slider() bindings resolve at the source frame — the same content
    // coordinate events are recorded in — so a recorded sweep tracks the
    // timeline and tempo rather than wall time.
    const srcFrame = Math.round(srcFrameF)
    const midiCtx = midiCtxAt ? midiCtxAt(srcFrame) : null
    const sliderCtx = sliderCtxAt ? sliderCtxAt(srcFrame) : null
    // Always present so time()/loop() bindings resolve even with no midi/slider
    // stream; the clock is the source position, so scrubbing scrubs it. loop()
    // counts whole passes since the playback origin (the activity log's
    // session-start, via tapControl.anchor) — passesSince from the origin is
    // that count, and it rides the same wall-aligned/pause-shifted grid as the
    // multi-loop pass math, so synced clients and replays agree. Fixed for the
    // frame, so it's computed once here rather than per binding.
    const loopNow = passesSince(tapControl?.anchor?.() ?? 0)
    const ctx: EvalCtx = { ...midiCtx, ...sliderCtx, time: () => srcFrameF / FPS, loop: () => loopNow }
    const states: Row[] = []
    const loopFrames = beatsToFrames(loopBeats)
    const bpm = tappedBpm() ?? 60 / DEFAULT_BEAT_SECONDS
    // Counted ONCE for the whole frame: every kind wraps this same number by
    // its own pass count, so no two multi-pass tracks can disagree about which
    // pass it is.
    const pass = passesSince(loopEpoch)
    for (const v of visualizers) states.push(...v.applyFrame({ srcFrameF, loopFrames, ctx, pass, bpm }))
    // Graphed/table views key their rows by `beat`, so report the source beat.
    onTick?.(pos, activeLineage(states), srcBeat)
  }

  // Any one visualizer with content is enough — a program can be hydra-only.
  function hasContent(): boolean {
    return visualizers.some((v) => v.hasContent())
  }

  function reset(pos: number = 0): void {
    for (const v of visualizers) v.clear()
    emit(pos)
    if (hasContent()) applyAt(pos)
  }

  function currentTime(): number {
    return state === 'playing' ? position() : pausedBeat
  }

  // Wall-aligned beat phase right now, or null with nothing to loop over.
  // Anchored to an absolute instant (first tap, else the Unix epoch) so any
  // two clients land on the same phase purely from their own system clocks.
  function wallAlignedPhase(): number | null {
    const anchorMs = musical(tapControl?.anchor?.() ?? 0)
    const bs = beatSeconds()
    if (maxBeats <= 0) return null
    return wallAlignedTick(musical(epochNow()), anchorMs, maxBeats * bs) / bs
  }

  // Whole wall-aligned loops between two instants, with no per-wrap counter, so
  // every clock-synced client agrees. The time half of multi-loop playback; the
  // content half lives in each visualizer, which wraps the count by its own
  // pass total.
  function passesBetween(fromMs: number, toMs: number): number {
    const anchorMs = musical(tapControl?.anchor?.() ?? 0)
    const loopSec = maxBeats * beatSeconds()
    return Math.max(0, wallAlignedLoop(musical(toMs), anchorMs, loopSec) - wallAlignedLoop(musical(fromMs), anchorMs, loopSec))
  }

  // Which pass of a multi-loop sequence to show right now.
  function passesSince(epochMs: number): number {
    return passesBetween(epochMs, epochNow())
  }

  // The 1-indexed source beat on screen — wrapped and timeline-mapped exactly
  // as applyAt computes it. Live MIDI events are stamped here: recording this
  // shared content coordinate (not wall time) is what makes a recorded sweep
  // follow the timeline and tempo along with everything else on screen.
  function currentSourceBeats(): number {
    let pos = currentTime()
    if (loop && maxBeats > 0 && pos >= maxBeats) pos %= maxBeats
    return sourceBeatAt(pos)
  }

  // Loop length: the timeline's span when one is active, else the loop-length
  // control.
  function recomputeMax(): void {
    if (timeline.active) maxBeats = timeline.beats
    else maxBeats = hasContent() ? loopBeats : 0
  }

  // Anchor the beat clock so the live position reads `pos` beats right now —
  // the one place the tapped tempo is folded into the clock.
  function anchor(pos: number): void {
    anchorBeatSec = beatSeconds()
    startTime = now() - pos * anchorBeatSec * 1000
  }

  // Re-anchor clock + view to beat `pos` (clamped), keeping the play state, so
  // a re-cook or tempo change resumes in place rather than rewinding. applyAt
  // diffs the scene, so swapping caches updates objects in place.
  function retimeTo(pos: number): void {
    const top = maxBeats || 0
    pos = Math.min(Math.max(0, pos), top)
    pausedBeat = Math.min(pausedBeat, top)
    if (state === 'playing') anchor(pos)
    emit(pos)
    if (hasContent()) {
      applyAt(pos)
    } else {
      for (const v of visualizers) v.blank()
    }
  }

  // Swap in a freshly cooked cache without moving the playhead. The loop epoch
  // is re-folded off the activity log — it only moves for an apply that dropped
  // the pass being played, so an ordinary edit leaves the sequences running.
  // recomputeMax first: the fold measures in loops of maxBeats.
  function load(cooked: LoadedRows): void {
    for (const v of visualizers) v.load(cooked)
    timelineRows = cooked.timelineRows ?? []
    timeline = buildTimeline(timelineRows, loopBeats)
    recomputeMax()
    if (cooked.activity) loopEpoch = loopEpochFromApplies(cooked.activity, passesBetween)
    retimeTo(currentTime())
  }

  // Tap tempo changed. Content placement is tempo-independent, so nothing
  // re-cooks — just re-anchor the beat clock (snapping to the wall-aligned
  // phase while playing) and refresh the loop length.
  function retempo(): void {
    recomputeMax()
    const aligned = state === 'playing' ? wallAlignedPhase() : null
    retimeTo(aligned ?? currentTime())
  }

  function scrub(pos: number): void {
    isScrubbing = true
    scrubPos = pos
    if (hasContent()) applyAt(pos)
    emit(pos)
  }

  function endScrub(): void {
    if (!isScrubbing) return
    isScrubbing = false
    pausedBeat = scrubPos
    if (state === 'playing') anchor(scrubPos)
    emit()
  }

  function setLoop(on: boolean): void {
    loop = on
    emit()
  }

  function setLoopBeats(n: number): void {
    n = Math.max(1, Math.round(n || DEFAULT_LOOP_BEATS))
    if (n === loopBeats) {
      emit() // still refresh the view so a rejected/clamped input snaps back
      return
    }
    loopBeats = n
    onLoopBeats?.(n)
    // The pass length feeds the timeline warp, so a new loop length rebuilds it.
    timeline = buildTimeline(timelineRows, loopBeats)
    recomputeMax()
    retimeTo(currentTime())
  }

  function toggle(): void {
    if (!hasContent()) return
    if (state === 'playing') pauseNow()
    else if (state === 'paused') resume()
    else startFresh()
  }

  // Resume ticking from pausedBeat — toggle()'s paused→playing branch, shared
  // with the public play().
  function resume(): void {
    state = 'playing'
    anchor(pausedBeat)
    emit()
    onPlay?.()
    tick()
  }

  // Freeze at the live position — toggle()'s playing→paused branch, shared
  // with the public pause().
  function pauseNow(): void {
    state = 'paused'
    pausedBeat = position()
    emit()
    onPause?.()
  }

  function startFresh(): void {
    // Join the wall-aligned beat grid wherever it currently is, rather than
    // resetting "beat 0" to this moment. Loop epochs are deliberately NOT
    // touched: a client hitting Play mid-jam lands on the same pass of a
    // multi-loop sequence as everyone else.
    const aligned = wallAlignedPhase() ?? 0
    reset(aligned)
    pausedBeat = aligned
    anchor(aligned)
    state = 'playing'
    emit()
    onPlay?.()
    tick()
  }

  // startFresh's frozen counterpart: join the wall-aligned grid but land
  // straight in 'paused' rather than ticking — for a client whose very first
  // frame should already show paused (a late joiner into a paused room; see
  // pause() below). The pause-shifted wallAlignedPhase is what makes this
  // agree with wherever the room that paused it is frozen.
  function pauseFresh(): void {
    const aligned = wallAlignedPhase() ?? 0
    reset(aligned)
    pausedBeat = aligned
    state = 'paused'
    emit()
    onPause?.()
  }

  function position(): number {
    return (now() - (startTime ?? 0)) / 1000 / anchorBeatSec
  }

  function tick(): void {
    if (state !== 'playing') return

    let pos = position()

    // On wrap, re-derive the wall-aligned phase (rather than `pos %= maxBeats`)
    // so a tap tempo stays locked to the real-world clock — self-correcting
    // drift and keeping independently-started clients in phase.
    if (loop && maxBeats > 0 && pos >= maxBeats) {
      pos = wallAlignedPhase() ?? (pos % maxBeats)
      anchor(pos)
      onLoop?.()
    }

    emit(pos)
    applyAt(pos)

    if (!loop && pos >= maxBeats) {
      state = 'idle'
      pausedBeat = maxBeats // so a re-cook keeps the playhead at the end
      emit(maxBeats)
      return
    }

    raf(tick)
  }

  function play(): void {
    if (!hasContent() || state === 'playing') return
    if (state === 'paused') resume()
    else startFresh()
  }

  function pause(): void {
    if (!hasContent() || state === 'paused') return
    if (state === 'playing') pauseNow()
    else pauseFresh()
  }

  return {
    load,
    retempo,
    refresh(): void {
      if (hasContent()) applyAt(shownPos)
    },
    currentSourceBeats,
    play,
    pause,
    toggle,
    setLoop,
    setLoopBeats,
    scrub,
    endScrub,
    viewState,
  }
}
