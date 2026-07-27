// The app shell: one Solid render tree for the whole layout, rendering the
// pure-logic controllers main.ts builds (humble-object style). The canvases
// are created here but drawn imperatively outside Solid. Playback arrives as
// an accessor main.ts fills in right after mountApp returns — the engine
// needs the canvases this render creates.

import { createSignal, onCleanup, Show, type Accessor } from 'solid-js'
import { render } from 'solid-js/web'
import { TimelinePane } from './timeline-pane.js'
import type { PlaybackController } from './transport.js'
import { TablePane, type TablePanelController, type PanelChrome } from './table-panel.js'
import { SessionBar, type SessionBarController } from './session-bar.js'
import { SessionSelector, type SessionSelectorController } from './session-selector.js'
import { RoomChip, type RoomChipController } from './room-chip.js'
import { SliderPanel, type SliderPanelController } from './slider-panel.js'
import { PaneDivider } from './pane-divider.js'
import { Icon } from './icon.js'
import { getSidePanelSplit, setSidePanelSplit, getCanvasSplit, setCanvasSplit } from '../settings.js'
import type { Row } from '../lineage.js'
import type { ResolveSource } from '../timeline-strip.js'
import type { TimelineSection } from '../timeline-sections.js'

// The canvas/side-panel split only exists in the desktop (row) layout — the
// stylesheet stacks them vertically below this.
const DESKTOP_QUERY = '(min-width: 768px)'

export interface AppProps {
  tablePanel: TablePanelController
  // The relocated editor-header chrome (D6) — settings + scene import/export.
  chrome: PanelChrome
  sessionBar: SessionBarController
  sessionSelector: SessionSelectorController
  roomChip: RoomChipController
  sliderPanel: SliderPanelController
  playback: Accessor<PlaybackController | null>
  // The applied cook's timeline rows, for the warp band's coverage shading and
  // pending styling — the "applied" half of the live/applied split.
  timelineRows: Accessor<Row[]>
  // The timeline pane's bands, rebuilt per cook and per store tick.
  sections: Accessor<TimelineSection[]>
  // Traces a cooked row back to the editable store row a drag writes through.
  resolveSource: ResolveSource
  onClearRuns: () => void
  // A timeline drag just committed its one store.setRow — re-run so the drop
  // applies immediately instead of sitting pending (see main.ts's evaluate()).
  onDragCommit: () => void
}

// Canvases this render creates but does not draw into — main.ts hands them
// to initThree/initHydra/initBauble. Hydra reads the other two as textures
// and is normally the visible output.
export interface CanvasMounts {
  canvasPane: HTMLElement
  threeCanvas: HTMLCanvasElement
  baubleCanvas: HTMLCanvasElement
  hydraCanvas: HTMLCanvasElement
}

function App(props: AppProps & { mounts: CanvasMounts }) {
  let sidePanels: HTMLDivElement | undefined
  let tablePane: HTMLDivElement | undefined
  const mq = window.matchMedia(DESKTOP_QUERY)
  const [desktop, setDesktop] = createSignal(mq.matches)
  const onMq = (e: MediaQueryListEvent): void => { setDesktop(e.matches) }
  mq.addEventListener('change', onMq)
  onCleanup(() => mq.removeEventListener('change', onMq))
  return (
    <>
      <div id="canvas-pane" ref={(el) => (props.mounts.canvasPane = el)}>
        <canvas id="three-canvas" ref={(el) => (props.mounts.threeCanvas = el)} />
        <canvas id="hydra-canvas" ref={(el) => (props.mounts.hydraCanvas = el)} />
        <canvas id="bauble-canvas" ref={(el) => (props.mounts.baubleCanvas = el)} />
        <SliderPanel ctl={props.sliderPanel} />
      </div>
      <Show when={desktop()}>
        <PaneDivider
          axis="row"
          container={() => sidePanels?.parentElement ?? undefined}
          pane={() => sidePanels}
          get={getCanvasSplit}
          set={setCanvasSplit}
          label="Resize output and panels"
        />
      </Show>
      <div id="side-panels" ref={sidePanels}>
        {/* The pane mounts once for the app's lifetime (it is created the one
            time playback lands and never torn down) — the tradition the old
            timeline strip kept because anything reading the store's onChange
            has no unsubscribe. */}
        <Show when={props.playback()}>
          {(p) => (
            <TimelinePane
              vs={p().vs}
              engine={p().engine}
              tapControl={p().tapControl}
              sections={props.sections}
              timelineRows={props.timelineRows}
              store={props.tablePanel.store}
              resolveSource={props.resolveSource}
              presence={props.tablePanel.presence}
              focusedRow={props.tablePanel.focusedRow}
              onSelectRow={(table, row) => props.tablePanel.focusRow(table, row)}
              onStripRowChange={(row) => props.tablePanel.setStripRow(row)}
              onDragCommit={props.onDragCommit}
              onSelectView={(view) => props.tablePanel.selectTable(view)}
            />
          )}
        </Show>
        <PaneDivider
          container={() => sidePanels}
          pane={() => tablePane}
          get={getSidePanelSplit}
          set={setSidePanelSplit}
          label="Resize timeline and table panes"
        />
        <TablePane ctl={props.tablePanel} chrome={props.chrome} ref={(el) => (tablePane = el)}>
          <SessionSelector ctl={props.sessionSelector}>
            <RoomChip ctl={props.roomChip} />
            <button
              class="session-clear"
              title="Clear the saved run history — the program text is untouched"
              aria-label="clear run history"
              onClick={() => props.onClearRuns()}
            >
              <Icon name="trash-2" />
            </button>
          </SessionSelector>
          <SessionBar ctl={props.sessionBar} />
        </TablePane>
      </div>
    </>
  )
}

// Solid's render is synchronous, so the mounts are populated by the time
// this returns.
export function mountApp(root: HTMLElement, props: AppProps): CanvasMounts {
  const mounts = {} as CanvasMounts
  render(() => <App {...props} mounts={mounts} />, root)
  return mounts
}
