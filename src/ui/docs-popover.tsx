// Info popover (the ℹ button): a tabbed reference. The "code" tab is the DSL
// function reference — reusing the doc dictionaries that drive editor
// autocomplete, so it never drifts from what completion shows — plus a
// plain-language guide to the system's tables. Each further tab is one of the
// event-driven DSLs (hydra / bauble / post), listing the events its table
// supports and what each one does. Opening the info while on a DSL's table
// jumps straight to that tab. Unlike other panes it owns its own open/close
// state; nothing worth hoisting into main.ts.

import { createSignal, For, Show, type Accessor } from 'solid-js'
import { listenGlobal } from './dom.js'
import {
  DSL_BUILTIN_DOCS, TABLE_METHOD_DOCS, EXPR_NAMESPACE_DOCS, EXPR_METHOD_DOCS, THREE_METHOD_DOCS,
  type DocEntry,
} from '../editor-support.js'

interface FnSection {
  title: string
  blurb: string
  docs: Record<string, DocEntry>
}

const FN_SECTIONS: FnSection[] = [
  {
    title: 'Builders',
    blurb: 'Top-level functions that make a Table to start a chain from.',
    docs: DSL_BUILTIN_DOCS,
  },
  {
    title: 'Table methods',
    blurb: 'Chain off any Table. Each returns a new Table, so they compose.',
    docs: TABLE_METHOD_DOCS,
  },
  {
    title: 'expr.* sources',
    blurb: 'The expression namespace: row readers plus the live midi / slider / time sources.',
    docs: EXPR_NAMESPACE_DOCS,
  },
  {
    title: 'Expression methods',
    blurb: 'Chain off expr.field() / expr.lit() / expr.idx() to build a diffable expression.',
    docs: EXPR_METHOD_DOCS,
  },
  {
    title: '.three animators',
    blurb: 'Chain off a scene table\'s .three accessor to animate objects over beats.',
    docs: THREE_METHOD_DOCS,
  },
]

interface TableDoc {
  name: string
  detail: string
  info: string
}

const TABLE_DOCS: TableDoc[] = [
  {
    name: 'Table',
    detail: 'the one data type',
    info: 'Everything is a Table — an array of plain row objects, built and transformed by the DSL. Timing lives in each row\'s `beat` column (1-indexed); there are no seconds in the data model.',
  },
  {
    name: 'Views',
    detail: 'computed tables',
    info: 'Named tables you register with define("name", (rand, table) => …), table("name", rows), or .save("name"). Cooked lazily and only when something changed, each becomes a tab in the table panel. Reference another view with table("name") to build a dependency. Tables routed to a consumer with .outHydra()/.outThree()/… need no name at all — they combine into that consumer\'s "(system)" view, which takes precedence: a view named after the consumer ("hydra", "three", …) plays only when nothing routes.',
  },
  {
    name: 'Editable tables',
    detail: 'hand-entered data',
    info: 'editable("name", schema, seedRows) makes a table whose rows you type in the panel instead of computing. Every edit is an appended event and the visible table is the fold of those events, so edits persist across runs. Its edit history shows under the "Events" sub-tab (the "name·events" view).',
  },
  {
    name: 'code',
    detail: 'the program itself',
    info: 'The program you\'re editing is itself an editable table (schema { code, seed }). Its change history is "code·events" — which is what a saved session serializes.',
  },
  {
    name: 'midi / midi·events',
    detail: 'live MIDI input',
    info: 'With MIDI enabled (⚙ settings), incoming notes stream into the "midi·events" log; the folded "midi" table holds, per note, the latest loop\'s take. expr.midi("c4") bindings resolve against it each frame, so notes you play while looping replay at the loop position they were heard.',
  },
  {
    name: 'sliders / slider',
    detail: 'on-screen controls',
    info: 'Calling expr.slider("name", min?, max?) — or slider("name", min?, max?) in a post cell — declares a labelled slider over the visual: a row lands in the "sliders" table (rows { name, min, max, default? }, also definable by hand or as a view). Dragging one records automation as "slider" events; the value resolves against the folded "slider" table (raw log: "slider·events"), exactly like MIDI.',
  },
  {
    name: 'taps',
    detail: 'the tempo source',
    info: 'taps() is the tap-beat table — one row per Tap button press ({ beat, time }, time an absolute epoch ms). It is the source of tempo: the playhead runs at the tapped rate, and tempo() / beats() read from it.',
  },
  {
    name: 'timeline',
    detail: 'playback time warp',
    info: 'Define a view named "timeline" to warp playback over the baked content — one event per row (the schemas.timeline columns), each covering an until-next window from its `beat` to the next row\'s (rows ordered by loop, then beat): "retime" stretches source `from`..`to` into the block `outFrom`..`outTo` and repeats it across the window (from > to runs backwards), "pingpong" plays the block there and back, "loop" cycles a source range at natural speed, "hold" freezes a frame, "speed" runs from a beat at a rate. The last row runs to the end of its pass, whose length is the "beats" loop control; beats before the first row play unmapped, and a bare retime row is the identity warp for a plain stretch. beats(count, { fit }) builds a one-retime timeline; .retime(table("timeline")) applies the same warp to any beat table; editable("timeline", schemas.timeline) makes it hand-editable.',
  },
  {
    name: 'Streaming logs',
    detail: 'the session as data',
    info: 'The read-only log tabs are readable from code under the names their tabs wear: table("activity") is the session\'s pulse (one { kind: "apply" } row per Run, plus peer-join/leave and set-loop-beats markers), table("name·events") any editable table\'s edit history, "code·events" the program\'s. A program view of the same name wins. See the Run Counter / Session Sculpture examples.',
  },
  {
    name: 'Scene rows',
    detail: 'what drives the 3D view',
    info: 'Rows rendered as 3D objects share a schema: event ("create" | "update" | "color" | "destroy"), id, beat, shape, position px/py/pz, rotation rx/ry/rz, scale sx/sy/sz, color. rasterize(maxBeats) bakes sparse beat-keyed event rows into a dense per-frame world state, easing numeric fields between keyframes.',
  },
]

