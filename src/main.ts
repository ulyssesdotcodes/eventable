import './style.css'
import { createSignal, createMemo, createRoot } from 'solid-js'
import { initThree } from './three-scene.js'
import { initHydra } from './hydra-scene.js'
import { isHydraRow, hydraCodeUpToRow } from './hydra.js'
import { isBaubleRow } from './bauble.js'
import { isPostRow, postCodeUpToRow } from './post.js'
import { particleRows, hasSpawner, particleParamsAt, type ParticleParamName } from './particles.js'
import { initBauble } from './bauble-scene.js'
import { initPost } from './post-scene.js'
import { createSceneVisualizer, createHydraVisualizer, createBaubleVisualizer, createPostVisualizer } from './visualizer.js'
import type { PassState, VisualizerKind } from './visualizer.js'
import { sectionsFor, type TimelineSection } from './timeline-sections.js'
import { mountApp } from './ui/app.js'
import { createCmEditor } from './ui/cm-editor.js'
import { createEditorHost, type EditTarget } from './editor-host.js'
import { defaultProgram, defaultTables, defaultTable, programText } from './editor-support.js'
import { createTablePanel } from './ui/table-panel.js'
import { EVENTS_SUFFIX } from './table-panel.js'
import { createPlaybackController, type PlaybackController } from './ui/transport.js'
import { createSessionBar } from './ui/session-bar.js'
import { createSessionSelector } from './ui/session-selector.js'
import { createRoomChip } from './ui/room-chip.js'
import { SAMPLES, sampleIndexForSlug, slugify, serializeSample, parseSample, type Sample } from './samples.js'
import { defaultSessionStore } from './sessions.js'
import { getVimMode, setVimMode, getMidiEnabled, setMidiEnabled, getUsername, setUsername } from './settings.js'
import { createCookClient } from './cook-client.js'
import type { CookedResult } from './replay.js'
import { randomSeed, localSource, type LogStore } from './event-log.js'
import { createPresenceChannel, userColor, lastCellEdits } from './presence.js'
import { Table, outViewName } from './dsl.js'
import { createEditableTableStore, defaultFor, DISABLED_COL, CLEAR_RUNS_KIND, ACTIVITY_TABLE, isExprCellText, type ColumnType, type CodeLanguage, type EditableColumn, type SessionRun } from './editable-tables.js'
import { APPLY_KIND, type ApplyNode } from './branches.js'
import { createMidiInput, subscribeWebMidi, type MidiInput } from './midi.js'
import { createSliderInput, sliderDefs, type SliderInput } from './sliders.js'
import { createSliderPanel } from './ui/slider-panel.js'
import { beatToFrame, DEFAULT_LOOP_BEATS } from './constants.js'
import { createTapLog } from './tap-log.js'
import { connectMultiplayer } from './multiplayer.js'
import type { MultiplayerConnection, MultiplayerStatus } from './multiplayer.js'
import { PRESENCE_LOG } from './room-core.js'
import { loopEpochsFromApplies, loopBeatsFromEvents, pausedMsBefore, transportStateFromEvents, playbackOrigin } from './playback.js'
import type { PlaybackAPI, PlaybackOptions } from './playback.js'
import { getLineage, type Row } from './lineage.js'
import type { PeerPresence } from './ui/table-panel.js'

const dataCache = new Map<string, string>()
const editableStore = createEditableTableStore()

// The program is itself an editable table "code", one fragment per row (see
// programText); "code·events" *is* the run history, and a session is just the
// store's serialized events — see sessions.ts. The seed rides the apply record
// instead of a column, so every fragment row isn't stuck carrying a dead one.
const CODE_SCHEMA: Record<string, ColumnType> = { code: 'code' }

const codeRows = (): Row[] => editableStore.get('code')?.rows ?? []
const currentProgram = (): string => programText(codeRows())

// Facade edits write their own cell, so this only has to seed a store with no
// program yet (a fresh session, an example, a session/room load) — and skip
// identical writes, or an unchanged re-Apply spams "code·events".
function setProgram(code: string): void {
  const rows = editableStore.get('code')?.rows
  if (!rows) {
    editableStore.ensure('code', CODE_SCHEMA, [{ code }])
    return
  }
  if (programText(rows) === code) return
  // A program arriving whole replaces every fragment: writing it into row 0
  // alone would leave the later rows duplicated onto the end of it.
  for (let i = rows.length - 1; i > 0; i--) editableStore.removeRow('code', i)
  editableStore.setRow('code', 0, { code })
}

// The seed an apply ran with, with the legacy code-row `seed` cell as the
// fallback for sessions recorded before the column moved onto the apply.
function seedAt(applyId: string | null, rows: Row[]): number {
  if (applyId != null) {
    for (const e of editableStore.log.all()) {
      if (e.kind === APPLY_KIND && e.id === applyId && typeof e.seed === 'number') return e.seed
    }
  }
  const legacy = rows[0]?.seed
  return typeof legacy === 'number' ? legacy : 0
}

// Net room membership per the "activity" table's peer-join/leave history
// (server-authored; rides the same store log as any editable table). Includes
// this replica once its own peer-join round-trips back from the server.
function onlinePeers(): Set<string> {
  const online = new Set<string>()
  for (const e of editableStore.get(ACTIVITY_TABLE)?.events ?? []) {
    const client = e.client as string | undefined
    if (!client) continue
    if (e.kind === 'peer-join') online.add(client)
    else if (e.kind === 'peer-leave') online.delete(client)
  }
  return online
}

// --- multiplayer identity & presence ----------------------------------------
// Room and display name ride the URL so a reload rejoins as the same person.
// Presence rides its own synced log (presence.ts), deliberately separate from
// the store log so cursor chatter never lands in the persisted session.
const urlParams = new URLSearchParams(location.search)
const roomName = urlParams.get('room')
const userName = (urlParams.get('user') ?? '').trim() || getUsername()
if (roomName && (urlParams.get('user') ?? '').trim()) setUsername(userName)

// An example can be deep-linked (?example=<slug>, see samples.ts's slugify)
// so a shared link opens straight to that example rather than the default
// program; only consulted on boot when there's no room to join instead.
const exampleSlug = urlParams.get('example')

const presence = roomName ? createPresenceChannel({ user: userName }) : null

const peerLabel = (client: string, user: string): string => user || client.slice(0, 6)
const peerColor = (client: string, user: string): string => userColor(user || client)

// The session bar's scrub range; a legacy session with no apply nodes falls
// back to its linear run list.
function sessionLength(): number {
  return editableStore.currentHead() === null
    ? editableStore.runs().length
    : editableStore.branchPath().length
}

