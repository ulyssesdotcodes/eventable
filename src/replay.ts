// Cook a program (code + seed) into the rows the scene/timeline/hydra/bauble
// panels consume — the one cook helper shared by a live Run and a scrubbed
// session replay, so replay treats the "code" table like any other editable
// table folded to the run's index.

import { buildFrameIndex, type FrameStore } from './rasterize.js'
import { hydraRows } from './hydra.js'
import { baubleRows } from './bauble.js'
import { postRows, buildPostIndex, postStateFrames, postFrameAt } from './post.js'
import { outViewName, type GraphSpec, type Table } from './dsl.js'
import type { Row } from './lineage.js'
import type { RunOptions, RuntimeResult } from './runtime.js'

export interface CookedResult {
  views: Map<string, Table>
  graphs: GraphSpec[]
  // The scene, run-length encoded per object per column — see buildFrameStore.
  scene: FrameStore
  timelineRows: Row[]
  hydraRows: Row[]
  baubleRows: Row[]
  postRows: Row[]
}

// The slice of createRuntime's return value cookProgram needs.
interface Runtime {
  run(code: string, opts?: RunOptions): RuntimeResult
}

export function cookProgram(runtime: Runtime, code: string, seed: number, dataCache?: Map<string, string>): CookedResult {
  const result = runtime.run(code, { seed, dataCache })
  const view = (name: string): Table | undefined =>
    result.views.get(outViewName(name)) ?? result.views.get(name)
  const scene = view('scene')
  // "three" is the 3D scene's event table (matching hydra/bauble/post naming);
  // "events" is its legacy name, kept so saved sessions still render.
  const three = view('three') ?? result.views.get('events')
  const sceneStore = buildFrameIndex(scene ? scene.rows : three ? three.rows : [])
  const timeline = view('timeline')
  const timelineRows = timeline ? timeline.rows : []
  const hydra = view('hydra')
  const hydraSketchRows = hydra ? hydraRows(hydra.rows) : hydraRows(three?.rows)
  // No three-table fallback for bauble: its events share hydra's names, so
  // sniffing the generic scene table would claim the same rows twice.
  const bauble = view('bauble')
  const baubleSketchRows = bauble ? baubleRows(bauble.rows) : []
  // No three-table fallback for post either — its setCode/transition/… names
  // collide with hydra's (bauble precedent).
  const post = view('post')
  const postSketchRows = post ? postRows(post.rows) : []
  // Compile every post state now so a broken chain throws here — surfaced to
  // the user as a cook error — instead of failing silently at frame time.
  const postIndex = buildPostIndex(postSketchRows)
  for (const f of postStateFrames(postIndex)) postFrameAt(postIndex, f)
  return { views: result.views, graphs: result.graphs, scene: sceneStore, timelineRows, hydraRows: hydraSketchRows, baubleRows: baubleSketchRows, postRows: postSketchRows }
}