// One event a DSL table row can carry: its `event` value, the other columns it
// reads, and what folding it does. The `cols` string is the terse column hint
// shown next to the event name (mirrors DocEntry's `detail`).
interface EventDoc {
  event: string
  cols: string
  info: string
}

interface DslHelp {
  // Matches the table-panel tab name, so opening the info on that table lands
  // here (see tabForTable).
  id: string
  title: string
  blurb: string
  events: EventDoc[]
}

const DSL_HELP: DslHelp[] = [
  {
    id: 'hydra',
    title: 'hydra',
    blurb: 'A table of events folded per `out` output into one running hydra chain. `out` (o0 by default) is appended as the terminal `.out(oN)`; check `disabled` to mute a row.',
    events: [
      { event: 'setCode', cols: 'code', info: 'Replace the whole sketch for this output with `code`, a full hydra chain. The terminal `.out()` is added from the `out` column, so `code` needn\'t write its own.' },
      { event: 'setSource', cols: 'code', info: 'Swap just the head generator (e.g. osc(...) → noise(...)), keeping every effect after it in the running chain.' },
      { event: 'append', cols: 'code', info: 'Append a `.effect(…)` fragment onto the running chain.' },
      { event: 'replace', cols: 'find · value', info: 'Literal substring swap over the whole current sketch: every occurrence of `find` becomes `value`.' },
      { event: 'layer', cols: 'code · mode · value', info: 'Composite another sketch (`code`) over the current one via `mode` (blend / add / mult / diff / layer / mask); `value` is the blend amount where the mode takes one.' },
      { event: 'transition', cols: 'code', info: 'Wipe to the NEXT setCode ahead — the wipe runs from this beat until that setCode\'s beat, so place the destination where the wipe should END. `code` is an optional black-and-white mask sketch; blank = a plain crossfade.' },
      { event: 'setVariable', cols: 'name · value', info: 'Set a live input `name` to `value`; the sketch reads it as a per-frame props function, so driving it never recompiles.' },
    ],
  },
  {
    id: 'bauble',
    title: 'bauble',
    blurb: 'Hydra\'s sibling for 3D SDF sketches: one row per event, folded into a Janet shape expression. `code` cells are Janet (no JS completions); check `disabled` to mute a row.',
    events: [
      { event: 'setCode', cols: 'code', info: 'Replace the whole sketch with a Janet shape expression, e.g. `(rotate (box 50) :y t)`.' },
      { event: 'transform', cols: 'code', info: 'Wrap a Janet form around the shape: a standalone `_` marks the hole (used for each occurrence), otherwise the shape is inserted as the form\'s first argument.' },
      { event: 'duplicate', cols: 'code · mode · value', info: 'Combine the shape with a copy of itself run through `code` (blank = a verbatim copy), via `mode`; `value` is the smooth-blend radius / morph amount.' },
      { event: 'combine', cols: 'code · mode · value', info: 'Composite another whole shape (`code`) onto the current one via `mode` — union / intersect / subtract take `value` as the :r blend radius, morph as its amount.' },
      { event: 'replace', cols: 'find · value', info: 'Literal substring swap over the whole current sketch: every occurrence of `find` becomes `value`.' },
      { event: 'slice', cols: 'code · value · axis', info: 'Cut the shape open as a shell: an onion `value` thick (default 3) minus `code` — or a half-space about `axis` when `code` is blank.' },
      { event: 'tile', cols: 'value', info: 'Repeat the shape on an infinite lattice. A number spaces all three axes evenly; a string is a Janet vec3 like `[80 120 80]`.' },
      { event: 'radial', cols: 'value · axis', info: 'Repeat the shape in a circular array of `value` copies (default 6) about `axis`.' },
      { event: 'transition', cols: '—', info: 'Morph to the NEXT setCode ahead, on the playback clock — the morph runs from this beat until that setCode\'s beat, so its beat sets the length. Build the destination with ordinary events at that later beat.' },
      { event: 'setVariable', cols: 'name · value', info: 'Compile `(def name value)` ahead of the sketch (changing one recompiles), except the reserved camera-x / camera-y / camera-zoom names, which orbit the camera as live uniforms.' },
    ],
  },
  {
    id: 'post',
    title: 'post',
    blurb: 'TSL post-processing built like a hydra table, folded into one effect chain run on the rendered scene before hydra samples it. The scene is the implicit source and there is one output, so `code` reads like hydra with no head or routing; check `disabled` to mute a row.',
    events: [
      { event: 'setCode', cols: 'code', info: 'Set the whole effect chain, e.g. `edges(0.2).bloom(1.2)`. Empty = passthrough (the scene shows through untouched).' },
      { event: 'add', cols: 'code', info: 'Append effects onto the running chain (`pixelate(6)`; a leading `.` is optional).' },
      { event: 'remove', cols: 'name', info: 'Drop every op named `name` from the chain — the beat-time bypass.' },
      { event: 'layer', cols: 'code · mode · value', info: 'Composite another chain (`code`) via `mode` (blend / add / mult / diff / mask); `value` is the blend amount where the mode takes one.' },
      { event: 'transition', cols: 'code · ease', info: 'Composite to the NEXT setCode ahead, per pixel by a black→white mask (black keeps the old chain, white shows the new) — `code` is that mask chain, running from this beat until that setCode\'s beat. It only moves when the mask reads `progress()` (0 at this beat → 1 at the destination, shaped by `ease`): `progress()` alone is a crossfade, `gradient(0).thresh(progress().oneSub())` a directional wipe, `gradient(Math.PI).polar().thresh(progress().oneSub())` an iris (`.oneSub()` — 1 − value on any live arg — flips the mask so the reveal grows). A blank mask is static black — the old chain HOLDS for the whole window, then cuts to the new one.' },
      { event: 'setVariable', cols: 'name · value · ease', info: 'Set a live input `name` the chain reads through a props function. Rows of one `name` are a keyframe track ordered by beat, and `ease` shapes the segment INTO this one — blank STEPS (jumps to `value` on the beat), a named ease GLIDES from the previous keyframe\'s value.' },
      { event: 'pulse', cols: 'name · value · dur · ease', info: 'Add `value·env` to `name` over `dur` beats (default 1), `ease` shaping the decaying envelope — or \'step\' for a square gate that holds the full value then drops. Pulses stack.' },
    ],
  },
]