function extractDataUrls(code: string): string[] {
  const urls: string[] = []
  for (const m of code.matchAll(/\bdata\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) urls.push(m[1])
  return urls
}

// Assigned once the app has mounted (it needs the canvas-backed scene APIs);
// only touched from callbacks that fire after this module finishes evaluating.
let playback: PlaybackAPI

// The table tab currently shown — mirrored from the panel's onSelectTable so
// persistSession can record it, restoring the last-shown table on resume.
let currentTable: string | null = null

// The cell the one live CodeMirror is a window onto — peers' cursors are drawn
// only when on this same cell (see refreshPresenceUI).
let localCell = ''

// The promoted hydra/post cell, previewed behind its own code as you type (see
// EditTarget.preview): the uncommitted text goes back into its table and folds
// like any other row, so a fragment cell (an `add` chunk) previews as the
// running sketch it joins — the same fold the row's ⓘ popover shows.
let preview: { lang: 'hydra' | 'post'; fold: (text: string) => string | null; text: string } | null = null
// A keystroke must not reach the GPU: each change recompiles a sketch (hydra)
// or a whole TSL pipeline (post).
const PREVIEW_DEBOUNCE_MS = 150
let previewTimer: ReturnType<typeof setTimeout> | undefined

const previewCode = (lang: 'hydra' | 'post'): string | null =>
  preview?.lang === lang ? preview.fold(preview.text) : null

// THE one editor: a detached CodeMirror the host reparents into whichever
// facade/overlay currently owns editing (ui/facade.tsx). No docked pane, no
// single program buffer.
const cm = createCmEditor({
  getViews: () => lastViews,
  onCaretView: (name) => tablePanel.selectTable(name),
  getPlayIndex: () => currentPlayIndex,
  vimMode: getVimMode(),
  onCursor: (cell, head) => {
    const cellChanged = cell !== localCell
    localCell = cell
    presence?.set({ cell, head })
    // Switching cells changes which remote cursors are visible *here*; plain
    // cursor moves only change what peers see of us.
    if (cellChanged) schedulePresenceRefresh()
  },
  // Announce the in-progress buffer (throttled in presence.ts) so peers can
  // mirror it before it is ever Run, and feed the same text to the preview
  // behind the code.
  onEdit: (cell, code) => {
    presence?.setLiveCode(cell, code)
    const target = preview
    if (!target) return
    clearTimeout(previewTimer)
    // Writes to the captured target, so a late timer after a demote lands on
    // the object nothing reads any more.
    previewTimer = setTimeout(() => { target.text = code; playback.refresh() }, PREVIEW_DEBOUNCE_MS)
  },
})
// Escaping a facade hands keyboard focus back to the table it came from.
const host = createEditorHost(cm, {
  onPromote: (t) => {
    preview = t.preview && (t.lang === 'hydra' || t.lang === 'post')
      ? { lang: t.lang, fold: t.preview, text: t.text }
      : null
    // Promotion is what puts a preview on screen, and a paused playhead draws
    // no frames of its own — so it needs this nudge to appear.
    playback.refresh()
  },
  onDemote: () => {
    preview = null
    tablePanel.focusGrid()
  },
})

// Errors land on the promoted target (its facade shows them inline); with
// nothing promoted they land under the empty label, which is the table pane's
// own error strip.
const setError = (msg: string | null): void => host.setError(msg)

// Which language service a code-bearing cell edits in: the column's declared
// language wins (the only signal that survives rows being mapped into views);
// older tables fall back to sniffing the row — bauble rows share hydra's shape
// but hold Janet.
function cellLanguage(table: string, row: Row | undefined, col: EditableColumn | undefined, value: string): CodeLanguage {
  if (col?.type === 'code' && col.language) return col.language
  if (col?.type === 'number' && isExprCellText(value)) return 'expr'
  if (col?.name !== 'code') return 'dsl'
  if (table === 'bauble' && isBaubleRow(row)) return 'bauble'
  if (table === 'post' && isPostRow(row)) return 'post'
  if (isHydraRow(row)) return 'hydra'
  return 'dsl'
}

// The buffer behind one code-bearing (or "=") cell. The table pane builds its
// facades, expression overlay and mobile popover from these; committing one
// re-cooks at the *current* seed, so tweaking a sketch never re-randomizes the
// scene. A "code" row is a program fragment, so its commit re-joins the whole
// table (see programText) instead of re-running the last cooked text.
function cellTarget(table: string, rowIndex: number, col: string, value: string): EditTarget {
  const data = editableStore.get(table)
  const colSpec = data?.columns.find((c) => c.name === col)
  const label = `${table}[${rowIndex}].${col}`
  // The cell's text when this buffer was opened, and the only evidence at
  // commit time that `rowIndex` still means the same row: a sibling row's
  // insert/delete (locally, or merged from a peer) splices the array under a
  // still-open editor, and a merge or scrub refolds it wholesale, so the row
  // objects can't be held onto either. Advanced by each commit, so applying
  // twice in a row still works.
  let baseline = value
  const lang = cellLanguage(table, data?.rows[rowIndex], colSpec, value)
  return {
    label,
    lang,
    text: value,
    // Only hydra and post have something to draw; the fold is the one the row's
    // ⓘ popover shows, with the pending text spliced back into its row.
    preview: lang !== 'hydra' && lang !== 'post' ? undefined : (text) => {
      const rows = editableStore.get(table)?.rows
      if (!rows) return null
      const edited = rows.map((r, i) => (i === rowIndex ? { ...r, [col]: text } : r))
      return (lang === 'post' ? postCodeUpToRow : hydraCodeUpToRow)(edited, rowIndex)
    },
    onCommit: (text) => {
      // A number column reached through the expression overlay: plain numeric
      // (or blank) text goes back to a number/blank, so deleting the formula
      // doesn't strand a string in a number column. The "=" marker itself is
      // the overlay's business (see ui/facade.tsx).
      const trimmed = text.trim()
      const stored = colSpec?.type !== 'number' ? text
        : trimmed === '' ? ''
          : Number.isFinite(Number(trimmed)) ? Number(trimmed) : text
      const liveRow = editableStore.get(table)?.rows[rowIndex]
      if (!liveRow || String(liveRow[col] ?? '') !== baseline) {
        host.setError(`${label} changed underneath this edit — it was not applied`, label)
        return
      }
      editableStore.setCell(table, rowIndex, col, stored)
      baseline = String(stored ?? '')
      const code = table === 'code' ? currentProgram() : liveCode
      // Bind the label now: the cook is a worker round-trip, and whatever is
      // promoted when it resolves may be a different cell entirely.
      if (code != null) void evaluate(code, { setError: (msg) => host.setError(msg, label), seed: liveSeed })
    },
  }
}

const tablePanel = createTablePanel(editableStore, {
  host,
  targetFor: cellTarget,
  loopBeats: () => loopBeatsFromEvents(editableStore.get(ACTIVITY_TABLE)?.events ?? []) ?? DEFAULT_LOOP_BEATS,
  onCtrlEnter: () => {
    // Ctrl-Enter from the grid runs whatever is promoted; with nothing
    // promoted it is still "Run the program".
    if (host.promoted()) host.commit()
    else void evaluate(currentProgram(), { setError, seed: liveSeed })
  },
  onSelectTable: (name) => {
    // Remember the shown tab so a save records it and a resume reopens on it
    // (see persistSession / openSession).
    currentTable = name
    presence?.set({ table: name })
    schedulePresenceRefresh()
  },
})

// Taps are stamped with wall-clock time (tap-log.ts), letting playback anchor
// "beat 0" to the tap rather than to when Play was pressed — which keeps
// independently-started (or multiplayer-synced) clients in phase. Absent a
// tap, playbackOrigin falls back to the room's/session's own origin (see
// playback.ts) rather than the engine's raw Unix-epoch default.
const tapLog = createTapLog()
const tapRows = (): Row[] => tapLog.rows()
const tapAnchor = (): number | null =>
  playbackOrigin(editableStore.get(ACTIVITY_TABLE)?.events ?? [], tapLog.anchor())

function recordTap(): void {
  tapLog.tap()
  onTap()
}

function clearTaps(): void {
  if (!tapLog.rows().length) return
  tapLog.clear()
  onTap()
}

let currentPlayIndex = 0

// Whether the reset button's rewind is armed; stepping happens in onTick every
// REWIND_STEP_BEATS of playhead beats.
let rewinding = false
const REWIND_STEP_BEATS = 2
// Last reported playhead beat — kept live regardless of rewinding so arming
// steps from "now", not from 0.
let lastTick = 0
// Beat the baseline was last reset to; stepRewind fires once tick advances
// REWIND_STEP_BEATS past it. A loop wrap just re-bases here — worst case that
// delays one step by less than a loop.
let rewindBaseline = 0
let midiEnabled = getMidiEnabled()

const logTableStore = (table: string): LogStore => ({
  record: (kind, payload) => editableStore.record(table, kind, payload),
  events: () => editableStore.log.all().filter((e) => e.table === table),
  onChange: (cb) => editableStore.onChange(cb),
})

const midiStore = logTableStore('midi')

let loopCount = 0

const midiInput: MidiInput = createMidiInput({
  store: midiStore,
  getIndex: () => playback.currentSourceBeats(),
  getLoop: () => loopCount,
})

let midiSubscribed = false
function ensureMidiSubscription(): void {
  if (midiSubscribed) return
  midiSubscribed = true
  subscribeWebMidi(midiInput)
}

if (midiEnabled) ensureMidiSubscription()

// On-screen sliders: the twin of MIDI, defined by the program's "sliders"
// view. Moves are ordinary "slider" store events, so they sync and persist
// like any table; with no browser permission to request, the input is created
// the moment a program defines a slider.
const sliderStore = logTableStore('slider')

let sliderInput: SliderInput | null = null

function ensureSliderInput(): SliderInput {
  if (!sliderInput) {
    sliderInput = createSliderInput({
      store: sliderStore,
      getIndex: () => playback.currentSourceBeats(),
    })
  }
  return sliderInput
}

// The slider overlay. Recording through the store means the generic onChange
// handler already refreshes the tables and persists — no separate refresh.
// The callbacks only fire on user interaction, well after `playback` lands.
const sliderPanel = createSliderPanel({
  onGrab: (id) => ensureSliderInput().beginRecord(id),
  onInput: (id, value) => ensureSliderInput().setLive(id, value),
  // Release doesn't end the take: the recording window stays open, holding the
  // last value, until the playhead sweeps a full cycle back to the grab beat
  // (see recordTick in onTick). That's what lets a motion cross the loop seam.
  onRelease: () => {},
})

// Push slider definitions to the overlay and input on every cook. Prefer the
// cooked "sliders" view, but fall back to the store so a table created by hand
// in the table panel (never surfaced as a view) still drives the sliders.
function updateSliderDefs(views: Map<string, Table>): void {
  // The cooked view already reflects ensure()'s disabled-row filtering; the
  // raw fallback needs it applied here.
  const rows = views.get('sliders')?.rows ?? (editableStore.get('sliders')?.rows ?? []).filter((r) => r[DISABLED_COL] !== true)
  const defs = sliderDefs(rows)
  sliderPanel.setDefs(defs)
  if (defs.length) ensureSliderInput().setDefs(defs)
  else sliderInput?.setDefs(defs)
}

const [playbackCtl, setPlaybackCtl] = createSignal<PlaybackController | null>(null)
// The applied cook's timeline rows, for the timeline strip's coverage shading
// — refreshed on every applyCooked, same cadence as the panel's tables.
const [timelineRows, setTimelineRows] = createSignal<Row[]>([])
// The applied cook, for the timeline pane's bands — the same row arrays
// playback consumes, so a band's events can't disagree with what will happen.
// Refreshed on every applyCooked; changing a retime table and applying moves
// them.
const [applied, setApplied] = createSignal<{ cooked: CookedResult; particleRows: Row[] } | null>(null)
// Bumped once per coalesced store-change frame (see editableStore.onChange
// below) — the pane's live warp rows and recorded automation ride it.
const [storeTick, setStoreTick] = createSignal(0)

const EMPTY_PASSES: Partial<Record<VisualizerKind, PassState>> = {}
const passKey = (p: Partial<Record<VisualizerKind, PassState>>): string =>
  Object.entries(p).map(([k, v]) => `${k}${v?.pass}/${v?.loops}`).join(' ')

// The timeline pane's bands. One never-disposed root: these live as long as
// the app, and the passes memo exists to keep the section list off the
// per-frame path — vs() hands out a fresh `passes` object every animation
// frame, but only an actual pass advance may rebuild the bands.
const sections = createRoot(() => {
  const passes = createMemo<Partial<Record<VisualizerKind, PassState>>>(
    () => playbackCtl()?.vs().passes ?? EMPTY_PASSES,
    EMPTY_PASSES,
    { equals: (a, b) => passKey(a) === passKey(b) },
  )
  return createMemo<TimelineSection[]>(() => {
    const a = applied()
    storeTick()
    if (!a) return []
    return sectionsFor({
      cooked: a.cooked,
      particleRows: a.particleRows,
      timelineRows: editableStore.get('timeline')?.rows ?? [],
      sliderRows: sliderInput?.rows() ?? [],
      // One trace per note+channel: the folded rows key by `note` alone, so
      // the same note arriving on two channels would merge into one trace.
      midiRows: midiInput.rows().map((r) => (r.channel == null ? r : { ...r, note: `${r.note}·ch${r.channel}` })),
      passes: passes(),
    })
  })
})
const playbackOptions: PlaybackOptions = {
  onTick: (tick, active, srcBeats) => {
    currentPlayIndex = srcBeats
    tablePanel.highlightIndex(srcBeats)
    tablePanel.highlightLineage(active)
    // Drive the GPU particle clock off the playhead so the sim steps with
    // play/pause/scrub (onTick fires on play frames and scrubs, not while
    // paused — so a held playhead freezes it). No-op off the WebGPU backend.
    sceneAPI.setParticleTime(srcBeats)
    // Advance any open slider recording window before reading values, so a take
    // that completes its cycle this tick starts replaying immediately.
    sliderInput?.recordTick(srcBeats)
    // Show recorded automation on the slider thumbs (skipping any being
    // dragged — see SliderPanel).
    const sliderVals = sliderInput && sliderInput.defs().length
      ? sliderInput.valuesAt(beatToFrame(srcBeats)) : null
    if (sliderVals) sliderPanel.showValues(sliderVals)
    // Particle params: the particles table's `set` rows fold at the playhead;
    // a slider named "particles" (if defined) rides on top as a live speed
    // override. (Enabling/disabling the sim happens at apply — applyCooked.)
    for (const [name, value] of Object.entries(particleParamsAt(particleTableRows, beatToFrame(srcBeats)))) {
      sceneAPI.setParticleParam(name as ParticleParamName, value)
    }
    if (sliderVals && 'particles' in sliderVals) {
      sceneAPI.setParticleParam('speed', sliderVals.particles)
    }
    lastTick = tick
    if (rewinding) {
      if (tick < rewindBaseline) rewindBaseline = tick
      else if (tick - rewindBaseline >= REWIND_STEP_BEATS) {
        rewindBaseline += REWIND_STEP_BEATS
        stepRewind()
      }
    }
  },
  onPlay: () => {
    tablePanel.resetAutoscroll()
    recordTransport('playback-play')
  },
  onPause: () => recordTransport('playback-pause'),
  onLoop: () => { loopCount++ },
  tapControl: { tap: recordTap, clear: clearTaps, rows: tapRows, anchor: tapAnchor },
  // Not gated on the local hardware toggle: the recording may be a peer's or
  // a saved session's.
  midiCtxAt: (srcFrame) => midiInput.ctxAt(srcFrame),
  sliderCtxAt: (srcFrame) => (sliderInput && sliderInput.defs().length ? sliderInput.ctxAt(srcFrame) : null),
  onLoopBeats: (n) => recordLoopBeats(n),
  pausedMsBefore: (wallMs) => pausedMsBefore(editableStore.get(ACTIVITY_TABLE)?.events ?? [], wallMs),
}

// The loop length rides the activity table so it syncs, persists, and replays
// like any other session state. The guard stops a value we just folded back
// out of the table (a session load, a peer's change) from echoing a duplicate.
function recordLoopBeats(n: number): void {
  if (loopBeatsFromEvents(editableStore.get(ACTIVITY_TABLE)?.events ?? []) === n) return
  editableStore.record(ACTIVITY_TABLE, 'set-loop-beats', { beats: n, at: Date.now() })
}

// Play/pause ride the activity table so they sync, persist and replay. Only a
// genuine local toggle records: a programmatic transition (boot autoplay,
// mirroring a peer) would stamp a 'play' over the room's paused state. Null (no
// events yet) deliberately isn't a match, so a session's first toggle records.
let transportQuiet = false
function quietTransport(fn: () => void): void {
  transportQuiet = true
  try { fn() } finally { transportQuiet = false }
}
function recordTransport(kind: 'playback-play' | 'playback-pause'): void {
  if (transportQuiet) return
  const events = editableStore.get(ACTIVITY_TABLE)?.events ?? []
  const wants = kind === 'playback-play' ? 'playing' : 'paused'
  if (transportStateFromEvents(events) === wants) return
  editableStore.record(ACTIVITY_TABLE, kind, { at: Date.now() })
}

// The cook runs in a Web Worker (cook-worker.ts) so a heavy Apply never blocks
// this thread; Jolt's WASM loads there too. The store stays here — each cook
// request carries a rows snapshot, and editable() declarations come back as
// data that the real ensure() below turns into store events.
const cookClient = createCookClient(new Worker(new URL('cook-worker.js', import.meta.url), { type: 'module' }))

async function cookInWorker(code: string, seed: number, seeds?: Record<string, Row[]>, declareSliders = true): Promise<{ cooked: CookedResult; declaredNames: string[] }> {
  const editables = editableStore.listNames().map((name) => ({
    name,
    // Match ensure()'s filtering: disabled rows stay in the table but are
    // hidden from the program.
    rows: (editableStore.get(name)?.rows ?? []).filter((r) => r[DISABLED_COL] !== true),
  }))
  // The two streams every session has — guaranteed present even before their
  // first event lands (a fresh session's first cook runs before its apply is
  // recorded), so a program can always rely on table("activity") and
  // table("code·events") resolving.
  const logs = logTables()
  for (const name of [ACTIVITY_TABLE, 'code' + EVENTS_SUFFIX]) {
    if (!logs.some((l) => l.name === name)) logs.push({ name, rows: [] })
  }
  const { cooked, declared, sliders } = await cookClient.cook({ code, seed, dataCache, tapRows: tapRows(), editables, seeds, logs })
  for (const d of declared) editableStore.ensure(d.name, d.schema, d.seedRows)
  // Every run of ours logs its slider declarations (the stream is the record
  // of what happened); a reactive re-cook of a peer's run declares nothing —
  // the author's own events arrive by merge.
  if (declareSliders) for (const s of sliders) editableStore.defineSlider(s.id, s.min, s.max)
  const declaredNames = declared.map((d) => d.name)
  // Every cook path funnels through here — apply, scrub/restore, reactive — so
  // this is the one place that always tracks the on-screen program's editable()
  // tables, the set an export carries as its Sample `tables`. Setting it only in
  // evaluate() left it empty after a reload (firstRun resumes via scrubSession),
  // so exports dropped all table data.
  lastDeclaredNames = declaredNames
  return { cooked, declaredNames }
}

const sessionStore = defaultSessionStore()
let currentSessionId = sessionStore.newId()

// --- multiplayer -----------------------------------------------------------
// A room (?room=x) syncs the whole store log over a WebSocket (multiplayer.ts).
// The log is also persisted locally under a stable session id, so rejoining
// resumes the jam even before the server answers.
let multiplayer: MultiplayerConnection | null = null

const roomSessionId = (room: string): string => 'room:' + room

// The app server carries the room socket at /ws; ?server= overrides for dev
// setups where the page comes from esbuild.
function multiplayerUrl(): string {
  const override = urlParams.get('server')
  if (override) return override
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'
}

// The room's log is restored in boot() (the session store is async) — only
// the id needs pinning before anything could save under it.
if (roomName) currentSessionId = roomSessionId(roomName)

let lastViews = new Map<string, Table>()
// The current program's particle-control rows (see src/particles.ts), folded
// per tick; refreshed on every applyCooked.
let particleTableRows: Row[] = []
// The program + seed on screen — possibly a scrubbed historical run, not
// "code"'s latest row — so a tap can re-cook in place.
let liveCode: string | null = null
let liveSeed = 0
// The editable() tables the on-screen program declares — kept current by every
// cook (see cookInWorker), so an export carries their rows as its Sample
// `tables` even right after a reload.
let lastDeclaredNames: string[] = []

// The streaming log tables, under the names their panel tabs wear: the
// midi/slider folds and event logs, and every editable table's "name·events"
// history (a log table shows under its bare name instead — see isLog). The one
// list behind both surfaces of a log: the panel tab you watch (tablesForDisplay)
// and the table() name a program reads (each cook request carries this snapshot
// — see cookInWorker / CookRequest.logs) — so what you can see is exactly what
// a sketch can use as data.
function logTables(): Array<{ name: string; rows: Row[] }> {
  const logs: Array<{ name: string; rows: Row[] }> = []
  // Folded MIDI take + raw log, once anything has been recorded — locally, by
  // a peer, or in the loaded session.
  const midiRows = midiInput.rows()
  if (midiRows.length) {
    logs.push({ name: 'midi', rows: midiRows })
    logs.push({ name: 'midi' + EVENTS_SUFFIX, rows: midiInput.eventRows() })
  }
  // Folded slider automation + raw log, only once something is recorded — an
  // empty pair just clutters the panel and can't be deleted, being synthetic.
  // ("sliders" itself is the definitions table, shown like any other view.)
  const sliderRows = sliderInput?.rows() ?? []
  if (sliderRows.length) {
    logs.push({ name: 'slider', rows: sliderRows })
    logs.push({ name: 'slider' + EVENTS_SUFFIX, rows: sliderInput!.eventRows() })
  }
  for (const name of editableStore.listNames()) {
    // The "slider"/"midi" log tables back recorded automation — surfaced
    // (folded) above, or not at all.
    if (name === 'slider' || name === 'midi') continue
    const key = editableStore.isLog(name) ? name : name + EVENTS_SUFFIX
    logs.push({ name: key, rows: (editableStore.get(name)?.events ?? []).map((r) => ({ ...r })) })
  }
  return logs
}

// The views shown in the table panel, plus a live "taps" table of wall-time
// button presses and every streaming log table (see logTables). A log yields
// to a program view of the same name — except the recorded slider pair, which
// comes and goes with the take and always shows the recording.
function tablesForDisplay(views: Map<string, Table>): Map<string, Table> {
  const display = new Map(views)
  if (tapRows().length && !display.has('taps')) display.set('taps', new Table(tapRows()))
  for (const { name, rows } of logTables()) {
    const alwaysShow = name === 'slider' || name === 'slider' + EVENTS_SUFFIX
    if (!alwaysShow && display.has(name)) continue
    display.set(name, new Table(rows))
  }
  return display
}

const lastCookedSigs = { scene: '', timeline: '', hydra: '', bauble: '', post: '' }

// Which cooked outputs changed (re-baselining for the next diff) — stamped
// onto the apply pulse so the whole room resets the same multi-loop sequences.
// The worker stamps a graph-hash signature per output (see CookedSigs), so
// this never serializes the dense rows.
function diffCooked({ sigs }: CookedResult): { scene: boolean; timeline: boolean; hydra: boolean; bauble: boolean; post: boolean } {
  const changed = {
    scene: sigs.scene !== lastCookedSigs.scene,
    timeline: sigs.timeline !== lastCookedSigs.timeline,
    hydra: sigs.hydra !== lastCookedSigs.hydra,
    bauble: sigs.bauble !== lastCookedSigs.bauble,
    post: sigs.post !== lastCookedSigs.post,
  }
  Object.assign(lastCookedSigs, sigs)
  return changed
}

// The editable store row a cooked band's row came from, for the timeline
// pane's drag (see Handle.source). A lineage ref addresses the MATERIALIZED
// view — ensure()'s visibleRows, disabled rows excluded — while store.setRow
// takes a storage index, so the visible ordinal is counted back to one. Log
// tables and views with no store behind them yield nothing, and so stay
// read-only.
function resolveSource(row: Row): { table: string; row: number; beat: number } | undefined {
  for (const ref of getLineage(row)) {
    if (!editableStore.has(ref.table) || editableStore.isLog(ref.table)) continue
    const rows = editableStore.get(ref.table)?.rows ?? []
    let visible = -1
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][DISABLED_COL] === true) continue
      if (++visible !== ref.index) continue
      const beat = rows[i].beat
      return typeof beat === 'number' ? { table: ref.table, row: i, beat } : undefined
    }
  }
  return undefined
}

