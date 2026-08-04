// Visualizer — the one interface between the playback engine (which owns time)
// and anything that renders content. The engine never learns what a visualizer
// draws; adding one is: add its rows to replay.ts's CookedResult, implement
// this interface (usually a pure index module + a thin GPU/DOM API, like
// hydra.ts + hydra-scene.ts — keep that split), register it in main.ts.
// Origami renders through the scene visualizer, not a separate one.

import { buildFrameIndex, sampleFrame, type FrameStore } from './rasterize.js'
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

// The row sets a cooked program feeds the visualizers — a structurally
// assignable subset of replay.ts's CookedResult, so the engine forwards the
// whole object without knowing the names.
export interface CookedVisualRows {
  scene: FrameStore
  hydraRows: Row[]
  // Optional so pre-bauble/pre-post callers (and their test fixtures) stay
  // assignable.
  baubleRows?: Row[]
  postRows?: Row[]
}

// A kind's current loop-pass mechanics: how many passes its content spans and
// which one is showing. {pass:0, loops:1} before any frame is applied.
export interface PassState {
  pass: number
  loops: number
}

// The kinds that have a Visualizer of their own. ('timeline' has passes too,
// but they are playback.ts's own axis, not a visualizer's — see passOffset.)
export type VisualizerKind = 'scene' | 'hydra' | 'bauble' | 'post'

// Pure per-kind pass arithmetic, shared by every multi-loop visualizer:
// content whose beat count runs past one loop (`max` frames long against a
// `loopFrames`-long loop) forms later passes. `pass` is the engine's ONE
// wall-aligned pass count since the last apply, which every kind wraps by its
// own length — that shared counter is what keeps two multi-pass tracks on a
// common pass 0 instead of drifting a pass apart. This is the CONTENT pass —
// computed in SOURCE space, after playback.ts has already picked the source
// beat through any timeline warp. It is a different axis from playback.ts's
// own TIMELINE pass (playback space, before the warp — see
// PlaybackViewState.timelinePass); conflating the two mis-places content
// under an active timeline.
export function passOffset(max: number, loopFrames: number, pass: number): PassState & { offset: number } {
  const loops = loopFrames > 0 ? Math.floor(max / loopFrames) + 1 : 1
  const wrapped = loops > 1 ? pass % loops : 0
  return { pass: wrapped, loops, offset: wrapped * loopFrames }
}

// The last frame an index reaches — how far into the loop a track's content
// runs, and so (via passOffset) how many passes it spans.
const indexMax = (rows: Row[]): number => rows.reduce((m, r) => Math.max(m, r.index as number), 0)

// How many passes a cooked program spans at this loop length: its longest
// track's. An apply records it (see playback.ts's programPasses), which is what
// lets the loop-epoch fold tell whether a re-cook still HAS the pass the
// playhead is on — the only thing that restarts the sequences.
export function contentPasses(cooked: CookedVisualRows, loopFrames: number): number {
  const spans = [
    cooked.scene?.maxFrame ?? 0,
    indexMax(buildHydraIndex(cooked.hydraRows ?? [])),
    indexMax(buildBaubleIndex(cooked.baubleRows ?? [])),
    indexMax(buildPostIndex(cooked.postRows ?? [])),
  ]
  return spans.reduce((m, max) => Math.max(m, passOffset(max, loopFrames, 0).loops), 1)
}

export interface VisualizerFrame {
  // Fractional source frame — the playhead sweeps continuously between frames.
  srcFrameF: number
  // The loop length in frames — the GUI beat count, supplied by the engine.
  // Content whose beat runs past this span forms later passes of the loop.
  loopFrames: number
  // Streaming context midi() bindings resolve against; null when no stream.
  ctx: EvalCtx | null
  // Wall-aligned loops completed since the program was last applied — supplied
  // by the engine, which owns time. A multi-pass visualizer shows this modulo
  // its own pass count; every kind gets the same number in a frame.
  pass: number
  // Beats per minute from the playback clock (tapped tempo, else the default).
  // Optional so pre-existing callers/fixtures stay assignable; the post
  // visualizer exposes it to chains as `props.bpm`.
  bpm?: number
}

export interface Visualizer {
  // Which kind this is — how the engine keys PlaybackViewState.passes.
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
  let current: PassState = { pass: 0, loops: 1 }

  function clear(): void {
    sceneAPI.reset()
    alive = new Set()
  }