const HELP_IDS = new Set(DSL_HELP.map((d) => d.id))

// The tab to open on: a DSL's own table jumps to its help tab, everything else
// (the program, editable tables, logs) falls back to the DSL reference.
function tabForTable(name: string | null | undefined): string {
  return name && HELP_IDS.has(name) ? name : 'code'
}

export function DocsPopover(props: { currentTable?: Accessor<string | null> }) {
  const [open, setOpen] = createSignal(false)
  const [tab, setTab] = createSignal<string>('code')
  let wrap: HTMLDivElement | undefined
  let btn: HTMLButtonElement | undefined
  const [pos, setPos] = createSignal<{ top: number; right: number }>({ top: 0, right: 0 })

  listenGlobal(document, 'click', (e) => {
    if (wrap && !wrap.contains(e.target as Node)) setOpen(false)
  })
  listenGlobal(window, 'keydown', (e) => {
    if (e.key === 'Escape') setOpen(false)
  })

  const activeHelp = () => DSL_HELP.find((d) => d.id === tab())

  return (
    <div class="settings-wrap docs-wrap" ref={wrap}>
      <button
        class="settings-btn docs-btn"
        title="DSL reference & tables"
        aria-label="DSL reference and tables help"
        ref={btn}
        onClick={(e) => {
          e.stopPropagation()
          const opening = !open()
          if (opening && btn) {
            const r = btn.getBoundingClientRect()
            setPos({ top: r.bottom + 4, right: window.innerWidth - r.right })
            setTab(tabForTable(props.currentTable?.()))
          }
          setOpen(opening)
        }}
      >
        ℹ
      </button>
      <Show when={open()}>
        <div
          class="docs-popover"
          style={{ top: `${pos().top}px`, right: `${pos().right}px` }}
        >
          <div class="docs-popover-head">
            <span class="docs-popover-title">Reference</span>
            <button class="docs-close" aria-label="Close" onClick={() => setOpen(false)}>×</button>
          </div>
          <div class="docs-tabs" role="tablist">
            <button
              class="docs-tab"
              classList={{ 'docs-tab-active': tab() === 'code' }}
              role="tab"
              aria-selected={tab() === 'code'}
              onClick={() => setTab('code')}
            >
              code
            </button>
            <For each={DSL_HELP}>
              {(d) => (
                <button
                  class="docs-tab"
                  classList={{ 'docs-tab-active': tab() === d.id }}
                  role="tab"
                  aria-selected={tab() === d.id}
                  onClick={() => setTab(d.id)}
                >
                  {d.title}
                </button>
              )}
            </For>
          </div>
          <div class="docs-popover-body">
            <Show
              when={activeHelp()}
              fallback={
                <>
                  <section class="docs-section">
                    <h3 class="docs-h">Tables the system uses</h3>
                    <p class="docs-blurb">
                      Every value is a Table — rows keyed by <code>beat</code>. These
                      are the tables you'll meet as tabs in the panel below.
                    </p>
                    <dl class="docs-list">
                      <For each={TABLE_DOCS}>
                        {(t) => (
                          <>
                            <dt class="docs-term">
                              <code>{t.name}</code>
                              <span class="docs-detail">{t.detail}</span>
                            </dt>
                            <dd class="docs-def">{t.info}</dd>
                          </>
                        )}
                      </For>
                    </dl>
                  </section>

                  <section class="docs-section">
                    <h3 class="docs-h">DSL functions</h3>
                    <For each={FN_SECTIONS}>
                      {(sec) => (
                        <div class="docs-fn-group">
                          <h4 class="docs-h4">{sec.title}</h4>
                          <p class="docs-blurb">{sec.blurb}</p>
                          <dl class="docs-list">
                            <For each={Object.keys(sec.docs)}>
                              {(key) => (
                                <>
                                  <dt class="docs-term">
                                    <code>{sec.docs[key].sig}</code>
                                    <span class="docs-detail">{sec.docs[key].detail}</span>
                                  </dt>
                                  <dd class="docs-def">{sec.docs[key].info}</dd>
                                </>
                              )}
                            </For>
                          </dl>
                        </div>
                      )}
                    </For>
                  </section>
                </>
              }
            >
              {(help) => (
                <section class="docs-section">
                  <h3 class="docs-h">{help().title} events</h3>
                  <p class="docs-blurb">{help().blurb}</p>
                  <dl class="docs-list">
                    <For each={help().events}>
                      {(ev) => (
                        <>
                          <dt class="docs-term">
                            <code>{ev.event}</code>
                            <span class="docs-detail">{ev.cols}</span>
                          </dt>
                          <dd class="docs-def">{ev.info}</dd>
                        </>
                      )}
                    </For>
                  </dl>
                </section>
              )}
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}
