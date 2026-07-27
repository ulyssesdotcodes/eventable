// Visualizer — the one interface between the playback engine (which owns time)
// and anything that renders content. The engine never learns what a visualizer
// draws; adding one is: add its rows to replay.ts's CookedResult, implement
// this interface (usually a pure index module + a thin GPU/DOM API, like
// hydra.ts + hydra-scene.ts — keep that split), register it in main.ts.
// Origami renders through the scene visualizer, not a separate one.

import { buildFrameIndex, sampleFrame } from './rasterize.js'
import { buildHydraIndex, hydraFrameAt } from './hydra.js'
import { buildBaubleIndex, baubleFrameAt } from './bauble.js'
import { buildPostIndex, postFrameAt } from './post.js'
import { resolveBindings, type EvalCtx } from './dsl.js'
import { FPS, DEFAULT_BEAT_SECONDS, frameToBeat } from './constants.js'
import type { Row } from './lineage.js'
import type { SceneAPI } from './three-scene.js'
import type { HydraAPI } from './hydra-scene.js'
import type { BaubleAPI } from './bauble-scene.js'
import type { PostAPI } from './post-scene.js'

// Wall-clock instants (ms) each kind's multi-loop sequence counts passes from
// — the `at` stamp of the newest apply that changed it. Shared by every
// replica in a room, which is what puts them all on the same pass.
export const LOOP_KINDS = ['scene', 'timeline', 'hydra', 'bauble', 'post'] as const
export type LoopEpochs = Partial<Record<(typeof LOOP_KINDS)[number], number>>

// The row sets a cooked program feeds the visualizers — a structurally
// assignable subset of replay.ts's CookedResult, so the engine forwards the
// whole object without knowing the names.
export interface CookedVisualRows {
  sceneRows: Row[]
  hydraRows: Row[]
  // Optional so pre-bauble/pre-post callers (and their test fixtures) stay
  // assignable.
  baubleRows?: Row[]
  postRows?: Row[]
  loopEpochs?: LoopEpochs
}

// A kind's current loop-pass mechanics: how many passes its content spans and
// which one is showing. {pass:0, loops:1} before any frame is applied.
export interface PassState {
  pass: number
  loops: number
}

// The four kinds that actually have a Visualizer (LOOP_KINDS minus
// 'timeline', which is playback.ts's own pass axis, not a visualizer's — see
// passOffset below).
export type VisualizerKind = Exclude<(typeof LOOP_KINDS)[number], 'timeline'>

// Pure per-kind pass arithmetic, shared by every multi-loop visualizer:
// content whose beat count runs past one loop (`max` frames long against a
// `loopFrames`-long loop) forms later passes, wall-aligned via `passAt` so
// every replica reaches the same one from its own clock. This is the CONTENT
// pass — computed in SOURCE space, after playback.ts has already picked the
// source beat through any timeline warp. It is a different axis from
// playback.ts's own TIMELINE pass (playback space, before the warp — see
// PlaybackViewState.timelinePass); conflating the two mis-places content
// under an active timeline (see risk R1 in the rewrite notes).
export function passOffset(max: number, loopFrames: number, passAt: (epochMs: number) => number, epoch: number): PassState & { offset: number } {
  const loops = loopFrames > 0 ? Math.floor(max / loopFrames) + 1 : 1
  const pass = loops > 1 ? passAt(epoch) % loops : 0
  return { pass, loops, offset: pass * loopFrames }
}

export interface VisualizerFrame {
  // Fractional source frame — the playhead sweeps continuously between frames.
  srcFrameF: number
  // The loop length in frames — the GUI beat count, supplied by the engine.
  // Content whose beat runs past this span forms later passes of the loop.
  loopFrames: number
  // Streaming context midi() bindings resolve against; null when no stream.
  ctx: EvalCtx | null
  // Wall-aligned loops completed since an absolute instant (ms) — supplied by
  // the engine, which owns time. A multi-pass visualizer shows passAt(its loop
  // epoch) modulo its own pass count.
  passAt: (epochMs: number) => number
  // Beats per minute from the playback clock (tapped tempo, else the default).
  // Optional so pre-existing callers/fixtures stay assignable; the post
  // visualizer exposes it to chains as `props.bpm`.
  bpm?: number
}

export interface Visualizer {
  // Which LOOP_KINDS entry this is — how the engine keys PlaybackViewState.passes.
  readonly kind: VisualizerKind
  // Swap in freshly cooked rows. Reconciliation state survives on purpose: a
  // re-cook updates what's on screen in place rather than tearing it down.
  load(cooked: CookedVisualRows): void
  hasContent(): boolean
  // Reconcile the display to this frame. Returns the rows "on screen" there —
  // the engine folds them into the lineage highlight.
  applyFrame(frame: VisualizerFrame): Row[]
  // Drop reconciliation state so the next applyFrame starts from scratch.
  // Must NOT blank a display applyFrame is about to repaint — see blank().
  clear(): void
  // Nothing to show at all: clear and blank the display.
  blank(): void
  // This kind's pass/loops as of the last applyFrame — what the engine
  // surfaces per-kind on PlaybackViewState.passes for timeline sections.
  currentPass(): PassState
}

