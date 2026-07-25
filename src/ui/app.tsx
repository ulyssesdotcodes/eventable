// The app shell: one Solid render tree for the whole layout, rendering the
// pure-logic controllers main.ts builds (humble-object style). The canvases
// are created here but drawn imperatively outside Solid. Playback arrives as
// an accessor main.ts fills in right after mountApp returns — the engine
// needs the canvases this render creates.

import { createSignal, Show, type Accessor } from 'solid-js'
import { render } from 'solid-js/web'
import { PlaybackControls, type PlaybackController } from './playback-controls.js'
import { EditorPane, type EditorController } from './editor.js'
import { TablePane, type TablePanelController } from './table-panel.js'
import { SessionBar, type SessionBarController } from './session-bar.js'
import { SessionSelector, type SessionSelectorController } from './session-selector.js'
import { RoomChip, type RoomChipController } from './room-chip.js'
import { SliderPanel, type SliderPanelController } from './slider-panel.js'
import { PaneDivider } from './pane-divider.js'
import { Icon } from './icon.js'
import type { Row } from '../lineage.js'
import type { StripOutTrack } from './timeline-strip.js'

export interface AppProps {
  editor: EditorController
  tablePanel: TablePanelController
  sessionBar: SessionBarController
  sessionSelector: SessionSelectorController
  roomChip: RoomChipController
  sliderPanel: SliderPanelController
  playback: Accessor<PlaybackController | null>
  // The applied cook's timeline rows, for the strip's coverage shading —
  // the "applied" half of the live/applied split (see playback's vs/engine).
  timelineRows: Accessor<Row[]>
  // The applied cook's out views, one read-only strip track per consumer —
  // refreshed by applyCooked alongside timelineRows. The transport widens
  // when any exist (DAW-style multi-track needs the room).
  outTracks: Accessor<StripOutTrack[]>
  onClearRuns: () => void
  // A timeline-strip drag just committed its one store.setRow — re-run so
  // the drop applies immediately instead of sitting pending (see main.ts's
  // evaluate()).
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
  // Minimized transport: collapse the whole playback panel (controls + timeline
  // strip) to a corner icon so the visual output isn't obscured.
  const [playbackMinimized, setPlaybackMinimized] = createSignal(false)
  return (
    <>
      <div id="canvas-pane" ref={(el) => (props.mounts.canvasPane = el)}>
        <canvas id="three-canvas" ref={(el) => (props.mounts.threeCanvas = el)} />
        <canvas id="hydra-canvas" ref={(el) => (props.mounts.hydraCanvas = el)} />
        <canvas id="bauble-canvas" ref={(el) => (props.mounts.baubleCanvas = el)} />
        <SliderPanel ctl={props.sliderPanel} />
        <div id="playback-controls" classList={{ minimized: playbackMinimized(), 'has-tracks': props.outTracks().length > 0 }}>
          <Show when={props.playback()}>
            {(p) => (
              <PlaybackControls
                vs={p().vs}
                minimized={playbackMinimized}
                onToggleMinimize={() => setPlaybackMinimized((m) => !m)}
                engine={p().engine}
                tapControl={p().tapControl}
                timelineRows={props.timelineRows}
                store={props.tablePanel.store}
                currentTable={props.tablePanel.current}
                onSelectRow={(table, row) => props.tablePanel.focusRow(table, row)}
                presence={props.tablePanel.presence}
                focusedRow={() => {
                  const fr = props.tablePanel.focusedRow()
                  return fr && fr.table === props.tablePanel.current() ? fr.row : null
                }}
                onStripRowChange={(row) => props.tablePanel.setStripRow(row)}
                onDragCommit={props.onDragCommit}
                outTracks={props.outTracks}
                onSelectTrack={(view) => props.tablePanel.selectTable(view)}
              />
            )}
          </Show>
        </div>
      </div>
      <div id="side-panels" ref={sidePanels}>
        <EditorPane ctl={props.editor} currentTable={props.tablePanel.current}>
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
        </EditorPane>
        <PaneDivider container={() => sidePanels} tablePane={() => tablePane} />
        <TablePane ctl={props.tablePanel} ref={(el) => (tablePane = el)} />
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
