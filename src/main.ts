import './style.css'
import { createSignal } from 'solid-js'
import { initThree } from './three-scene.js'
import { initHydra } from './hydra-scene.js'
import { isHydraRow, hydraCodeUpToRow } from './hydra.js'
import { isBaubleRow } from './bauble.js'
import { isPostRow, postCodeUpToRow } from './post.js'
import { particleRows, hasSpawner, particleParamsAt, type ParticleParamName } from './particles.js'
import { initBauble } from './bauble-scene.js'
import { initPost } from './post-scene.js'
import { createSceneVisualizer, createHydraVisualizer, createBaubleVisualizer, createPostVisualizer } from './visualizer.js'
import { mountApp } from './ui/app.js'
import { createEditor, defaultProgram, defaultTables, defaultTable, PROGRAM_CELL } from './ui/editor.js'
import { createTablePanel } from './ui/table-panel.js'
import { EVENTS_SUFFIX } from './table-panel.js'
import { createPlaybackController, type PlaybackController } from './ui/playback-controls.js'
import { createSessionBar } from './ui/session-bar.js'
import { createSessionSelector } from './ui/session-selector.js'
import { createRoomChip } from './ui/room-chip.js'
import { SAMPLES, sampleIndexForSlug, slugify, serializeSample, parseSample, type Sample } from './samples.js'
import { defaultSessionStore } from './sessions.js'
import { getVimMode, setVimMode, getMidiEnabled, setMidiEnabled, getUsername, setUsername } from './settings.js'
import { createCookClient } from './cook-client.js'
import type { CookedSigs } from './replay.js'
import { randomSeed, localSource } from './event-log.js'
import { createPresenceChannel, userColor, lastCellEdits } from './presence.js'
import { Table, outViewName } from './dsl.js'
import { createEditableTableStore, defaultFor, DISABLED_COL, CLEAR_RUNS_KIND, ACTIVITY_TABLE, isExprCellText, type ColumnType, type SessionRun } from './editable-tables.js'
import type { ApplyNode } from './branches.js'
import { createMidiInput, subscribeWebMidi, type MidiInput, type MidiStore } from './midi.js'
import { createSliderInput, sliderDefs, sameSliderDefs, type SliderDef, type SliderInput } from './sliders.js'
import { createSliderPanel } from './ui/slider-panel.js'
import { beatToFrame } from './constants.js'
import { createTapLog } from './tap-log.js'
import { connectMultiplayer } from './multiplayer.js'
import type { MultiplayerConnection, MultiplayerStatus } from './multiplayer.js'
import { PRESENCE_LOG } from './room-core.js'
import { loopEpochsFromApplies, loopBeatsFromEvents, pausedMsBefore, transportStateFromEvents, playbackOrigin } from './playback.js'
import type { PlaybackAPI, PlaybackOptions } from './playback.js'
import type { Row } from './lineage.js'
import type { PeerPresence } from './ui/table-panel.js'

const dataCache = new Map<string, string>()
const editableStore = createEditableTableStore()

// The program is itself an editable table "code" (one row: code + seed);
// "code·events" *is* the run history, and a session is just the store's
// serialized events — see sessions.ts.
const CODE_SCHEMA: Record<string, ColumnType> = { code: 'code', seed: 'number' }

