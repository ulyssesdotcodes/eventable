// Which bands the timeline pane shows, and what each one draws — the "what
// exists" half of the sectioned strip (src/timeline-strip.ts lays one band
// out; src/ui/timeline-pane.tsx renders them). Pure: no DOM, no store.
//
// Three shapes. An 'events' band is a cooked out view — the rows playback will
// actually consume for that consumer kind, any .retime() of them already baked
// in by the cook — drawn as handles. (A mesh's geometry is warped rather than
// moved, and is filtered out of the band anyway; see sceneEvents.)
// A 'channel' band is long-format automation
// (recorded sliders, recorded midi, post's setVariable keyframes) drawn as one
// trace per id via graph-panel's pivotChannels. The 'timeline' band is the
// warp itself, the one section backed by live editable store rows.

import type { Row } from './lineage.js'
import { outViewName } from './dsl.js'
import { buildPostIndex, varTracks } from './post.js'
import type { PassState, VisualizerKind } from './visualizer.js'

export type SectionKind = 'events' | 'channel' | 'timeline'

// How a band's handles can be dragged. 'lineage': cooked rows, so only the
// placements sectionLayout could trace back to an unmoved store row are live
// (Handle.source), and only as body moves. 'rows': the timeline table's own
// live rows, where a handle's row index IS its storage index and its derived
// window edges retarget neighbours. 'none': a channel plot has no handles.
export type SectionDrag = 'none' | 'lineage' | 'rows'

export interface TimelineSection {
  name: string
  kind: SectionKind
  // The table-panel tab a click on this band opens.
  view: string
  rows: Row[]
  // This band's current CONTENT pass — what sectionLayout filters source beats
  // by. Flat ({pass: 0, loops: 1}) for anything with no pass model of its own.
  pass: PassState
  drag: SectionDrag
  // A 'channel' band's long-format shape: pivotChannels widens `rows` by
  // `idCol` into one column (one trace) per id.
  channel?: { idCol: string; valueCol: string }
}

// Where a band's content currently is. A cooked out band counts its OWN
// content passes — each `loopBeats` long, stacked on top of the source beat
// (visualizer.ts's passOffset) — while a band with no content pass of its own
// (particles, recorded automation, the warp itself) rides playback's TIMELINE
// pass at the plain source beat. The two axes are independent, so
// which one a band reports is decided by whether it has passes of its own.
export function sectionBeat(
  section: TimelineSection,
  at: { srcBeat: number; loopBeats: number; timelinePass: number; timelineLoops: number },
): { beat: number; pass: number; loops: number } {
  if (section.pass.loops > 1) {
    return { beat: section.pass.pass * at.loopBeats + at.srcBeat, pass: section.pass.pass, loops: section.pass.loops }
  }
  return { beat: at.srcBeat, pass: at.timelinePass, loops: Math.max(1, at.timelineLoops) }
}

// No pass model of its own: particles reads the source beat unwrapped (see
// main.ts's setParticleTime), and recorded automation is logged against
// playback, not against a content loop.
const FLAT: PassState = { pass: 0, loops: 1 }

// A mesh's geometry — its vertices, faces, triangles and creases, each linked
// to the mesh by `of`, which is what makes `of` the whole test (only a create
// row names which element it is; the position updates just carry `of`).
// Thousands of them, nearly all on one beat, none of them something a person
// places: the band was a wall of handles, and laying it out is what makes the
// strip stall. The mesh keeps its own handle, and so does every colour pulse
// painted onto it — a paint row addresses the mesh, so it names no `of`.
const sceneEvents = (rows: Row[]): Row[] => rows.filter((r) => r.of == null)

// The cooked outputs a section list reads — a structurally assignable subset of replay.ts's CookedResult.
export interface CookedSectionData {
  views: ReadonlyMap<string, { rows: Row[] }>
  hydraRows: Row[]
  baubleRows: Row[]
  postRows: Row[]
}