  return {
    kind: 'scene',
    load(cooked): void {
      frameIndex = cooked.scene ?? buildFrameIndex([])
    },
    hasContent: () => frameIndex.objects.length > 0,
    applyFrame({ srcFrameF, loopFrames, ctx, pass }): Row[] {
      // Frames land on the loop, so a last event on beat 21 of a 16-beat loop
      // makes a 32-beat sequence (beat 13, a plain 16-beat one). The clamp
      // holds the final pose through the last pass's tail rather than
      // blanking mid-pass.
      const { offset, ...p } = passOffset(frameIndex.maxFrame, loopFrames, pass)
      current = p
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
    currentPass: () => current,
  }
}

// The behind-editor preview. `code` is the open hydra/post cell's applied
// sketch, folded back into the program in place by main.ts (null when no such
// cell is open); the scene API draws it against this frame's variables and
// clock. Both the fold and the preview's own GPU compile can throw, and
// neither may escape applyFrame — an uncaught throw there kills the render loop
// and takes the page with it — so they go to `onError` instead.
export interface PreviewHook {
  code(): string | null
  onError(err: unknown): void
}

function drawPreview(preview: PreviewHook | undefined, set: (code: string | null) => void): void {
  if (!preview) return
  try {
    set(preview.code())
  } catch (err) {
    preview.onError(err)
  }
}

// The hydra layer: the sampled sketch is absolute (setSketch replaces the
// whole program), so there is no reconciliation state to clear. tick() drives
// hydra's clock from the source position, so scrubbing scrubs the sketch.
// The post visualizer takes the same preview hook.
export function createHydraVisualizer(hydraAPI: HydraAPI, preview?: PreviewHook): Visualizer {
  let index: Row[] = buildHydraIndex([])
  let maxIndex = 0
  let current: PassState = { pass: 0, loops: 1 }

  return {
    kind: 'hydra',
    load(cooked): void {
      index = buildHydraIndex(cooked.hydraRows ?? [])
      maxIndex = indexMax(index)
    },
    hasContent: () => index.length > 0,
    applyFrame({ srcFrameF, loopFrames, ctx, pass }): Row[] {
      // floor: an event at exactly beat loopBeats+1 opens a new pass — that's
      // how a later pass is authored. The absolute frame also drives the
      // clock, so transitions animate across passes.
      const { offset, ...p } = passOffset(maxIndex, loopFrames, pass)
      current = p
      const frameF = offset + srcFrameF
      const sketch = hydraFrameAt(index, Math.floor(frameF), loopFrames)
      // Resolve midi/slider bindings, then expose every slider's value as
      // `props.sliders` (an explicit user variable named "sliders" still wins).
      // $midi lets expr.midi() dynamic args sample the playhead's MIDI
      // ($-prefix reserved, like $expr); loop is the expr.loop() counter,
      // merged after the user vars (like hydra's own clock fields) so a
      // same-named variable can't hide it.
      const withCtx = (base: Record<string, unknown>): Record<string, unknown> => {
        if (!ctx) return base
        const vars = resolveBindings(base, ctx)
        const sliders = ctx.sliders?.()
        const midi = ctx.midi ? { $midi: ctx.midi } : {}
        const loop = ctx.loop ? { loop: ctx.loop() } : {}
        return { ...(sliders ? { sliders } : {}), ...midi, ...vars, ...loop }
      }
      const vars = withCtx(sketch?.vars ?? {})
      hydraAPI.setSketch(sketch ? { ...sketch, vars } : null)
      hydraAPI.tick(frameF / FPS)
      drawPreview(preview, (code) => hydraAPI.setPreview(code, vars))
      return []
    },
    clear(): void {
      // setSketch is absolute — resetting here would force a visible sketch
      // recompile on every fresh play.
    },
    blank(): void {
      hydraAPI.reset()
    },
    currentPass: () => current,
  }
}

// The bauble layer: like hydra, setSketch is absolute and the same recompile
// economics apply, so clear() must not reset.
export function createBaubleVisualizer(baubleAPI: BaubleAPI): Visualizer {
  let index: Row[] = buildBaubleIndex([])
  let maxIndex = 0
  let current: PassState = { pass: 0, loops: 1 }

  return {
    kind: 'bauble',
    load(cooked): void {
      index = buildBaubleIndex(cooked.baubleRows ?? [])
      maxIndex = indexMax(index)
    },
    hasContent: () => index.length > 0,
    applyFrame({ srcFrameF, loopFrames, ctx, pass }): Row[] {
      // Pass derivation mirrors the hydra visualizer's; the absolute frame
      // also drives `t`, keeping (ss t …) transition windows on one clock.
      const { offset, ...p } = passOffset(maxIndex, loopFrames, pass)
      current = p
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
    currentPass: () => current,
  }
}

// The post layer: like hydra, folding is absolute and compilation happens up
// front (setProgram enumerates + warm-compiles every state on the first apply,
// once loopFrames is known), so clear() must not tear it down. applyFrame folds
// to a precompiled state and writes the frame's live-uniform values;
// three-scene's animate loop drives the actual render.
export function createPostVisualizer(postAPI: PostAPI, preview?: PreviewHook): Visualizer {
  let index: Row[] = buildPostIndex([])
  let maxIndex = 0
  let current: PassState = { pass: 0, loops: 1 }
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
      maxIndex = indexMax(index)
      programmedLoop = null
    },
    hasContent: () => index.length > 0,
    applyFrame({ srcFrameF, loopFrames, ctx, pass, bpm }): Row[] {
      if (programmedLoop !== loopFrames) {
        postAPI.setProgram(index, loopFrames)
        programmedLoop = loopFrames
      }
      const { offset, ...p } = passOffset(maxIndex, loopFrames, pass)
      current = p
      const frameF = offset + srcFrameF
      const frame = postFrameAt(index, Math.floor(frameF), loopFrames)
      // Live-arg functions read the props object: the folded variables (with
      // midi/slider bindings resolved), every slider under `p.sliders`, and
      // the playback clock (time/beat/bpm) merged LAST so they can't be
      // shadowed — the only clock a chain sees, which keeps post deterministic
      // under pause/scrub.
      const vars = frame ? (ctx ? resolveBindings(frame.vars, ctx) : frame.vars) : {}
      const sliders = ctx?.sliders?.()
      const clock = { time: frameF / FPS, beat: frameToBeat(frameF), bpm: bpm ?? 60 / DEFAULT_BEAT_SECONDS, loop: ctx?.loop ? ctx.loop() : 0 }
      // $midi lets expr.midi() live args sample the playhead's MIDI ($-prefix
      // reserved, like $expr — a user var can't collide).
      const midi = ctx?.midi ? { $midi: ctx.midi } : {}
      const props = { ...(sliders ? { sliders } : {}), ...midi, ...vars, ...clock }
      postAPI.setFrame(frame, props)
      drawPreview(preview, (code) => postAPI.setPreview(code, props))
      return []
    },
    clear(): void {
      // setProgram is absolute — see the hydra visualizer's clear().
    },
    blank(): void {
      postAPI.reset()
    },
    currentPass: () => current,
  }
}