function setCodeRow(code: string, seed: number): void {
  if (!editableStore.has('code')) {
    editableStore.ensure('code', CODE_SCHEMA, [{ code, seed }])
    return
  }
  // Skip identical writes so re-applying an unchanged program doesn't spam
  // "code·events" with duplicate rows.
  const cur = editableStore.get('code')?.rows[0]
  if (cur && cur.code === code && cur.seed === seed) return
  editableStore.setRow('code', 0, { code, seed })
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

// The hydra/post cell open in the editor, previewed behind the code as you
// type: the uncommitted text goes back into its table and folds like any other
// row, so a fragment cell (an `add` chunk) previews as the running sketch it
// joins — the same fold the row's ⓘ popover shows. No explicit clear; the
// editor's own cell language gates it.
let previewCell: { table: string; rowIndex: number; col: string; lang: 'hydra' | 'post'; text: string } | null = null
// A keystroke must not reach the GPU: each change recompiles a sketch (hydra)
// or a whole TSL pipeline (post).
const PREVIEW_DEBOUNCE_MS = 150
let previewTimer: ReturnType<typeof setTimeout> | undefined

function previewCode(lang: 'hydra' | 'post'): string | null {
  const cell = previewCell
  if (!cell || cell.lang !== lang || editor.activeCellLang() !== lang) return null
  const rows = editableStore.get(cell.table)?.rows
  if (!rows) return null
  const edited = rows.map((r, i) => (i === cell.rowIndex ? { ...r, [cell.col]: cell.text } : r))
  return (lang === 'post' ? postCodeUpToRow : hydraCodeUpToRow)(edited, cell.rowIndex)
}

const tablePanel = createTablePanel(editableStore, {
  onEditCell: (table, rowIndex, col, value) => {
    // Clicking a code cell should reveal the editor if it's collapsed (the
    // default on mobile).
    editor.expand()
    // The "code" cell is the program itself: clicking it just syncs the main
    // editor back to the stored value — no cell-target mode.
    if (table === 'code' && col === 'code') {
      if (editor.getCode() !== value) editor.setCode(value)
      return
    }
    // Other code-typed cells edit via cell-target mode; committing re-cooks
    // with the current seed so tweaking a sketch doesn't re-randomize the scene.
    // Editor language: the column's declared language wins (the only signal
    // that survives rows being mapped into views); older tables fall back to
    // sniffing the row — bauble rows share hydra's shape but hold Janet.
    const data = editableStore.get(table)
    const colSpec = data?.columns.find((c) => c.name === col)
    const declaredLang = colSpec?.type === 'code' ? colSpec.language : undefined
    const lang = declaredLang
      ?? (colSpec?.type === 'number' && isExprCellText(value) ? 'expr' as const : undefined)
      ?? (col === 'code' && table === 'bauble' && isBaubleRow(data?.rows[rowIndex]) ? 'bauble' as const : undefined)
      ?? (col === 'code' && table === 'post' && isPostRow(data?.rows[rowIndex]) ? 'post' as const : undefined)
      ?? (col === 'code' && isHydraRow(data?.rows[rowIndex]) ? 'hydra' as const : 'dsl' as const)
    // "=" cells edit without the marker — the buffer must be a plain JS
    // expression for the 'expr' language service — and commit re-adds it.
    const isExpr = lang === 'expr'
    // Preview this cell behind the editor — see previewCode.
    previewCell = lang === 'hydra' || lang === 'post' ? { table, rowIndex, col, lang, text: value } : null
    editor.editCell(`${table}[${rowIndex}].${col}`, isExpr ? value.slice(1) : value, (text) => {
      // A number column reached via cell-target mode: plain numeric (or
      // blank) text goes back to a number/blank, so deleting the formula
      // doesn't strand a string in a number column; anything else keeps (or
      // regains) the "=" marker.
      const trimmed = text.trim()
      const stored = colSpec?.type !== 'number' ? text
        : trimmed === '' ? ''
          : Number.isFinite(Number(trimmed)) ? Number(trimmed)
            : trimmed.startsWith('=') ? trimmed : `=${trimmed}`
      editableStore.setCell(table, rowIndex, col, stored)
      if (liveCode != null) void evaluate(liveCode, { setError: editor.setError, seed: liveSeed })
    }, { lang })
    // editCell is what makes the cell's language current, and a paused playhead
    // draws no frames of its own — so the preview needs this nudge to appear.
    playback.refresh()
  },
  onCtrlEnter: () => editor.run(),
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

// Live MIDI rides the shared editable-table store, so recordings sync and
// persist like any other table; events are stamped with the playhead's source
// position so a recorded sweep follows the timeline mapping. Only the
// *hardware* side is opt-in (Web MIDI pops a browser permission prompt) — the
// fold always exists, so peer- or session-recorded MIDI plays back regardless.
let loopCount = 0
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

const logTableStore = (table: string): MidiStore => ({
  record: (kind, payload) => editableStore.record(table, kind, payload),
  events: () => editableStore.log.all().filter((e) => e.table === table),
  onChange: (cb) => editableStore.onChange(cb),
})

const midiStore = logTableStore('midi')

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
let lastSliderDefs: SliderDef[] = []
function updateSliderDefs(views: Map<string, Table>): void {
  // The cooked view already reflects ensure()'s disabled-row filtering; the
  // raw fallback needs it applied here.
  const rows = views.get('sliders')?.rows ?? (editableStore.get('sliders')?.rows ?? []).filter((r) => r[DISABLED_COL] !== true)
  const defs = sliderDefs(rows)
  // onChange fires on every store event, including a drag's "slider" value
  // writes, which never touch the "sliders" definitions. Skip the churn unless
  // the defs actually changed.
  if (sameSliderDefs(defs, lastSliderDefs)) return
  lastSliderDefs = defs
  sliderPanel.setDefs(defs)
  if (defs.length) ensureSliderInput().setDefs(defs)
  else sliderInput?.setDefs(defs)
}

const [playbackCtl, setPlaybackCtl] = createSignal<PlaybackController | null>(null)
// The applied cook's timeline rows, for the timeline strip's coverage shading
// — refreshed on every applyCooked, same cadence as the panel's tables.
const [timelineRows, setTimelineRows] = createSignal<Row[]>([])
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
  midiCtxAt: (srcFrame) => (midiInput.rows().length ? midiInput.ctxAt(srcFrame) : null),
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

// Play/pause ride the activity table too, so they sync, persist, and show in
// the activity tab. Two guards keep the stream honest:
// - `transportQuiet`: only a genuine local toggle is a user transport action.
//   Programmatic transitions — the autoplay on opening a page, mirroring a
//   peer's merged event — must not record: a late joiner's autoplay races the
//   room's join snapshot, and recording it would stamp a fresh 'play' that
//   overrides the room's paused state (an un-recorded autoplay just gets
//   corrected by the mirror once the snapshot merges).
// - The recordLoopBeats-style echo guard: a state already folded from the
//   table (our own event echoing back) must not re-record, or two clients
//   ping-pong the same transition. "No events yet" (null) deliberately does
//   NOT count as a match for 'playing', so a session's first real toggle is
//   still recorded rather than looking like a silent echo.
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

async function cookInWorker(code: string, seed: number, seeds?: Record<string, Row[]>, declareSliders = true): Promise<{ cooked: CookedData; declaredNames: string[] }> {
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

import type { GraphSpec } from './graph-panel.js'

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

interface CookedData {
  views: Map<string, Table>
  graphs: GraphSpec[]
  sceneRows: Row[]
  timelineRows: Row[]
  hydraRows: Row[]
  baubleRows: Row[]
  postRows: Row[]
  sigs: CookedSigs
}

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
  if (midiInput.rows().length) {
    logs.push({ name: 'midi', rows: midiInput.rows() })
    logs.push({ name: 'midi' + EVENTS_SUFFIX, rows: midiInput.eventRows() })
  }
  // Folded slider automation + raw log, only once something is recorded — an
  // empty pair just clutters the panel and can't be deleted, being synthetic.
  // ("sliders" itself is the definitions table, shown like any other view.)
  if (sliderInput && sliderInput.rows().length) {
    logs.push({ name: 'slider', rows: sliderInput.rows() })
    logs.push({ name: 'slider' + EVENTS_SUFFIX, rows: sliderInput.eventRows() })
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
  if (!display.has('taps')) display.set('taps', new Table(tapRows()))
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
function diffCooked({ sigs }: CookedData): { scene: boolean; timeline: boolean; hydra: boolean; bauble: boolean; post: boolean } {
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

// Render a cooked program and hand its rows to playback. Loop epochs come from
// the activity table's apply stamps — the author's clock, NOT this replica's —
// so late joiners land on the same pass of a multi-loop sequence. The loop
// length folds from the same stream, so a session load or scrub restores it.
function applyCooked(cooked: CookedData): void {
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
    .catch((err) => editor.setError(`Session save failed: ${(err as Error).message}`))
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
    let cooked: CookedData
    let declaredNames: string[]
    try {
      ({ cooked, declaredNames } = await cookInWorker(code, seed, seeds, broadcast))
    } catch (err) {
      setError?.((err as Error).message)
      return
    }
    if (obsoleteIfProgramChanged) {
      const current = editableStore.get('code')?.rows[0]?.code
      if (typeof current === 'string' && current !== code) return
    }
    setError?.(null)
    liveCode = code
    liveSeed = seed

    // Drop tables the program no longer declares editable(), so a computed
    // view of the same name (or nothing) takes over.
    editableStore.retainDeclared(declaredNames)

    // *Before* applyCooked renders the table panel, so its first render sees
    // "code" — the onChange reaction that would normally pick up a new table
    // is suppressed by `cooking` right now.
    setCodeRow(code, seed)
    // recordApply commits every pending edit as the apply node that *is* the
    // run — BEFORE applyCooked, so the loop epochs it folds already include
    // this apply, re-basing this replica from the very stamp its peers will.
    // A reactive evaluate commits nothing: the author's apply is already
    // merged, and onMerge has already made it our head.
    const changed = diffCooked(cooked)
    if (broadcast) {
      const changedKinds = Object.keys(changed).filter((k) => changed[k as keyof typeof changed])
      editableStore.recordApply({ changed: changedKinds, at: Date.now() })
    }
    syncSessionBar()
    applyCooked(cooked)
    if (persist) persistSession()
  } finally {
    cooking--
    // The apply re-baselined the applied code and cleared pending, so the
    // button falls back to disabled until the next edit.
    editor.refreshCanRun()
  }
}

// The code cell this editor is a window onto ("code[0].code" is the main
// program) — peers' cursors are drawn only when on this same cell.
let localCell: string = PROGRAM_CELL

const editor = createEditor({
  onRun: evaluate,
  getViews: () => lastViews,
  onCaretView: (name) => tablePanel.selectTable(name),
  getPlayIndex: () => currentPlayIndex,
  vimMode: getVimMode(),
  onVimModeChange: setVimMode,
  midiEnabled,
  onMidiEnabledChange: (enabled) => {
    midiEnabled = enabled
    setMidiEnabled(enabled)
    if (enabled) ensureMidiSubscription()
    tablePanel.setTables(tablesForDisplay(lastViews))
  },
  onResetHydra: () => { hydraAPI.reinit(); baubleAPI.reinit() },
  onExport: exportScene,
  onImport: importScene,
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
  // behind the editor.
  onEdit: (cell, code) => {
    presence?.setLiveCode(cell, code)
    const target = previewCell
    if (!target) return
    clearTimeout(previewTimer)
    // Writes to the captured cell, so a late timer after a cell switch lands on
    // the object nothing reads any more.
    previewTimer = setTimeout(() => { target.text = code; playback.refresh() }, PREVIEW_DEBOUNCE_MS)
  },
  // Escaping a code cell hands keyboard focus back to the table it came from.
  onExitCell: () => tablePanel.focusGrid(),
  programDirty: (buffer) => (liveCode == null || buffer !== liveCode) || editableStore.hasPendingEdits(),
  hasPendingEdits: () => editableStore.hasPendingEdits(),
})

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
// Mirror a peer's in-progress buffer into our editor. Strictly display —
// nothing cooks until an Apply pulse — and only while our own buffer is
// pristine (equal to the last applied program or the last text we mirrored),
// so a local edit in progress is never clobbered. Newest announcement wins.
let mirroredLiveCode: string | null = null
function followLiveCode(): void {
  if (!presence || localCell !== PROGRAM_CELL) return
  const online = onlinePeers()
  const me = localSource()
  let best: { code: string; seq: number } | null = null
  for (const [client, lc] of presence.liveCodes()) {
    if (client === me || !online.has(client) || lc.cell !== PROGRAM_CELL) continue
    if (!best || lc.seq > best.seq) best = { code: lc.code, seq: lc.seq }
  }
  if (!best) return
  const current = editor.getCode()
  if (best.code === current) return
  if (current !== liveCode && current !== mirroredLiveCode) return
  mirroredLiveCode = best.code
  editor.setCode(best.code)
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
  editor.setRemoteCursors(
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
  if (!cooking) editor.refreshCanRun()
  if (cooking || storeRefreshScheduled) return
  storeRefreshScheduled = true
  requestAnimationFrame(() => {
    storeRefreshScheduled = false
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
  // head". The codeRow check below still no-ops for a genuinely empty session.
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
  // Tint the bar when resting on an earlier apply of a branching session —
  // an edit/apply here forks a new branch rather than extending.
  sessionBar.setForking(head !== null && !atLatest)
  // Cook *and* render inside one try: a restored program can fail at either
  // stage, and both must surface on the error strip rather than vanishing as
  // an unhandled rejection.
  try {
    const codeRow = editableStore.get('code')?.rows[0]
    if (!codeRow || typeof codeRow.code !== 'string') return
    const code = codeRow.code
    const seed = typeof codeRow.seed === 'number' ? codeRow.seed : 0
    // A scrub re-cook renders history — it declares nothing, on or off the
    // live head (the run that declared already logged it).
    const { cooked } = await cookInWorker(code, seed, undefined, false)
    if (epoch !== scrubEpoch) return
    liveCode = code
    liveSeed = seed
    // A scrub previews a past run: keep the caret and scroll put. The selected
    // table needs nothing extra — fallbackTab holds the tab unless the run's
    // fold no longer has it.
    editor.setCode(code, { preserveView: true })
    editor.setError(null)
    // Re-baseline changed-detection so the next Run's apply pulse diffs
    // against the scrubbed view the user sees.
    diffCooked(cooked)
    applyCooked(cooked)
  } catch (err) {
    if (epoch === scrubEpoch) editor.setError((err as Error).message)
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
    editor.setError(`Could not open session: ${(err as Error).message}`)
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
  // session still ends up genuinely open — editor holding its code, table
  // panel its editable tables. Editability reads the store directly, so an
  // empty view map is enough.
  const codeRow = editableStore.get('code')?.rows[0]
  if (codeRow && typeof codeRow.code === 'string') editor.setCode(codeRow.code)
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
  editor.setCode(defaultProgram)
  evaluate(defaultProgram, { setError: editor.setError, persist: false, seeds: defaultTables })
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
  editor.setCode(sample.code)
  tablePanel.restoreTable(sample.table ?? null)
  await evaluate(sample.code, { setError: editor.setError, persist: false, seeds: sample.tables })
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
    code: editor.getCode(),
    ...(Object.keys(tables).length ? { tables } : {}),
  }
}

async function exportScene(): Promise<void> {
  try {
    await navigator.clipboard.writeText(serializeSample(currentScene()))
  } catch (err) {
    editor.setError(`Export failed: ${(err as Error).message}`)
  }
}

async function importScene(): Promise<void> {
  try {
    const sample = parseSample(await navigator.clipboard.readText())
    await loadSample(sample)
    setExampleParam(null)
  } catch (err) {
    editor.setError(`Import failed: ${(err as Error).message}`)
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
  editor,
  tablePanel,
  sessionBar,
  sessionSelector,
  roomChip,
  sliderPanel,
  playback: playbackCtl,
  timelineRows,
  onClearRuns: clearRuns,
  // A timeline-strip drag committed its one setRow — re-run at the current
  // seed immediately, same as a code-cell commit (onEditCell above), so the
  // drop applies right away instead of sitting pending.
  onDragCommit: () => {
    if (liveCode != null) void evaluate(liveCode, { setError: editor.setError, seed: liveSeed })
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
    // A peer toggled play/pause — mirror it locally so the whole room's
    // transport stays together. play()/pause() are idempotent, so this is
    // harmless even when the merge is just our own recorded event echoing
    // back (already reflected locally before we ever recorded it). Quiet:
    // a mirrored transition is not a user action to re-record.
    if (transportChanged) {
      const state = transportStateFromEvents(editableStore.get(ACTIVITY_TABLE)?.events ?? [])
      quietTransport(() => (state === 'paused' ? playback.pause() : playback.play()))
    }
    if (applied) {
      const latest = editableStore.get('code')?.rows[0] as { code: string; seed: number } | undefined
      if (latest) {
        // evaluate() assumes the editor already shows the code it's given —
        // a remote program needs pushing into the editor ourselves.
        if (latest.code !== liveCode) editor.setCode(latest.code)
        void evaluate(latest.code, { setError: editor.setError, seed: latest.seed, broadcast: false })
      }
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
    await evaluate(editor.getCode(), { setError: editor.setError, persist: false, obsoleteIfProgramChanged: true, seeds: defaultTables })
  }
  syncSessionBar()
  refreshSelector()
  // Opening the page shows the program already in the session's transport
  // state — playing by default (today's behavior with no transport history),
  // but paused if the room (or a resumed session) already is. This is also
  // the late-joiner landing spot: bootRoom's local-log restore/merge above
  // has already folded in whatever transport history exists before this
  // runs. Quiet — this is a default, not a user toggle, so it must record
  // nothing (see recordTransport); the onMerge mirror corrects it once the
  // room's join snapshot lands.
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
