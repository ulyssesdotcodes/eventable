// Transport controls — the humble view over the playback engine
// (../playback.ts): renders PlaybackViewState verbatim and forwards every
// interaction to an engine method (or the TapControl); no playback logic
// lives here. It sits as the top row of the timeline pane
// (ui/timeline-pane.tsx), which owns the section bands beneath it.

import { createSignal, Show, type Accessor } from 'solid-js'
import { Icon } from './icon.js'
import { createPlaybackEngine } from '../playback.js'
import type { PlaybackEngine, PlaybackOptions, PlaybackViewState, TapControl } from '../playback.js'
import { DEFAULT_LOOP_BEATS } from '../constants.js'
import type { Visualizer } from '../visualizer.js'

export function Transport(props: {
  vs: Accessor<PlaybackViewState>
  engine: PlaybackEngine
  tapControl?: TapControl
}) {
  const vs = props.vs
  const playing = () => vs().state === 'playing'
  const timeText = () => {
    const { pos, srcBeat, timelineActive } = vs()
    return timelineActive ? `${(pos + 1).toFixed(2)}→${srcBeat.toFixed(2)} beat` : `beat ${srcBeat.toFixed(2)}`
  }

  return (
    <>
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
      </div>
      <Show when={props.tapControl}>
        {(tap) => (
          <div class="playback-row">
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