// Render a cooked program and hand its rows to playback. Loop epochs come from
// the activity table's apply stamps — the author's clock, NOT this replica's —
// so late joiners land on the same pass of a multi-loop sequence. The loop
// length folds from the same stream, so a session load or scrub restores it.
function applyCooked(cooked: CookedResult): void {
  lastViews = cooked.views
  // Before load(): load() fires onTick, which reads the slider input.
  updateSliderDefs(cooked.views)
  // GPU particles are opt-in per program: a "particles" view with a `spawn`
  // row turns the sim on; its `set` rows are folded from onTick.
  particleTableRows = particleRows((cooked.views.get(outViewName('particles')) ?? cooked.views.get('particles'))?.rows)
  sceneAPI.setParticlesEnabled(hasSpawner(particleTableRows))
  tablePanel.setTables(tablesForDisplay(cooked.views))
  tablePanel.setGraphs(cooked.graphs)
  setTimelineRows(cooked.timelineRows)
  setApplied({ cooked, particleRows: particleTableRows })
  // With hydra rows present, hydra's output is the display and it reads the
  // bauble render as s1 — only a bauble-only sketch shows this canvas directly.
  mounts.baubleCanvas.classList.toggle('visible', cooked.baubleRows.length > 0 && cooked.hydraRows.length === 0)
  const activityEvents = editableStore.get(ACTIVITY_TABLE)?.events ?? []
  const loopBeats = loopBeatsFromEvents(activityEvents)
  if (loopBeats != null) playback.setLoopBeats(loopBeats)
  playback.load({ ...cooked, loopEpochs: loopEpochsFromApplies(activityEvents) })
}

