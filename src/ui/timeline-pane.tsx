// The timeline pane — the humble Solid view over ../timeline-strip.ts
// (geometry/handle/drag model), ../timeline-sections.ts (which bands exist)
// and ../graph-panel.ts (the channel plots). One transport row, one beat
// ruler, then one band per TimelineSection, all sharing the ruler's x axis
// (beatToX's 1..maxBeats+1 — which TIMELINE_CHART_STYLE's zero horizontal
// padding makes the canvas bands share too).

import { createSignal, createMemo, createEffect, onMount, onCleanup, For, Index, Show, type Accessor } from 'solid-js'
import { Transport } from './transport.js'
import {
  beatToX, xToBeat, gridLines, sectionLayout, hitTest, resolveHandle, snapDelta, dragUpdate,
  withPreview, columnsFromRows, valuesDiffer, exceedsDragThreshold, coverageBands,
  meaningfulSummary, pendingTimelineRows,
  type StripGeometry, type Handle, type HandleSource, type ResolveSource, type DragOptions, type SnapMode,
} from '../timeline-strip.js'
import { sectionBeat, type TimelineSection } from '../timeline-sections.js'
import { buildTimeline } from '../timeline.js'
import { formatEditableCell } from '../table-panel.js'
import {
  pivotChannels, chartDataFor, computeColRanges, drawSeriesChart, TIMELINE_CHART_STYLE,
} from '../graph-panel.js'
import { listenGlobal } from './dom.js'
import { Icon } from './icon.js'
import type { PlaybackEngine, PlaybackViewState, TapControl } from '../playback.js'
import type { Row } from '../lineage.js'
import type { EditableTableStore } from '../editable-tables.js'
import type { PeerPresence } from '../table-panel.js'

// Accent color for the focused-handle ring — matches the playhead (#e94560),
// the pane's one other "this is the important one" signal.
const FOCUS_RING = '0 0 0 2px #e94560'

// Horizontal margin the floating readout keeps from a band's own edges (it
// isn't measured, so this is a fixed safety margin, not a width-aware clamp).
const READOUT_MARGIN = 8

const NO_ROWS = new Set<number>()