// The Three.js scene: baked scene rows sampled per frame, diffed against the
// set of live objects so playback only creates/destroys what changed.
export function createSceneVisualizer(sceneAPI: SceneAPI): Visualizer {
  let frameIndex = buildFrameIndex([])
  let alive = new Set<unknown>()
  // 0 (the Unix epoch) until stamped — the same arbitrary-but-shared reference
  // the no-tap phase anchor uses.
  let epoch = 0
  let pass: PassState = { pass: 0, loops: 1 }

  function clear(): void {
    sceneAPI.reset()
    alive = new Set()
  }

  return {
    kind: 'scene',
    load(cooked): void {
      frameIndex = buildFrameIndex(cooked.sceneRows ?? [])
      if (typeof cooked.loopEpochs?.scene === 'number') epoch = cooked.loopEpochs.scene
    },
    hasContent: () => frameIndex.map.size > 0,
    applyFrame({ srcFrameF, loopFrames, ctx, passAt }): Row[] {
      // Frames land on the loop, so a last event on beat 21 of a 16-beat loop
      // makes a 32-beat sequence (beat 13, a plain 16-beat one). The clamp
      // holds the final pose through the last pass's tail rather than
      // blanking mid-pass.
      const { offset, ...p } = passOffset(frameIndex.maxFrame, loopFrames, passAt, epoch)
      pass = p
      const frameF = Math.min(offset + srcFrameF, frameIndex.maxFrame)
      const baked = sampleFrame(frameIndex, frameF)
      const states = ctx ? baked.map((s) => resolveBindings(s, ctx)) : baked
      const present = new Set<unknown>()
      for (const s of states) {
        present.add(s.id)
        if (!alive.has(s.id)) {
          sceneAPI.createObject(s as Record<string, unknown>)
          alive.add(s.id)
        } else {
          sceneAPI.updateObject(s as Record<string, unknown>)
        }
      }
      for (const id of alive) {
        if (!present.has(id)) {
          sceneAPI.destroyObject(id)
          alive.delete(id)
        }
      }
      return states
    },
    clear,
    blank: clear,
    currentPass: () => pass,
  }
}

// The hydra layer: the sampled sketch is absolute (setSketch replaces the
// whole program), so there is no reconciliation state to clear. tick() drives
// hydra's clock from the source position, so scrubbing scrubs the sketch.
export function createHydraVisualizer(hydraAPI: HydraAPI): Visualizer {
  let index: Row[] = buildHydraIndex([])
  let maxIndex = 0
  let epoch = 0
  let pass: PassState = { pass: 0, loops: 1 }

  return {
    kind: 'hydra',
    load(cooked): void {
      index = buildHydraIndex(cooked.hydraRows ?? [])
      maxIndex = index.reduce((m, r) => Math.max(m, r.index as number), 0)
      if (typeof cooked.loopEpochs?.hydra === 'number') epoch = cooked.loopEpochs.hydra
    },
    hasContent: () => index.length > 0,
    applyFrame({ srcFrameF, loopFrames, ctx, passAt }): Row[] {
      // floor: an event at exactly beat loopBeats+1 opens a new pass — that's
      // how a later pass is authored. The absolute frame also drives the
      // clock, so transitions animate across passes.
      const { offset, ...p } = passOffset(maxIndex, loopFrames, passAt, epoch)
      pass = p
      const frameF = offset + srcFrameF
      const sketch = hydraFrameAt(index, Math.floor(frameF), loopFrames)
      // Resolve midi/slider bindings, then expose every slider's value as
      // `props.sliders` (an explicit user variable named "sliders" still wins).
      if (sketch) {
        const vars = ctx ? resolveBindings(sketch.vars, ctx) : sketch.vars
        const sliders = ctx?.sliders?.()
        // $midi lets expr.midi() dynamic args sample the playhead's MIDI
        // ($-prefix reserved, like $expr); loop is the expr.loop() counter,
        // merged after the user vars (like hydra's own clock fields) so a
        // same-named variable can't hide it.
        const midi = ctx?.midi ? { $midi: ctx.midi } : {}
        const loop = ctx?.loop ? { loop: ctx.loop() } : {}
        hydraAPI.setSketch(ctx ? { ...sketch, vars: { ...(sliders ? { sliders } : {}), ...midi, ...vars, ...loop } } : sketch)
      } else {
        hydraAPI.setSketch(sketch)
      }
      hydraAPI.tick(frameF / FPS)
      return []
    },
    clear(): void {
      // setSketch is absolute — resetting here would force a visible sketch
      // recompile on every fresh play.
    },
    blank(): void {
      hydraAPI.reset()
    },
    currentPass: () => pass,
  }
}