// A tap changed the tempo. Nothing re-cooks — content sits on a fixed beat
// grid; only the rate the playhead sweeps the loop changes.
function onTap(): void {
  tablePanel.setTables(tablesForDisplay(lastViews))
  playback.retempo()
}

function persistSession(): void {
  if (!editableStore.has('code')) return
  // Serialize the *head* log — a scrubbed replay view mustn't leak into the
  // save. Failed saves surface on the error strip; silent failure is exactly
  // how session data gets lost.
  void sessionStore.save(currentSessionId, {
    events: editableStore.serialize(),
    runs: editableStore.runs(),
    head: editableStore.currentHead(),
    table: currentTable,
    tables: [...lastViews.keys()],
  })
    .then(refreshSelector)
    .catch((err) => setError(`Session save failed: ${(err as Error).message}`))
}

function refreshSelector(): void {
  void sessionStore.list()
    .then((sessions) => sessionSelector.setSessions(sessions, currentSessionId))
    .catch(() => { /* listing is cosmetic — never block on it */ })
}

interface EvaluateOptions {
  setError?: ((msg: string | null) => void) | null
  // Off for the initial cook of a fresh session/example, which shouldn't be
  // saved until the user actually edits or runs.
  persist?: boolean
  seed?: number
  // Announce this apply on the "activity" table. Off for the multiplayer
  // reactive call — echoing someone else's pulse would round-trip forever.
  broadcast?: boolean
  // Drop the cooked result if the store's program changed mid-cook: a room
  // snapshot can merge in while firstRun's speculative cook of the default
  // program awaits the worker, and that default must not then win the fold
  // over the room's program.
  obsoleteIfProgramChanged?: boolean
  // Seed rows for editable tables the store hasn't seen yet (e.g. an example's
  // table data lives with the sample, not inline in the code). Only the first
  // cook of a fresh store uses them; an existing table's own rows win.
  seeds?: Record<string, Row[]>
}