// The pane's bands, top to bottom: the warp that moves everything, then one
// per cooked out view with any placeable rows, then the automation plots.
// Empty bands are dropped — a band's presence is what widens the pane.
export function sectionsFor(input: {
  cooked: CookedSectionData
  particleRows: Row[]
  // The LIVE store rows of the warp band — the one band that edits rather than
  // reports, so it tracks an in-progress retiming rather than waiting for
  // Apply. (The APPLIED rows the out bands place through are sectionLayout's
  // own argument, not a section's.)
  timelineRows: Row[]
  // Live store rows of every fold table, by tab name — the same deal as
  // `timelineRows`: they report the instructions, not a cooked output.
  foldTables: { name: string; rows: Row[] }[]
  sliderRows: Row[]
  midiRows: Row[]
  passes: Partial<Record<VisualizerKind, PassState>>
}): TimelineSection[] {
  const { cooked, passes } = input
  const viewOf = (kind: string, extra: string[] = []): string => {
    for (const n of [outViewName(kind), kind, ...extra]) if (cooked.views.has(n)) return n
    return kind
  }
  const three = cooked.views.get(outViewName('three')) ?? cooked.views.get('three') ?? cooked.views.get('events')
  // hydraRows may be sniffed out of the three table when no hydra view exists
  // (see replay.ts) — those rows already ride the 'three' band and there is
  // no hydra tab to open, so only a real hydra view earns a band.
  const hydraRows = cooked.views.has(outViewName('hydra')) || cooked.views.has('hydra') ? cooked.hydraRows : []

  const sections: TimelineSection[] = []
  const placeable = (rows: Row[]): boolean => rows.some((r) => typeof r.beat === 'number')

  if (placeable(input.timelineRows)) {
    sections.push({ name: 'timeline', kind: 'timeline', view: 'timeline', rows: input.timelineRows, pass: FLAT, drag: 'rows' })
  }
  // The instructions a paper is folded by: one handle per fold, where the
  // scene table has thousands per fold. This is the band worth reading for a
  // folding — it is what a person wrote, and what they would move.
  for (const t of input.foldTables) {
    if (placeable(t.rows)) {
      sections.push({ name: t.name, kind: 'events', view: t.name, rows: t.rows, pass: FLAT, drag: 'lineage' })
    }
  }
  for (const t of [
    { name: 'three', view: viewOf('three', ['events']), rows: sceneEvents(three?.rows ?? []), pass: passes.scene },
    { name: 'hydra', view: viewOf('hydra'), rows: hydraRows, pass: passes.hydra },
    { name: 'bauble', view: viewOf('bauble'), rows: cooked.baubleRows, pass: passes.bauble },
    { name: 'post', view: viewOf('post'), rows: cooked.postRows, pass: passes.post },
    { name: 'particles', view: viewOf('particles'), rows: input.particleRows, pass: FLAT },
  ]) {
    if (placeable(t.rows)) sections.push({ ...t, kind: 'events', pass: t.pass ?? FLAT, drag: 'lineage' })
  }

  // 'slider'/'midi' are panel-only synthetic views spliced in by
  // tablesForDisplay (main.ts), never editableStore tables — so they're named
  // by their tab, never looked up in the store.
  const channel = (name: string, view: string, rows: Row[], idCol: string, pass = FLAT): void => {
    if (rows.length) sections.push({ name, kind: 'channel', view, rows, pass, drag: 'none', channel: { idCol, valueCol: 'value' } })
  }
  channel('slider', 'slider', input.sliderRows, 'id')
  channel('midi', 'midi', input.midiRows, 'note')
  // Post only: hydra/bauble/particles fold setVariable last-write-wins,
  // with no per-name track to plot. Each track's rows stay contiguous and in
  // frame order, which is the order a pivoted trace is drawn in.
  channel('post vars', viewOf('post'), [...varTracks(buildPostIndex(cooked.postRows)).values()].flat(), 'name', passes.post ?? FLAT)

  return sections
}