// The bauble layer: like hydra, setSketch is absolute and the same recompile
// economics apply, so clear() must not reset.
export function createBaubleVisualizer(baubleAPI: BaubleAPI): Visualizer {
  let index: Row[] = buildBaubleIndex([])
  let maxIndex = 0
  let epoch = 0
  let pass: PassState = { pass: 0, loops: 1 }

  return {
    kind: 'bauble',
    load(cooked): void {
      index = buildBaubleIndex(cooked.baubleRows ?? [])
      maxIndex = index.reduce((m, r) => Math.max(m, r.index as number), 0)
      if (typeof cooked.loopEpochs?.bauble === 'number') epoch = cooked.loopEpochs.bauble
    },
    hasContent: () => index.length > 0,
    applyFrame({ srcFrameF, loopFrames, ctx, passAt }): Row[] {
      // Pass derivation mirrors the hydra visualizer's; the absolute frame
      // also drives `t`, keeping (ss t …) transition windows on one clock.
      const { offset, ...p } = passOffset(maxIndex, loopFrames, passAt, epoch)
      pass = p
      const frameF = offset + srcFrameF
      const sketch = baubleFrameAt(index, Math.floor(frameF), loopFrames)
      // NB: unlike hydra there is no props escape hatch — a resolved variable
      // bakes into the compiled script, so a binding that sweeps every frame
      // recompiles every frame; bind sweeping inputs to the camera vars.
      baubleAPI.setSketch(sketch && ctx ? { ...sketch, vars: resolveBindings(sketch.vars, ctx) } : sketch)
      baubleAPI.tick(frameF / FPS)
      return []
    },
    clear(): void {
      // setSketch is absolute — see the hydra visualizer's clear().
    },
    blank(): void {
      baubleAPI.reset()
    },
    currentPass: () => pass,
  }
}

// The post layer: like hydra, folding is absolute and compilation happens up
// front (setProgram enumerates + warm-compiles every state on the first apply,
// once loopFrames is known), so clear() must not tear it down. applyFrame folds
// to a precompiled state and writes the frame's live-uniform values;
// three-scene's animate loop drives the actual render.
export function createPostVisualizer(postAPI: PostAPI): Visualizer {
  let index: Row[] = buildPostIndex([])
  let maxIndex = 0
  let epoch = 0
  let pass: PassState = { pass: 0, loops: 1 }
  // The loopFrames setProgram last precompiled against (null = re-program next
  // frame). setProgram enumerates loopFrames-dependent states (wrapped
  // transition windows), but load doesn't carry loopFrames — and setLoopBeats
  // changes it with no re-cook — so warm-compile on the first apply the length
  // is known and whenever it changes, keeping the compile in the cook pause.
  let programmedLoop: number | null = null

  return {
    kind: 'post',
    load(cooked): void {
      index = buildPostIndex(cooked.postRows ?? [])
      maxIndex = index.reduce((m, r) => Math.max(m, r.index as number), 0)
      if (typeof cooked.loopEpochs?.post === 'number') epoch = cooked.loopEpochs.post
      programmedLoop = null
    },
    hasContent: () => index.length > 0,
    applyFrame({ srcFrameF, loopFrames, ctx, passAt, bpm }): Row[] {
      if (programmedLoop !== loopFrames) {
        postAPI.setProgram(index, loopFrames)
        programmedLoop = loopFrames
      }
      const { offset, ...p } = passOffset(maxIndex, loopFrames, passAt, epoch)
      pass = p
      const frameF = offset + srcFrameF
      const frame = postFrameAt(index, Math.floor(frameF), loopFrames)
      if (frame) {
        // Live-arg functions read the props object: the folded variables (with
        // midi/slider bindings resolved), every slider under `p.sliders`, and
        // the playback clock (time/beat/bpm) merged LAST so they can't be
        // shadowed — the only clock a chain sees, which keeps post deterministic
        // under pause/scrub.
        const vars = ctx ? resolveBindings(frame.vars, ctx) : frame.vars
        const sliders = ctx?.sliders?.()
        const clock = { time: frameF / FPS, beat: frameToBeat(frameF), bpm: bpm ?? 60 / DEFAULT_BEAT_SECONDS, loop: ctx?.loop ? ctx.loop() : 0 }
        // $midi lets expr.midi() live args sample the playhead's MIDI ($-prefix
        // reserved, like $expr — a user var can't collide).
        const midi = ctx?.midi ? { $midi: ctx.midi } : {}
        postAPI.setFrame(frame, { ...(sliders ? { sliders } : {}), ...midi, ...vars, ...clock })
      } else {
        postAPI.setFrame(null, {})
      }
      return []
    },
    clear(): void {
      // setProgram is absolute — see the hydra visualizer's clear().
    },
    blank(): void {
      postAPI.reset()
    },
    currentPass: () => pass,
  }
}