// Held while a cook or our own store writes are in flight — reacting to our
// own changes would loop or double-cook. A counter, not a boolean: cooks
// await the worker, so two can overlap.
let cooking = 0

// Run `fn` with the self-change guard held. Used around session load/clear,
// which notify like any edit but are always followed by an explicit re-cook.
function quietly<T>(fn: () => T): T {
  cooking++
  try {
    return fn()
  } finally {
    cooking--
  }
}

// Apply a program: cook, record a run, render, persist. The *only* thing that
// applies pending table edits — inline edits accumulate until an apply.
async function evaluate(code: string, { setError, persist = true, seed = randomSeed(), broadcast = true, obsoleteIfProgramChanged = false, seeds }: EvaluateOptions = {}): Promise<void> {
  const pending = extractDataUrls(code).filter((u) => !dataCache.has(u))
  if (pending.length) {
    await Promise.all(pending.map(async (url) => {
      try {
        dataCache.set(url, await fetch(url).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.text()
        }))
      } catch (e) {
        setError?.(`Failed to fetch ${url}: ${(e as Error).message}`)
      }
    }))
  }

  stopRewind()
  cooking++
  try {
    // Applying while scrubbed back forks: promote the scrubbed branch to a
    // live head *now*, so the cook's appends land on it. A reactive evaluate
    // (broadcast:false) must not fork — it returns to the head the merge
    // already moved us to. At the live head both are no-ops.
    if (broadcast) editableStore.forkFromReplay()
    else editableStore.setReplayView(null)
    let cooked: CookedResult
    let declaredNames: string[]
    try {
      ({ cooked, declaredNames } = await cookInWorker(code, seed, seeds, broadcast))
    } catch (err) {
      setError?.((err as Error).message)
      return
    }
    // Compare the whole fragment snapshot, not one row — a partially
    // clobbered room is worse than either side winning outright.
    if (obsoleteIfProgramChanged && editableStore.has('code') && currentProgram() !== code) return
    setError?.(null)
    liveCode = code
    liveSeed = seed

    // Drop tables the program no longer declares editable(), so a computed
    // view of the same name (or nothing) takes over.
    editableStore.retainDeclared(declaredNames)

    // *Before* applyCooked renders the table panel, so its first render sees
    // "code" — the onChange reaction that would normally pick up a new table
    // is suppressed by `cooking` right now.
    setProgram(code)
    // recordApply commits every pending edit as the apply node that *is* the
    // run — BEFORE applyCooked, so the loop epochs it folds already include
    // this apply, re-basing this replica from the very stamp its peers will.
    // A reactive evaluate commits nothing: the author's apply is already
    // merged, and onMerge has already made it our head.
    const changed = diffCooked(cooked)
    if (broadcast) {
      const changedKinds = Object.keys(changed).filter((k) => changed[k as keyof typeof changed])
      // The seed rides the apply — the replay unit that scrubSession re-cooks
      // from. `lastCookedSigs` survives a store clear (new session, sample load,
      // scene import), so on a fresh log it would report nothing changed and
      // leave every visualizer on the old session's epoch; omitting `changed`
      // entirely is how loopEpochsFromApplies already spells "every kind".
      const prior = (editableStore.get(ACTIVITY_TABLE)?.events ?? []).some((e) => e.kind === APPLY_KIND)
      editableStore.recordApply({ ...(prior && { changed: changedKinds }), at: Date.now(), seed })
    }
    syncSessionBar()
    applyCooked(cooked)
    if (persist) persistSession()
  } finally {
    cooking--
    // The apply re-baselined the applied code and cleared pending, so the
    // button falls back to disabled until the next edit.
    host.refresh()
  }
}

// --- presence indicators -----------------------------------------------------
// Fold the presence + store logs into per-peer indicators for the table panel
// and editor. Only currently-online peers show. Coalesced per animation frame
// — announcements and merges arrive much faster than a redraw is worth.
let presenceRefreshScheduled = false
function schedulePresenceRefresh(): void {
  if (!presence || presenceRefreshScheduled) return
  presenceRefreshScheduled = true
  requestAnimationFrame(() => {
    presenceRefreshScheduled = false
    refreshPresenceUI()
  })
}

// --- live typing view --------------------------------------------------------
// Mirror a peer's in-progress buffer into the cell we have promoted. Strictly
// display — nothing cooks until an Apply pulse — and only while our own buffer
// is pristine (unchanged since promotion, or equal to the last text we mirrored
// into it), so a local edit in progress is never clobbered. Newest announcement
// wins. Keyed per cell now that every code row is its own editable buffer.
const mirroredLiveCode = new Map<string, string>()
function followLiveCode(): void {
  const cell = host.promoted()
  if (!presence || !cell) return
  const online = onlinePeers()
  const me = localSource()
  let best: { code: string; seq: number } | null = null
  for (const [client, lc] of presence.liveCodes()) {
    if (client === me || !online.has(client) || lc.cell !== cell) continue
    if (!best || lc.seq > best.seq) best = { code: lc.code, seq: lc.seq }
  }
  if (!best) return
  const current = cm.getCode()
  if (best.code === current) return
  if (host.dirty(cell) && current !== mirroredLiveCode.get(cell)) return
  mirroredLiveCode.set(cell, best.code)
  host.load(best.code)
}

