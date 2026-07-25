// Transport controls — the humble view over the playback engine
// (../playback.ts): renders PlaybackViewState verbatim and forwards every
// interaction to an engine method (or the TapControl); no playback logic
// lives here.

import { createSignal, Show, type Accessor } from 'solid-js'
import { Icon } from './icon.js'
import { createPlaybackEngine } from '../playback.js'
import type { PlaybackEngine, PlaybackOptions, PlaybackViewState, TapControl } from '../playback.js'
import { DEFAULT_LOOP_BEATS } from '../constants.js'
import type { Visualizer } from '../visualizer.js'
import { TimelineStrip, type StripOutTrack } from './timeline-strip.js'
import type { Row } from '../lineage.js'
import type { EditableTableStore } from '../editable-tables.js'
import type { PeerPresence } from '../table-panel.js'

export function PlaybackControls(props: {
  vs: Accessor<PlaybackViewState>
  engine: PlaybackEngine
  tapControl?: TapControl
  timelineRows?: Accessor<Row[]>
  store: EditableTableStore
  currentTable: Accessor<string | null>
  onSelectRow?: (table: string, row: number | null) => void
  presence: Accessor<PeerPresence[]>
  focusedRow: Accessor<number | null>
  onStripRowChange?: (row: { table: string; row: number } | null) => void
  onDragCommit?: () => void
  outTracks?: Accessor<StripOutTrack[]>
  onSelectTrack?: (view: string) => void
  // Collapsed to a corner icon when true — the whole transport hides so the
  // visual output is unobscured; the restore icon toggles it back.
  minimized: Accessor<boolean>
  onToggleMinimize: () => void
}) {
  const vs = props.vs
  const playing = () => vs().state === 'playing'
  const timeText = () => {
    const { pos, srcBeat, timelineActive } = vs()
    return timelineActive ? `${(pos + 1).toFixed(2)}→${srcBeat.toFixed(2)} beat` : `beat ${srcBeat.toFixed(2)}`
  }

  // The transport stays mounted and is hidden with CSS when minimized (see
  // #playback-controls.minimized) — the TimelineStrip's store.onChange
  // subscription has no unsubscribe (it assumes one mount for the app's
  // lifetime), so it must never be torn down here.
  return (
    <>
      <Show when={props.minimized()}>
        <button
          class="pb-restore-btn"
          title="Show playback controls"
          aria-label="Show playback controls"
          onClick={props.onToggleMinimize}
        >
          <Icon name="sliders" size={18} />
        </button>
      </Show>
      <div class="playback-row">
        <button
          id="play-pause-btn"
          title={playing() ? 'Pause' : 'Play'}
          aria-label={playing() ? 'Pause' : 'Play'}
          onClick={() => props.engine.toggle()}
        >
          <Icon name={playing() ? 'pause' : 'play'} />
        </button>
        <button
          id="loop-btn"
          classList={{ active: vs().loop }}
          title="Loop playback"
          aria-label="Loop playback"
          onClick={() => props.engine.setLoop(!vs().loop)}
        >
          ↻
        </button>
        <label class="loop-len" title="Loop length in beats">
          <input
            id="loop-beats"
            type="number"
            min="1"
            step="1"
            value={String(vs().loopBeats)}
            onChange={(e) => {
              const el = e.currentTarget
              const n = Math.max(1, Math.round(parseFloat(el.value) || DEFAULT_LOOP_BEATS))
              // Snap the field to the clamped value: when n equals loopBeats
              // nothing reactive would overwrite a rejected entry like "0".
              el.value = String(n)
              props.engine.setLoopBeats(n)
            }}
          />
          <span>beats</span>
        </label>
        <span id="playback-time">{timeText()}</span>
        <button
          class="pb-minimize-btn"
          title="Minimize the transport"
          aria-label="Minimize the transport"
          onClick={props.onToggleMinimize}
        >
          <Icon name="chevron-down" />
        </button>
      </div>
      <Show when={props.tapControl}>
        {(tap) => (
          <div class="playback-row tap-row">
            <button
              id="tap-beat-btn"
              title="Tap a beat to set the tempo — the whole loop plays at it"
              onClick={() => tap().tap()}
            >
              Tap
            </button>
            <span id="tap-bpm">{`${vs().bpm != null ? vs().bpm!.toFixed(1) : 120} BPM`}</span>
            <button id="tap-clear-btn" title="Clear taps" aria-label="Clear taps" onClick={() => tap().clear()}>
              <Icon name="trash-2" />
            </button>
          </div>
        )}
      </Show>
      <TimelineStrip
        vs={vs}
        timelineRows={props.timelineRows ?? (() => [])}
        store={props.store}
        currentTable={props.currentTable}
        onSelectRow={props.onSelectRow}
        presence={props.presence}
        focusedRow={props.focusedRow}
        onStripRowChange={props.onStripRowChange}
        onDragCommit={props.onDragCommit}
        outTracks={props.outTracks}
        onSelectTrack={props.onSelectTrack}
      />
    </>
  )
}

export interface PlaybackController {
  engine: PlaybackEngine
  vs: Accessor<PlaybackViewState>
  tapControl?: TapControl
}

export function createPlaybackController(
  visualizers: Visualizer[],
  options: PlaybackOptions = {},
): PlaybackController {
  const [vs, setVs] = createSignal<PlaybackViewState | null>(null)
  const engine = createPlaybackEngine(visualizers, { ...options, onViewChange: setVs })
  if (vs() == null) setVs(engine.viewState())
  return { engine, vs: () => vs()!, tapControl: options.tapControl }
}