export function TimelinePane(props: {
  vs: Accessor<PlaybackViewState>
  engine: PlaybackEngine
  tapControl?: TapControl
  // Which bands exist, rebuilt by main.ts on every cook and store tick — the
  // pane itself never subscribes to the store (see the mount note below).
  sections: Accessor<TimelineSection[]>
  // The APPLIED cook's warp rows: what the cooked bands were placed through,
  // and what the live warp band's handles are compared against for pending
  // styling. The live rows ride the `timeline` section itself.
  timelineRows: Accessor<Row[]>
  store: EditableTableStore
  // Traces a cooked row back to the editable store row it came from — main.ts
  // owns it because only it can resolve lineage against the store.
  resolveSource: ResolveSource
  presence: Accessor<PeerPresence[]>
  focusedRow: Accessor<{ table: string; row: number } | null>
  onSelectRow?: (table: string, row: number | null) => void
  // The row the pane is pointing at (hover or live drag), for the panel's
  // row-level highlight; null when the pointer leaves or the gesture ends.
  onStripRowChange?: (row: { table: string; row: number } | null) => void
  // A drag's one store.setRow just landed — main.ts re-runs so the drop
  // applies immediately instead of sitting pending.
  onDragCommit?: () => void
  // A press on a band that can't be dragged opens that band's table tab.
  onSelectView?: (view: string) => void
}) {
  let sectionsEl: HTMLDivElement | undefined
  const [collapsed, setCollapsed] = createSignal(false)
  const [width, setWidth] = createSignal(0)

  // vs() updates every animation frame. Reading only the one field each memo
  // needs (rather than vs() as a whole) means a memo's equality check absorbs
  // frames where that field didn't change, so the bands below don't rebuild
  // every tick.
  const maxBeats = createMemo(() => props.vs().maxBeats)
  const loopBeats = createMemo(() => props.vs().loopBeats)
  const scrubPos = createMemo(() => props.vs().scrubPos)
  const srcBeat = createMemo(() => props.vs().srcBeat)
  const timelinePass = createMemo(() => props.vs().timelinePass)

  const geometry = createMemo<StripGeometry>(() => ({ width: width(), maxBeats: maxBeats() }))
  const grid = createMemo(() => gridLines(geometry().maxBeats, geometry().width))
  const timelineLoops = createMemo(() => buildTimeline(props.timelineRows(), loopBeats()).loops)
  const playheadX = createMemo(() => beatToX(geometry(), scrubPos() + 1))

  onMount(() => {
    if (!sectionsEl) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w != null) setWidth(w)
    })
    ro.observe(sectionsEl)
    onCleanup(() => ro.disconnect())
  })

  function snapModeFor(e: PointerEvent): SnapMode {
    return e.shiftKey ? 'coarse' : e.altKey ? 'free' : 'quarter'
  }

  // One band. `<Index>` keys by position, so a band component (and its canvas,
  // hover and gesture state) survives the section list being rebuilt on every
  // store tick — only a change in how many bands exist mounts or drops one.
  function SectionBand(bandProps: { section: Accessor<TimelineSection> }) {
    let bandEl: HTMLDivElement | undefined
    let canvasEl: HTMLCanvasElement | undefined
    // A handle drag in progress — plain (non-reactive) bookkeeping, distinct
    // from `preview` (the signal the render reads). `moved` flips once the
    // pointer clears the threshold; until then pointerup is a click.
    // `origBeat` and `sectionName` are the gesture's identity anchors: the
    // store (a peer's edit, a re-cook) and the section list can both change
    // under a held pointer, and a raw index would then aim at someone else's
    // row.
    let gesture: {
      handle: Handle; source: HandleSource; origBeat: unknown; sectionName: string
      pointerId: number; x0: number; y0: number; moved: boolean
    } | null = null
    // Last row reported to onStripRowChange — hover fires per pointermove, so
    // dedupe to actual row changes rather than spamming the panel.
    let reported: string | null = null

    const [hover, setHover] = createSignal<{ row: number; ghost: boolean; drag: boolean } | null>(null)
    const [preview, setPreview] = createSignal<{ row: number; values: Record<string, unknown> } | null>(null)

    const sec = bandProps.section
    const columns = createMemo(() => columnsFromRows(sec().rows))
    // One table, one content pass, one timeline pass. Cooked bands resolve
    // their draggability through main.ts's lineage lookup; the warp band's own
    // rows are store rows already, so sectionLayout tags them itself.
    const layout = createMemo(() => {
      const s = sec()
      if (s.kind === 'channel') return { handles: [] as Handle[], laneCount: 1 }
      const p = preview()
      const rows = p ? withPreview(s.rows, p) : s.rows
      return sectionLayout(
        s.name, rows, columns(), props.timelineRows(), loopBeats(),
        { content: s.pass.pass, timeline: timelinePass() },
        s.drag === 'lineage' ? props.resolveSource : undefined,
      )
    })
    const laneCount = createMemo(() => layout().laneCount)
    // Dashed-outline "pending" style: the warp band's live rows against the
    // applied cook's (see pendingTimelineRows). Cooked bands are the applied
    // state by definition and never drift.
    const pending = createMemo(() => (
      sec().kind === 'timeline' ? pendingTimelineRows(sec().rows, props.timelineRows()) : NO_ROWS
    ))
    // One tint per compiled warp segment, current pass only — an unfiltered
    // render would draw every pass's tint on top of this one.
    const coverage = createMemo(() => {
      if (sec().kind !== 'timeline') return []
      const geo = geometry()
      return coverageBands(props.timelineRows(), loopBeats())
        .filter((b) => b.lane === timelinePass())
        .map((b) => {
          const left = beatToX(geo, b.p0)
          return { left, width: Math.max(0, beatToX(geo, b.p1) - left), kind: b.kind }
        })
    })
    // Where this band's content currently is: a cooked band counts its own
    // content passes on top of the source beat, everything else rides the
    // warp's pass at the plain source beat.
    const at = createMemo(() => sectionBeat(sec(), {
      srcBeat: srcBeat(), loopBeats: loopBeats(), timelinePass: timelinePass(), timelineLoops: timelineLoops(),
    }))

    // Arrow-linked pairs: a fold transition span and its destination setCode
    // point, or an eased setVariable point and the row it glides from —
    // hovering either end highlights both.
    const linked = createMemo<Set<number>>(() => {
      const hv = hover()
      const set = new Set<number>()
      if (!hv) return set
      for (const h of layout().handles) {
        const other = h.endRow ?? h.glideFrom
        if (other === undefined) continue
        if (h.row === hv.row || other === hv.row) { set.add(h.row); set.add(other) }
      }
      return set
    })

    // Connector arrows for eased keyframes: a line from the previous same-name
    // point to the arriving one, arrowhead on arrival, skipping any that would
    // run backward (the loop-wrap glide).
    const glideArrows = createMemo(() => {
      const geo = geometry()
      const hs = layout().handles
      const arrows: { left: number; width: number; lane: number; row: number }[] = []
      for (const h of hs) {
        if (h.kind !== 'point' || h.glideFrom === undefined) continue
        const from = hs.find((f) => f.row === h.glideFrom && f.lane === h.lane)
        if (!from || !(from.beat < h.beat)) continue
        const left = beatToX(geo, from.beat)
        arrows.push({ left, width: Math.max(1, beatToX(geo, h.beat) - left), lane: h.lane, row: h.row })
      }
      return arrows
    })

    // The hovered, dragged or selected placement — the one handle the readout
    // and the unlabeled position tag describe. A live gesture wins over the
    // resting selection, which is the panel's shared focusedRow.
    const activeHandle = createMemo<Handle | null>(() => {
      const hs = layout().handles
      const p = preview()
      if (p) return hs.find((h) => h.row === p.row) ?? null
      const hv = hover()
      if (hv) return hs.find((h) => h.row === hv.row && h.ghost === hv.ghost) ?? hs.find((h) => h.row === hv.row) ?? null
      const fr = props.focusedRow()
      if (!fr) return null
      return hs.find((h) => h.source?.table === fr.table && h.source.row === fr.row) ?? null
    })

    // The floating readout's lines: the row's meaningful columns — what it IS —
    // never its position, which the band shows visually and the handle's own
    // unlabeled tag states precisely.
    const readout = createMemo<{ left: number; lines: string[] } | null>(() => {
      const h = activeHandle()
      const row = h ? sec().rows[h.row] : undefined
      if (!h || !row) return null
      const lines = meaningfulSummary(row, columns())
      if (h.disabled) lines.push('disabled')
      if (h.ghost) lines.push('ghost placement')
      if (!lines.length) return null
      const geo = geometry()
      const left = Math.max(READOUT_MARGIN, Math.min(geo.width - READOUT_MARGIN, beatToX(geo, h.beat)))
      return { left, lines }
    })

    function report(next: { table: string; row: number } | null): void {
      const key = next ? `${next.table}::${next.row}` : null
      if (key === reported) return
      reported = key
      props.onStripRowChange?.(next)
    }

    function handleBox(h: Handle): { left: string; width?: string; top: string; height: string } {
      const geo = geometry()
      const top = `${(h.lane / laneCount()) * 100}%`
      const height = `${100 / laneCount()}%`
      if (h.kind === 'span' && h.end != null) {
        const left = beatToX(geo, h.beat)
        return { left: `${left}px`, width: `${Math.max(1, beatToX(geo, h.end) - left)}px`, top, height }
      }
      return { left: `${beatToX(geo, h.beat)}px`, top, height }
    }

    function ringStyle(h: Handle): string | undefined {
      const src = h.source
      if (!src) return undefined
      const fr = props.focusedRow()
      const focused = !h.ghost && !!fr && fr.table === src.table && fr.row === src.row
      const peer = props.presence().find((p) => p.lastEdit && p.lastEdit.table === src.table && p.lastEdit.row === src.row)?.color
      const rings: string[] = []
      if (focused) rings.push(FOCUS_RING)
      if (peer) rings.push(`0 0 0 ${focused ? 4 : 2}px ${peer}`)
      return rings.length ? rings.join(', ') : undefined
    }

    const posTag = (h: Handle): string => {
      const n = (v: number): string => formatEditableCell('number', v)
      return h.end != null ? `${n(h.beat)}–${n(h.end)}` : n(h.beat)
    }
    const isActive = (h: Handle): boolean => {
      const a = activeHandle()
      return !!a && a.row === h.row && a.ghost === h.ghost
    }

    // Which lane a pointer's client-y falls in — the inverse of handleBox's
    // top/height split, both dividing the band's full height evenly.
    function laneAt(clientY: number): number {
      const count = laneCount()
      if (count <= 1 || !bandEl) return 0
      const rect = bandEl.getBoundingClientRect()
      if (!(rect.height > 0)) return 0
      return Math.min(count - 1, Math.max(0, Math.floor(((clientY - rect.top) / rect.height) * count)))
    }

    function handleAt(e: PointerEvent): Handle | undefined {
      if (!bandEl) return undefined
      const x = e.clientX - bandEl.getBoundingClientRect().left
      const lane = laneAt(e.clientY)
      const row = hitTest(layout().handles, geometry(), x, lane)
      return row == null ? undefined : resolveHandle(layout().handles, geometry(), row, x, lane)
    }

    // Pointer dx (converted to beats, snapped per the live modifier keys) →
    // dragUpdate's payload, previewed locally. Only whole-row moves: an edge
    // belongs to a neighbouring row on the warp band, and a cooked band's
    // stored duration isn't this row's to resize.
    function updateGesturePreview(e: PointerEvent): void {
      const g = gesture
      if (!g || !bandEl) return
      const geo = geometry()
      const rect = bandEl.getBoundingClientRect()
      const raw = xToBeat(geo, e.clientX - rect.left) - xToBeat(geo, g.x0 - rect.left)
      const dBeats = snapDelta(g.handle.beat, raw, { mode: snapModeFor(e) })
      const opts: DragOptions = {}
      // The warp band's own rows are already playback-axis positions — only a
      // content row's drop needs mapping back through sourceBeatAt.
      if (sec().kind !== 'timeline') {
        const tl = buildTimeline(props.timelineRows(), loopBeats())
        if (tl.active) opts.timeline = tl
      }
      setPreview({ row: g.handle.row, values: dragUpdate(g.handle, dBeats, opts).values })
    }

    // One store.setRow for the whole gesture (a no-op if it snapped back to
    // where it started), then focus the row exactly like a plain click.
    function endGesture(commit: boolean): void {
      const g = gesture
      gesture = null
      if (!g) return
      const p = preview()
      if (commit && g.moved && p) {
        const row = props.store.get(g.source.table)?.rows[g.source.row]
        // A row inserted or removed above this one mid-drag shifts every later
        // index, so the row now at g.source.row may be someone else's — drop
        // the write rather than silently overwrite it.
        if (row && row.beat === g.origBeat && valuesDiffer(row, p.values)) {
          props.store.setRow(g.source.table, g.source.row, p.values)
          props.onDragCommit?.()
        }
      }
      if (commit) props.onSelectRow?.(g.source.table, g.source.row)
      setPreview(null)
      // The pointer may have been dragged (or released) off the band — a stale
      // hover would pin the readout there; the next pointermove re-derives it.
      setHover(null)
      report(null)
    }

    // Escape cancels a drag wherever keyboard focus happens to be — a mouse
    // drag rarely leaves focus on the band itself.
    listenGlobal(window, 'keydown', (e) => {
      if (e.key === 'Escape' && gesture) {
        e.preventDefault()
        bandEl?.releasePointerCapture(gesture.pointerId)
        endGesture(false)
      }
    })

    function onPointerDown(e: PointerEvent): void {
      const s = sec()
      const h = handleAt(e)
      if (!h) {
        // A background press deselects — clearing the shared row selection
        // hides the pinned readout (and the row's highlight in the panel).
        if (s.drag === 'rows') props.onSelectRow?.(s.name, null)
        return
      }
      // Nothing to write back (a warped, retimed or pass-wrapped placement, or
      // a row with no editable origin): the press opens that band's tab, the
      // pane's "show me this clip's data".
      if (!h.source) { props.onSelectView?.(s.view); return }
      gesture = {
        handle: h, source: h.source, origBeat: props.store.get(h.source.table)?.rows[h.source.row]?.beat,
        sectionName: s.name, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false,
      }
      bandEl?.setPointerCapture(e.pointerId)
    }

    // `<Index>` rebinds a band slot to a different section when an earlier band
    // gains or loses rows (an Apply mid-drag), which would leave this gesture
    // previewing its row indices onto the newcomer's rows.
    createEffect(() => {
      const name = sec().name
      if (gesture && gesture.sectionName !== name) {
        bandEl?.releasePointerCapture(gesture.pointerId)
        endGesture(false)
      }
    })

    function onPointerMove(e: PointerEvent): void {
      const g = gesture
      if (!g) {
        const h = handleAt(e)
        setHover(h ? { row: h.row, ghost: h.ghost, drag: !!h.source } : null)
        report(h?.source ?? null)
        return
      }
      if (!g.moved) {
        if (!exceedsDragThreshold(e.clientX - g.x0, e.clientY - g.y0)) return
        g.moved = true
        // The moment it's a real drag (not just yet a click) — focus and
        // row-highlight the dragged row live, not only once the pointer lifts.
        props.onSelectRow?.(g.source.table, g.source.row)
        report(g.source)
      }
      updateGesturePreview(e)
    }

    // --- channel bands: one trace per id, on the ruler's own axis ------------
    function drawChannel(): void {
      const s = sec()
      // <Show> leaves the ref pointing at a detached node when a band's kind
      // changes under it (the list is rebuilt, the component isn't).
      if (!canvasEl?.isConnected || s.kind !== 'channel' || !s.channel) return
      const { rows, cols } = pivotChannels(s.rows, s.channel)
      const data = chartDataFor(rows, ['beat', ...cols], cols, s.name)
      if (!data) return
      // xMin/xMax pinned to beatToX's axis (beat b sits at elapsed b−1) so the
      // trace lines up with the handle bands and the ruler above them.
      drawSeriesChart(
        canvasEl, { ...data, xMin: 1, xMax: maxBeats() + 1 },
        computeColRanges(rows, cols, TIMELINE_CHART_STYLE.yPadFrac),
        { style: TIMELINE_CHART_STYLE },
      )
    }
    // Data + geometry only: the playhead is the pane's own DOM layer, so a
    // canvas never redraws at frame rate.
    createEffect(() => {
      sec()
      maxBeats()
      width()
      drawChannel()
    })

    return (
      <div>
        <div class="timeline-section-header">
          <button
            class="timeline-section-name"
            title={`Open the ${sec().view} table`}
            onClick={() => props.onSelectView?.(sec().view)}
          >
            {sec().name}
          </button>
          <Show when={at().loops > 1}>
            <span class="timeline-section-beat">
              {`pass ${at().pass + 1}/${at().loops} · beat ${at().beat.toFixed(1)}`}
            </span>
          </Show>
        </div>
        {/* The readout floats above the band's own overflow:hidden, so it
            renders as a sibling in a plain (overflow: visible) wrapper. */}
        <div class="timeline-strip-wrap">
          <Show when={readout()}>
            {(r) => (
              <div class="timeline-strip-readout" style={{ left: `${r().left}px` }}>
                <For each={r().lines}>{(line) => <div class="timeline-strip-readout-line">{line}</div>}</For>
              </div>
            )}
          </Show>
          <div
            class="timeline-strip"
            ref={bandEl}
            classList={{
              'timeline-strip-multilane': laneCount() > 1,
              'timeline-strip-dragging-move': !!preview(),
              'timeline-strip-hover-grab': !preview() && hover()?.drag === true,
            }}
            style={{ '--lane-rows': String(laneCount()) }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={() => endGesture(true)}
            onPointerCancel={() => { if (gesture) endGesture(false) }}
            onPointerLeave={() => { if (!gesture) { setHover(null); report(null) } }}
          >
            <For each={coverage()}>
              {(seg) => (
                <div
                  class={`timeline-strip-coverage timeline-strip-coverage-${seg.kind ?? 'plain'}`}
                  style={{ left: `${seg.left}px`, width: `${seg.width}px`, top: '0', height: '100%' }}
                />
              )}
            </For>
            <div class="timeline-strip-elapsed" style={{ width: `${playheadX()}px` }} />
            <For each={grid()}>
              {(line) => <div class={`timeline-strip-tick timeline-strip-tick-${line.kind}`} style={{ left: `${line.x}px` }} />}
            </For>
            <Show when={sec().kind === 'channel'}>
              <canvas class="timeline-section-canvas" ref={(el) => (canvasEl = el)} />
            </Show>
            <div class="timeline-strip-handles">
              <For each={glideArrows()}>
                {(a) => (
                  <div
                    class="timeline-strip-glide"
                    classList={{ 'timeline-strip-handle-linked': linked().has(a.row) }}
                    style={{
                      left: `${a.left}px`, width: `${a.width}px`,
                      top: `${(a.lane / laneCount()) * 100}%`, height: `${100 / laneCount()}%`,
                    }}
                  >
                    <span class="timeline-strip-glide-arrow" />
                  </div>
                )}
              </For>
              <For each={layout().handles}>
                {(h) => (
                  <div
                    class={`timeline-strip-handle timeline-strip-handle-${h.kind}`}
                    classList={{
                      'timeline-strip-handle-ghost': h.ghost,
                      'timeline-strip-handle-disabled': h.disabled,
                      'timeline-strip-handle-inert': !h.source,
                      'timeline-strip-handle-pending': pending().has(h.row),
                      'timeline-strip-handle-dragging': preview()?.row === h.row,
                      'timeline-strip-handle-linked': linked().has(h.row),
                    }}
                    style={{ ...handleBox(h), 'box-shadow': ringStyle(h) }}
                  >
                    <Show when={h.kind === 'point'}>
                      <span class="timeline-strip-handle-dot" />
                    </Show>
                    <Show when={h.kind === 'span'}>
                      <span class="timeline-strip-handle-edge timeline-strip-handle-edge-start" />
                      <span class="timeline-strip-handle-edge timeline-strip-handle-edge-end" />
                      {/* A fold transition's end edge points to its destination
                          setCode's dot — the arrowhead meets that point handle. */}
                      <Show when={h.endRow !== undefined}>
                        <span class="timeline-strip-handle-arrow" />
                      </Show>
                    </Show>
                    <Show when={isActive(h)}>
                      <span class="timeline-strip-handle-postag">{posTag(h)}</span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
            {/* This band's own current beat, on its own content axis — the
                shared playhead below tracks playback's axis instead. */}
            <div class="timeline-section-marker" style={{ left: `${beatToX(geometry(), srcBeat())}px` }} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div id="timeline-pane" classList={{ 'timeline-collapsed': collapsed() }}>
      <div class="timeline-pane-header">
        <button
          class="collapse-btn"
          title={collapsed() ? 'Show the timeline' : 'Hide the timeline'}
          aria-label={collapsed() ? 'Show the timeline' : 'Hide the timeline'}
          onClick={() => setCollapsed((c) => !c)}
        >
          <Icon name={collapsed() ? 'chevron-right' : 'chevron-down'} />
        </button>
        <div class="timeline-transport">
          <Transport vs={props.vs} engine={props.engine} tapControl={props.tapControl} />
        </div>
      </div>
      <div class="timeline-sections" ref={sectionsEl}>
        <div class="timeline-pane-axis">
          <For each={grid()}>
            {(line) => (
              <div class={`timeline-strip-tick timeline-strip-tick-${line.kind}`} style={{ left: `${line.x}px` }}>
                {line.label != null && <span class="timeline-strip-tick-label">{line.label}</span>}
              </div>
            )}
          </For>
        </div>
        <Index each={props.sections()}>{(s) => <SectionBand section={s} />}</Index>
        <div class="timeline-pane-playhead" style={{ left: `${playheadX()}px` }} />
      </div>
    </div>
  )
}