function refreshPresenceUI(): void {
  if (!presence) return
  followLiveCode()
  const online = onlinePeers()
  const me = localSource()
  const edits = lastCellEdits(editableStore.log.all())
  const peers: PeerPresence[] = [...presence.peers().values()]
    .filter((p) => p.client !== me && online.has(p.client))
    .map((p) => {
      const edit = edits.get(p.client)
      return {
        client: p.client,
        user: peerLabel(p.client, p.user),
        color: peerColor(p.client, p.user),
        table: p.table,
        lastEdit: edit ? { table: edit.table, row: edit.row, col: edit.col } : null,
      }
    })
  tablePanel.setPresence(peers)
  cm.setRemoteCursors(
    [...presence.peers().values()]
      .filter((p) => p.client !== me && online.has(p.client) && p.cell != null && p.cell === localCell)
      .map((p) => ({ client: p.client, user: peerLabel(p.client, p.user), color: peerColor(p.client, p.user), head: p.head })),
  )
}

presence?.onChange(schedulePresenceRefresh)

// A table-change event landed. Edits are *pending* — nothing re-cooks until
// Run/Apply — and deliberately NOT persisted here: a session on disk only
// advances on Apply, so what's saved is always an applied state, never a
// half-finished edit batch. Just refresh the table panel, coalesced per
// animation frame and ignored while a cook is in flight.
let storeRefreshScheduled = false
editableStore.onChange(() => {
  // An edit just became pending — flip the Run button synchronously, not on the
  // coalesced frame below, so it's enabled the instant a grid Enter commits.
  if (!cooking) host.refresh()
  if (cooking || storeRefreshScheduled) return
  storeRefreshScheduled = true
  requestAnimationFrame(() => {
    storeRefreshScheduled = false
    setStoreTick((t) => t + 1)
    tablePanel.setTables(tablesForDisplay(lastViews))
    // A slider may have been declared between cooks — a post cell's slider()
    // lands at frame time, a peer's declaration by merge.
    updateSliderDefs(lastViews)
    // A store event may be a peer's set-cell — their "last edited" marker.
    schedulePresenceRefresh()
  })
})

// Disarm the rewind — called wherever the user takes back control of the
// timeline (a manual scrub, or applying new code).
function stopRewind(): void {
  if (!rewinding) return
  rewinding = false
  sessionBar.setRewinding(false)
}

function stepRewind(): void {
  const pos = sessionBar.position()
  const next = Math.max(0, pos - 1)
  scrubSession(next)
  sessionBar.setPosition(next)
  if (next <= 0) stopRewind()
}

// Arm or disarm the reset button's rewind. Starts playback so beats actually
// pass.
function toggleRewind(): void {
  if (rewinding) {
    stopRewind()
    return
  }
  if (sessionBar.position() <= 0) return
  rewinding = true
  sessionBar.setRewinding(true)
  playback.play()
  // Baseline from wherever the playhead now sits (play() may have just reset
  // it) so the first step counts from arming, not from 0.
  rewindBaseline = lastTick
}

// Scrub to run `pos` — a non-destructive preview: setReplayView refolds every
// editable table to that run and the program live then is re-cooked. Nothing
// is recorded, so pressing Run afterward forks forward rather than rewriting
// history; the newest position is the live head, so post-Apply edits stay
// visible there. Dragging fires cooks faster than the worker returns them;
// stale results are dropped via scrubEpoch.
let scrubEpoch = 0

async function scrubSession(pos: number): Promise<void> {
  // An empty axis isn't necessarily "nothing to show": a Clear leaves the
  // "code" history untouched, just with no bookmarks — treat it as "show
  // head". The blank-program check below still no-ops for an empty session.
  const head = editableStore.currentHead()
  const path = head === null ? editableStore.runs() : editableStore.branchPath()
  const clamped = path.length ? Math.max(0, Math.min(pos, path.length - 1)) : 0
  const atLatest = path.length === 0 || clamped >= path.length - 1
  const epoch = ++scrubEpoch
  cooking++
  // Legacy runs replay by log-prefix (SessionRun); a branch path replays by
  // apply id.
  const target = atLatest ? null : head === null ? (path[clamped] as SessionRun) : (path[clamped] as ApplyNode).id
  editableStore.setReplayView(target)
  // The facades re-read the scrubbed rows on their own, but a promoted row's
  // buffer is CodeMirror's and would keep showing the pre-scrub text — a
  // visible split, and an Apply from it would fork the branch with content
  // from a run the user isn't even looking at. Hand the view back, never
  // committing: the edit belongs to the head, not to this history.
  host.demote(false)
  // Tint the bar when resting on an earlier apply of a branching session —
  // an edit/apply here forks a new branch rather than extending.
  sessionBar.setForking(head !== null && !atLatest)
  // Cook *and* render inside one try: a restored program can fail at either
  // stage, and both must surface on the error strip rather than vanishing as
  // an unhandled rejection.
  try {
    const rows = codeRows()
    const code = programText(rows)
    if (!code) return
    const seed = seedAt(typeof target === 'string' ? target : atLatest ? head : null, rows)
    // A scrub re-cook renders history — it declares nothing, on or off the
    // live head (the run that declared already logged it).
    const { cooked } = await cookInWorker(code, seed, undefined, false)
    if (epoch !== scrubEpoch) return
    liveCode = code
    liveSeed = seed
    setError(null)
    // Re-baseline changed-detection so the next Run's apply pulse diffs
    // against the scrubbed view the user sees.
    diffCooked(cooked)
    applyCooked(cooked)
  } catch (err) {
    if (epoch === scrubEpoch) setError((err as Error).message)
  } finally {
    cooking--
  }
}

// Switching sessions while in a room would union the loaded log into the room
// — leave first.
function exitRoomMode(): void {
  if (!multiplayer) return
  multiplayer.close()
  multiplayer = null
  const u = new URL(location.href)
  u.searchParams.delete('room')
  u.searchParams.delete('user')
  history.replaceState(null, '', u)
  chipSolo()
}

// Keeps the address bar's ?example= in sync with what's actually open, so a
// reload or copied link lands back on the same example — set when one opens
// (openExample), cleared when the user navigates away from it (newSession,
// openSession).
function setExampleParam(slug: string | null): void {
  const u = new URL(location.href)
  if (slug) u.searchParams.set('example', slug)
  else if (u.searchParams.has('example')) u.searchParams.delete('example')
  else return
  history.replaceState(null, '', u)
}

async function openSession(id: string): Promise<void> {
  exitRoomMode()
  setExampleParam(null)
  // Only a genuinely unreadable session aborts the switch; a session whose
  // *program* errors is not corrupt — it still opens (below).
  const rec = await sessionStore.get(id).catch(() => null)
  try {
    const events = rec?.events
    if (events == null) throw new Error('saved session data is missing')
    const ok = quietly(() => editableStore.load(events))
    if (!ok) throw new Error('saved session data could not be read')
  } catch (err) {
    setError(`Could not open session: ${(err as Error).message}`)
    return
  }
  currentSessionId = id
  // Restore/derive legacy runs only for a session with no apply nodes — a
  // branching session scrubs its branch path instead.
  const savedRuns = rec?.runs ?? []
  quietly(() => {
    if (editableStore.currentHead() !== null) return
    if (savedRuns.length) editableStore.setRuns(savedRuns)
    else editableStore.deriveRunsFromCode()
  })
  // Reopen on the branch the session was last on (load() defaulted head to
  // the newest apply).
  const savedHead = rec?.head ?? null
  if (savedHead && savedHead !== editableStore.currentHead() && editableStore.branchTree().nodes.has(savedHead)) {
    quietly(() => editableStore.checkout(savedHead))
  }
  syncSessionBar()
  refreshSelector()

  // Reopen on the table the session was last showing (the panel applies it
  // once that tab exists); a legacy session with no saved table keeps the
  // panel's default tab.
  const savedTable = rec?.table ?? null
  tablePanel.restoreTable(savedTable)

  // Open for editing *before* running: if the program errors when cooked, the
  // session still ends up genuinely open — the code table's facades read the
  // store directly, so an empty view map is enough.
  lastViews = new Map<string, Table>()
  updateSliderDefs(lastViews)
  tablePanel.setTables(tablesForDisplay(lastViews))

  // The run surfaces its own errors without disturbing the opened tables.
  scrubSession(Math.max(0, sessionLength() - 1))
}

function newSession(): void {
  exitRoomMode()
  setExampleParam(null)
  currentSessionId = sessionStore.newId()
  quietly(() => editableStore.clear())
  // A fresh session runs the default program (the "Editable Table" example) —
  // open it on that example's relevant table, not whatever a prior resume left
  // pending.
  tablePanel.restoreTable(defaultTable)
  evaluate(defaultProgram, { setError, persist: false, seeds: defaultTables })
  syncSessionBar()
  refreshSelector()
}

// The "Clear" button: wipe the run list without touching any table's event
// history. Records a CLEAR_RUNS_KIND marker rather than deleting anything, so
// deriveRunsFromCode() won't resurrect these runs on a later reload.
function clearRuns(): void {
  stopRewind()
  quietly(() => {
    editableStore.record(ACTIVITY_TABLE, CLEAR_RUNS_KIND)
    editableStore.setRuns([])
  })
  syncSessionBar()
  persistSession()
}

const sessionBar = createSessionBar({
  onScrub: (pos) => { stopRewind(); scrubSession(pos) },
  onReset: toggleRewind,
  onCheckout: (headId) => checkoutBranch(headId),
})

function refreshBranches(): void {
  const tree = editableStore.branchTree()
  const head = editableStore.currentHead()
  const branches = tree.heads.map((id, i) => {
    const runs = tree.pathTo(id).length
    return { id, label: `branch ${i + 1} · ${runs} run${runs === 1 ? '' : 's'}`, current: id === head }
  })
  sessionBar.setBranches(branches)
}

// Refresh the session bar after the branch structure or head moves. Jumps the
// thumb to latest — never a fork point, so clear the fork tint (scrubSession
// sets it itself while replaying an earlier apply).
function syncSessionBar(): void {
  sessionBar.setLog({ length: sessionLength() })
  sessionBar.setForking(false)
  refreshBranches()
}

function checkoutBranch(headId: string): void {
  stopRewind()
  quietly(() => editableStore.checkout(headId))
  syncSessionBar()
  void scrubSession(sessionLength() - 1)
  persistSession()
}
// Load a Sample into a fresh session: from SAMPLES (loadExample) or an
// imported scene (importScene). The sample's table data seeds the cleared
// store — its editable() calls carry column schemas only, the row data lives
// with the sample — and restoreTable shows its most relevant tab once the tabs
// exist (like session resume), falling back to the default tab when it names
// none.
async function loadSample(sample: Sample): Promise<void> {
  exitRoomMode()
  currentSessionId = sessionStore.newId()
  quietly(() => editableStore.clear())
  tablePanel.restoreTable(sample.table ?? null)
  await evaluate(sample.code, { setError, persist: false, seeds: sample.tables })
  syncSessionBar()
  refreshSelector()
}

// The awaitable core behind opening an example: boot() (a direct ?example=
// link) needs to know once the cook has actually landed, so it can start
// playback the same way firstRun() does — everywhere else (the dropdown)
// keeps firing this off without waiting, exactly as before.
async function loadExample(index: number): Promise<void> {
  const sample = SAMPLES[index]
  if (!sample) return
  await loadSample(sample)
  setExampleParam(slugify(sample.name))
}

function openExample(index: number): void {
  void loadExample(index)
}

// --- scene export / import --------------------------------------------------
// Export copies the live scene to the clipboard as a Sample literal (paste it
// into SAMPLES in samples.ts); Import reads that text back and loads it. The
// two are symmetric through the clipboard.

// The live scene as a Sample: the editor's program plus the current rows of
// every editable() table. Blank cells and cells equal to their column default
// are dropped — conformRow refills them identically on load, so this is
// lossless and keeps the output as terse as the hand-written samples. The row's
// discriminant (`event`/`type`) is the one default-valued cell kept, so an
// event row still reads with its kind visible.
function currentScene(): Sample {
  const tables: Record<string, Row[]> = {}
  for (const name of lastDeclaredNames) {
    const data = editableStore.get(name)
    if (!data?.rows.length) continue
    const discriminant = data.columns.some((c) => c.name === 'event') ? 'event'
      : data.columns.some((c) => c.name === 'type') ? 'type' : null
    tables[name] = data.rows.map((row) => {
      const clean: Row = {}
      for (const col of data.columns) {
        const v = row[col.name]
        if (v === undefined || v === null || v === '') continue
        if (col.name === discriminant || v !== defaultFor(col.type, col.options)) clean[col.name] = v
      }
      return clean
    })
  }
  const slug = new URL(location.href).searchParams.get('example')
  const known = slug ? sampleIndexForSlug(slug) : -1
  return {
    name: known >= 0 ? SAMPLES[known].name : 'My Scene',
    ...(currentTable ? { table: currentTable } : {}),
    code: currentProgram(),
    ...(Object.keys(tables).length ? { tables } : {}),
  }
}

async function exportScene(): Promise<void> {
  try {
    // currentScene reads the *committed* rows, so a facade still holding an
    // unapplied edit would export the pre-edit program. Commit is a no-op on a
    // pristine buffer.
    if (host.promoted()) host.commit()
    await navigator.clipboard.writeText(serializeSample(currentScene()))
  } catch (err) {
    setError(`Export failed: ${(err as Error).message}`)
  }
}

async function importScene(): Promise<void> {
  try {
    const sample = parseSample(await navigator.clipboard.readText())
    await loadSample(sample)
    setExampleParam(null)
  } catch (err) {
    setError(`Import failed: ${(err as Error).message}`)
  }
}

const sessionSelector = createSessionSelector({
  onOpen: (id) => void openSession(id),
  onNew: newSession,
  onExample: openExample,
  examples: SAMPLES.map((s) => ({ label: s.name })),
  // Renaming acts on the stored record only — no re-cook needed, just a
  // re-listed dropdown.
  onRename: (id, name) => void sessionStore.rename(id, name).then(refreshSelector).catch(() => {}),
})

const roomChip = createRoomChip({
  initialUser: getUsername(),
  onJoin: (name, user) => {
    setUsername(user)
    const u = new URL(location.href)
    u.searchParams.set('room', name)
    if (user) u.searchParams.set('user', user)
    else u.searchParams.delete('user')
    const go = (): void => { location.href = u.toString() }
    // Seed the room with what's on screen: park the store under the room's
    // session id so the reload picks it up. Navigation waits for the async
    // save but proceeds on failure — the join sync covers it.
    if (editableStore.has('code')) {
      void sessionStore.save(roomSessionId(name), {
        events: editableStore.serialize(),
        runs: editableStore.runs(),
        tables: [...lastViews.keys()],
      }).then(go, go)
    } else {
      go()
    }
  },
  onLeave: () => {
    const u = new URL(location.href)
    u.searchParams.delete('room')
    u.searchParams.delete('user')
    location.href = u.toString()
  },
})

// Mount the whole layout in one Solid render (ui/app.tsx), which hands back
// the canvas elements: three.js renders into three-canvas, hydra post-
// processes it onto the visible hydra-canvas. The playback engine rides on
// those APIs, so it's built last and pushed into the watched signal.
const mounts = mountApp(document.getElementById('app') as HTMLElement, {
  tablePanel,
  chrome: {
    vimMode: getVimMode(),
    midiEnabled,
    setVimMode: (enabled) => { cm.setVimMode(enabled); setVimMode(enabled) },
    setMidiEnabled: (enabled) => {
      midiEnabled = enabled
      setMidiEnabled(enabled)
      if (enabled) ensureMidiSubscription()
      tablePanel.setTables(tablesForDisplay(lastViews))
    },
    // "Reset visuals": hydra occasionally wedges into a stuck error state that
    // a canvas resize/regl refresh clears — this triggers that fix manually.
    resetHydra: () => { hydraAPI.reinit(); baubleAPI.reinit() },
    exportScene: () => void exportScene(),
    importScene: () => void importScene(),
  },
  sessionBar,
  sessionSelector,
  roomChip,
  sliderPanel,
  playback: playbackCtl,
  timelineRows,
  sections,
  resolveSource,
  onClearRuns: clearRuns,
  // A timeline-pane drag committed its one setRow — re-run at the current
  // seed immediately, same as a cell commit (cellTarget above), so the drop
  // applies right away instead of sitting pending.
  onDragCommit: () => {
    if (liveCode != null) void evaluate(liveCode, { setError, seed: liveSeed })
  },
})
const sceneAPI = initThree(mounts.threeCanvas, mounts.canvasPane)
// The TSL post stage runs over the three scene BEFORE hydra samples the canvas
// as s0; three-scene's animate loop drives its render (see setPost).
const postAPI = initPost({
  renderer: sceneAPI.renderer,
  scene: sceneAPI.scene,
  camera: sceneAPI.camera,
  preview: mounts.preview.post,
})
sceneAPI.setPost(postAPI)
const baubleAPI = initBauble(mounts.baubleCanvas)
// The bauble canvas rides along as hydra source s1, so a sketch can composite
// the SDF render.
const hydraAPI = initHydra(mounts.hydraCanvas, mounts.threeCanvas, [mounts.baubleCanvas], mounts.preview.hydra)
// Post is registered before hydra: it prepares the scene's post uniforms for
// the frame hydra then samples.
const playbackController = createPlaybackController(
  [
    createSceneVisualizer(sceneAPI),
    createPostVisualizer(postAPI, () => previewCode('post')),
    createHydraVisualizer(hydraAPI, () => previewCode('hydra')),
    createBaubleVisualizer(baubleAPI),
  ],
  playbackOptions,
)
setPlaybackCtl(playbackController)
playback = playbackController.engine

function chipSolo(): void {
  roomChip.set({ kind: 'solo' })
}

// Redraws the chip at the current peer fold. Takes status as an argument
// rather than reading `multiplayer`: connectMultiplayer's onStatus can fire
// synchronously, before the `multiplayer = ...` assignment completes.
function chipStatus(status: MultiplayerStatus): void {
  if (status === 'closed' || !roomName) return
  const online = onlinePeers()
  const me = localSource()
  const peerNames = presence
    ? [...presence.peers().values()]
        .filter((p) => p.client !== me && online.has(p.client))
        .map((p) => peerLabel(p.client, p.user))
    : []
  roomChip.set({ kind: 'room', status, room: roomName, user: userName, peerNames })
}

async function bootRoom(room: string): Promise<void> {
  // Restore the locally-persisted copy of the room's log first, then connect
  // (the join snapshot carries it up).
  try {
    const rec = await sessionStore.get(currentSessionId)
    if (rec?.events) {
      quietly(() => editableStore.load(rec.events))
      quietly(() => {
        if (editableStore.currentHead() !== null) return
        if (rec.runs.length) editableStore.setRuns(rec.runs)
        else editableStore.deriveRunsFromCode()
      })
    }
  } catch { /* no local copy — the join sync seeds us from peers instead */ }

  // Guarantee "activity" exists before joining: the server authors peer-join/
  // leave events referencing it, and its peer-join for this very connection
  // could otherwise arrive before any replica's "create" and be silently
  // dropped by the fold. Stamped with `at`: peer-join itself carries no
  // usable domain wall-clock field (see playbackOrigin's comment), so this
  // is the room's "first join" stand-in the origin fold reads instead.
  editableStore.record(ACTIVITY_TABLE, 'session-start', { at: Date.now() })

  editableStore.log.onMerge((added) => {
    // A merged Apply pulse means treat it like they pressed Apply for us too:
    // evaluate() against the now-merged tables, broadcast:false so we don't
    // echo a pulse back (that would round-trip forever). Remote edits to real
    // tables need nothing here — the generic onChange reaction covers them.
    let applied = false
    let presenceChanged = false
    let loopBeatsChanged = false
    let transportChanged = false
    for (const e of added) {
      if (e.table !== ACTIVITY_TABLE) continue
      if (e.kind === 'apply') applied = true
      else if (e.kind === 'peer-join' || e.kind === 'peer-leave') presenceChanged = true
      else if (e.kind === 'set-loop-beats') loopBeatsChanged = true
      else if (e.kind === 'playback-play' || e.kind === 'playback-pause') transportChanged = true
    }
    // A peer resized the loop without applying — fold the merged value in (an
    // apply's copy via applyCooked is harmless: setLoopBeats no-ops unchanged).
    if (loopBeatsChanged) {
      const n = loopBeatsFromEvents(editableStore.get(ACTIVITY_TABLE)?.events ?? [])
      if (n != null) playback.setLoopBeats(n)
    }
    // A peer toggled play/pause — mirror it (idempotent, so an echo is harmless).
    if (transportChanged) {
      const state = transportStateFromEvents(editableStore.get(ACTIVITY_TABLE)?.events ?? [])
      quietTransport(() => (state === 'paused' ? playback.pause() : playback.play()))
    }
    if (applied) {
      // The merge already made their fragments ours; re-cook the joined
      // program at the seed their apply carried.
      const code = currentProgram()
      // Two applies can be in flight at once, and the loser must not
      // re-write the "code" table back to its own older fragment snapshot.
      if (code) void evaluate(code, { setError, seed: seedAt(editableStore.currentHead(), codeRows()), broadcast: false, obsoleteIfProgramChanged: true })
    }
    if (presenceChanged) {
      chipStatus(multiplayer?.status ?? 'connecting')
      // A departed peer's indicators come down; a joiner's may already be
      // waiting in the synced presence log.
      schedulePresenceRefresh()
    }
  })
  tapLog.log.onMerge(() => onTap())
  // Announce ourselves before joining — the join snapshot carries it.
  presence?.set({ cell: localCell })
  chipStatus('connecting')
  multiplayer = connectMultiplayer({
    url: multiplayerUrl(),
    room,
    logs: { session: editableStore.log, taps: tapLog.log, [PRESENCE_LOG]: presence!.log },
    onStatus: chipStatus,
  })
}

async function firstRun(): Promise<void> {
  if (sessionLength()) {
    // Resume the existing store; don't append a new run.
    await scrubSession(sessionLength() - 1)
  } else {
    // Speculative default. If a room snapshot merges in while this first cook
    // boots the worker, yield (obsoleteIfProgramChanged) instead of
    // clobbering the room.
    tablePanel.restoreTable(defaultTable)
    await evaluate(defaultProgram, { setError, persist: false, obsoleteIfProgramChanged: true, seeds: defaultTables })
  }
  syncSessionBar()
  refreshSelector()
  // Open the page in the session's transport state. Quiet — a default is not a
  // user toggle (see recordTransport); the onMerge mirror fixes a late joiner
  // whose autoplay beat the room's join snapshot.
  quietTransport(() => {
    if (transportStateFromEvents(editableStore.get(ACTIVITY_TABLE)?.events ?? []) === 'paused') playback.pause()
    else playback.play()
  })
}

// A room boot awaits the locally-persisted room log first, so firstRun's
// "resume or speculative default" decision sees the restored runs.
async function boot(): Promise<void> {
  if (roomName) {
    await bootRoom(roomName)
    await firstRun()
    return
  }
  chipSolo()
  // A direct link to an example (?example=<slug>) opens it in place of the
  // usual speculative-default boot; loadExample already syncs the session bar
  // and selector itself, same as newSession/openSession do. Await it (via the
  // awaitable core, not the fire-and-forget openExample the dropdown uses) so
  // playback starts only once there's content — mirroring how firstRun
  // autostarts playback after its own first cook lands.
  const exampleIndex = exampleSlug ? sampleIndexForSlug(exampleSlug) : -1
  if (exampleIndex >= 0) {
    await loadExample(exampleIndex)
    quietTransport(() => playback.play())
  } else {
    await firstRun()
  }
}

// Register the offline service worker (static/sw.js). Best-effort: an
// unsupported browser or a failed registration just means no offline caching.
if ('serviceWorker' in navigator) {
  addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch(() => {}) })
}

void boot()
