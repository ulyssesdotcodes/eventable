// Code editor pane, split humble-object style: createEditor owns the
// CodeMirror view (created detached, adopted by the component's host div),
// cell-target bookkeeping, and chrome state; <EditorPane> renders it. Editor
// logic (completion/hover sources, docs) lives in ../editor-support.ts.

import { createSignal, createEffect, on, Show, type Accessor, type JSX } from 'solid-js'
import { listenGlobal, mountComponent } from './dom.js'
import { EditorView, basicSetup } from 'codemirror'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import { LanguageSupport } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { keymap } from '@codemirror/view'
import { Prec, Compartment } from '@codemirror/state'
import { vim, getCM } from '@replit/codemirror-vim'
import {
  viewNameCompletions, codeCompletions, typeHover, signatureHelp, dslHover,
  viewAtPos, minimalEdit, defaultProgram, defaultTables, defaultTable,
  remoteCursorField, setRemoteCursorsEffect, PROGRAM_CELL,
  type RemoteCursor, type SymbolCardData, type SigCardFactory,
} from '../editor-support.js'
import { createLangClient, type LangClient } from '../lang-client.js'
import type { LangSignatureHelp } from '../lang-service.js'
import type { CodeLanguage } from '../editable-tables.js'
import { numberScrub } from './num-scrub.js'
import { buildTablePreview } from './table-preview.js'
import { DocsPopover } from './docs-popover.js'
import type { Table } from '../dsl.js'

export { defaultProgram, defaultTables, defaultTable, PROGRAM_CELL }
export type { RemoteCursor }

// One TypeScript language-service worker per page, created lazily. If it
// can't come up, the editor falls back to the heuristic completions.
let langClient: LangClient | null = null
function getLangClient(): LangClient | null {
  if (langClient) return langClient
  try {
    const worker = new Worker(new URL('lang-worker.js', import.meta.url), { type: 'module' })
    langClient = createLangClient(worker)
  } catch (err) {
    console.error('language service unavailable:', err)
  }
  return langClient
}

// Completion info card, rendered detached for CodeMirror to adopt as tooltip
// content.
function makeInfoNode(sig: string, info: string): () => { dom: HTMLElement; destroy: () => void } {
  return () => {
    const { el, dispose } = mountComponent(() => (
      <div class="cm-completion-info">
        <code>{sig}</code>
        <p>{info}</p>
      </div>
    ))
    return { dom: el, destroy: dispose }
  }
}

function makeSymbolCard({ display, docs, curated }: SymbolCardData): { dom: HTMLElement; destroy: () => void } {
  const { el, dispose } = mountComponent(() => (
    <div class="cm-completion-info cm-symbol-card">
      <Show when={display}><code>{display}</code></Show>
      <Show when={docs}><p>{docs}</p></Show>
      <Show when={curated}><p>{curated!.info}</p></Show>
    </div>
  ))
  return { dom: el, destroy: dispose }
}

const makeSigCard: SigCardFactory = (sig: LangSignatureHelp) => {
  const item = sig.signatures[Math.min(sig.activeSignature, sig.signatures.length - 1)]
  const active = sig.activeParameter
  const { el, dispose } = mountComponent(() => (
    <div class="cm-signature-help">
      <code>
        {item.prefix}
        {item.params.map((p, i) => (
          <>
            {i > 0 ? item.separator : ''}
            <span classList={{ 'cm-signature-param-active': i === active }}>{p.label}</span>
          </>
        ))}
        {item.suffix}
      </code>
      <Show when={sig.signatures.length > 1}>
        <span class="cm-signature-overloads">+{sig.signatures.length - 1} overload{sig.signatures.length > 2 ? 's' : ''}</span>
      </Show>
      <Show when={item.params[active]?.docs}>
        <p>{item.params[active].docs}</p>
      </Show>
    </div>
  ))
  return { dom: el, destroy: dispose }
}

export interface EditorOptions {
  onRun?: (code: string, opts: { setError: (msg: string | null) => void }) => void
  getViews?: () => Map<string, Table>
  onCaretView?: (name: string) => void
  getPlayIndex?: () => number
  vimMode?: boolean
  onVimModeChange?: (enabled: boolean) => void
  // Off by default: enabling MIDI is what triggers the browser's permission
  // prompt (see main.ts).
  midiEnabled?: boolean
  onMidiEnabledChange?: (enabled: boolean) => void
  // "Reset visuals": hydra occasionally wedges into a stuck error state that
  // a canvas resize/regl refresh clears — this triggers that fix manually.
  onResetHydra?: () => void
  // Copy the live scene to the clipboard as a Sample literal (Export) and load
  // one back from the clipboard (Import) — see main.ts.
  onExport?: () => void
  onImport?: () => void
  // Multiplayer presence: the cell this editor is a window onto plus the
  // cursor offset.
  onCursor?: (cell: string, head: number) => void
  // Multiplayer live typing: fired only for doc changes the *user* made, not
  // programmatic setCode — re-announcing those would echo every mirrored
  // remote keystroke back.
  onEdit?: (cell: string, code: string) => void
  // Left a cell-target editor back to the program (Back button or Escape) —
  // the table panel uses it to restore keyboard focus to the grid.
  onExitCell?: () => void
  // Whether Running the program `buffer` would commit anything: true when it
  // differs from the applied code or the store holds pending table edits. Gates
  // the Run button; absent means always enabled.
  programDirty?: (buffer: string) => boolean
  // Whether the store holds un-applied table edits — an Apply of the open cell
  // commits those too, so Apply must enable for them even when the cell text is
  // unchanged.
  hasPendingEdits?: () => boolean
}

export interface EditorAPI {
  run(): void
  getCode(): string
  // preserveView applies the code as a minimal edit so the caret and scroll
  // stay put — used when scrubbing to a past run's program.
  setCode(code: string, opts?: { preserveView?: boolean }): void
  setError(msg: string | null): void
  // Point the editor at a single table cell: the program text is stashed, the
  // cell's text loads, and Run/Ctrl-Enter calls onCommit instead of running
  // the program. `lang` picks which surface completions/hover run against.
  editCell(label: string, code: string, onCommit: (text: string) => void, opts?: { lang?: CodeLanguage }): void
  // Ask the pane to uncollapse (e.g. a code cell was clicked on mobile, where
  // the editor starts collapsed).
  expand(): void
  // Draw collaborators' carets (the caller filters to the cell open here).
  setRemoteCursors(cursors: RemoteCursor[]): void
}

export interface EditorController extends EditorAPI {
  // Bumped by expand(); <EditorPane> watches it to uncollapse.
  expandTick: Accessor<number>
  title: Accessor<string>
  runLabel: Accessor<string>
  // Whether Run/Apply would commit anything — the button's enabled state.
  canRun: Accessor<boolean>
  // Recompute canRun; call when pending store edits change out-of-band (a grid
  // edit) or after an apply re-baselines the applied code.
  refreshCanRun(): void
  backVisible: Accessor<boolean>
  error: Accessor<string | null>
  initialVimMode: boolean
  initialMidiEnabled: boolean
  setVimMode(enabled: boolean): void
  setMidiEnabled(enabled: boolean): void
  resetHydra(): void
  exportScene(): void
  importScene(): void
  back(): void
  // CodeMirror's DOM, adopted by the view's editor-host div.
  cmDom: HTMLElement
  // The open cell's language (null = the program) — the token bar keys on it.
  activeCellLang: Accessor<CodeLanguage | null>
  // Insert text at the cursor, placing the caret `cursorBack` chars from its
  // end — the token bar's insert path.
  insertSnippet(text: string, cursorBack?: number): void
}

export function createEditor(
  { onRun, getViews, onCaretView, getPlayIndex, vimMode = true, onVimModeChange, midiEnabled = false, onMidiEnabledChange, onResetHydra, onExport, onImport, onCursor, onEdit, onExitCell, programDirty, hasPendingEdits }: EditorOptions = {},
): EditorController {
  const [title, setTitle] = createSignal('DSL')
  const [runLabel, setRunLabel] = createSignal('Run')
  const [canRun, setCanRun] = createSignal(true)
  const [backVisible, setBackVisible] = createSignal(false)
  const [error, setErrorSig] = createSignal<string | null>(null)
  const [expandTick, setExpandTick] = createSignal(0)
  // The open cell's language, null for the program — the token bar keys on it.
  const [activeCellLang, setActiveCellLang] = createSignal<CodeLanguage | null>(null)

  const setError = (msg: string | null): void => { setErrorSig(msg) }

  // When set, the editor is a window onto one table cell rather than the
  // program: Run commits the text back to the cell. `cellBaseline` is the
  // committed cell text, so an unchanged cell has nothing to apply.
  let cellTarget: { label: string; lang: CodeLanguage; onCommit: (text: string) => void } | null = null
  let stashedProgram = ''
  let cellBaseline = ''

  const cellLabel = (): string => cellTarget ? cellTarget.label : PROGRAM_CELL
  const cellLang = (): CodeLanguage => cellTarget ? cellTarget.lang : 'dsl'

  // Nothing to commit ⇒ the button is disabled. Cell mode enables on a changed
  // cell buffer or any pending store edit (an Apply commits those too); program
  // mode delegates to programDirty, defaulting to always-enabled without it.
  function currentlyDirty(): boolean {
    const text = view.state.doc.toString()
    if (cellTarget) return text !== cellBaseline || !!hasPendingEdits?.()
    return programDirty ? programDirty(text) : true
  }
  function refreshCanRun(): void {
    setCanRun(currentlyDirty())
  }

  function run(): void {
    // Read the live state, not the canRun() signal: the grid's Ctrl-Enter
    // commits an edit and calls run() synchronously, before the signal's
    // rAF-coalesced refresh has caught up.
    if (!currentlyDirty()) return
    const text = view.state.doc.toString()
    if (cellTarget) {
      cellTarget.onCommit(text)
      // The committed text is now the cell's value — nothing left to apply.
      cellBaseline = text
      refreshCanRun()
    } else {
      onRun?.(text, { setError })
    }
  }

  // Programmatic doc replacements must not read as the user typing — mutes
  // onEdit for the dispatch (the update listener runs synchronously inside it).
  // preserveView applies the code as a minimal splice so the caret and scroll
  // ride the unchanged text (a scrub to a past run shouldn't jump either).
  let programmaticDoc = false
  function setDoc(code: string, preserveView = false): void {
    const changes = preserveView
      ? minimalEdit(view.state.doc.toString(), code)
      : { from: 0, to: view.state.doc.length, insert: code }
    programmaticDoc = true
    try {
      view.dispatch({ changes })
    } finally {
      programmaticDoc = false
    }
  }

  function exitCell(restoreProgram: boolean): void {
    if (!cellTarget) return
    cellTarget = null
    setActiveCellLang(null)
    setTitle('DSL')
    setRunLabel('Run')
    setBackVisible(false)
    if (restoreProgram) {
      setDoc(stashedProgram)
      onExitCell?.()
    }
    refreshCanRun()
  }

  // Vim owns Escape (leave insert mode); only treat it as "back to the table"
  // once vim is out of insert mode (or off entirely) so a code cell's Escape
  // doesn't swallow the modal exit vim users expect.
  function vimInsertActive(): boolean {
    return !!getCM(view)?.state?.vim?.insertMode
  }

  function editCell(label: string, code: string, onCommit: (text: string) => void, { lang = 'dsl' }: { lang?: CodeLanguage } = {}): void {
    if (!cellTarget) stashedProgram = view.state.doc.toString()
    cellTarget = { label, lang, onCommit }
    setActiveCellLang(lang)
    cellBaseline = code
    setTitle(label)
    setRunLabel('Apply')
    setBackVisible(true)
    setDoc(code)
    refreshCanRun()
    view.focus()
  }

  const vimCompartment = new Compartment()

  let lastCaretView: string | null = null

  const langService = getLangClient()

  // Created detached; <EditorPane>'s host div appends view.dom.
  const view = new EditorView({
    doc: defaultProgram,
    extensions: [
      vimCompartment.of(vimMode ? [vim()] : []),
      basicSetup,
      // Bare language, not javascript(): its bundled completion sources would
      // duplicate what the language service returns.
      new LanguageSupport(javascriptLanguage),
      javascriptLanguage.data.of({ autocomplete: viewNameCompletions(getViews, cellLang) }),
      javascriptLanguage.data.of({ autocomplete: codeCompletions(langService, makeInfoNode, makeSymbolCard, cellLang) }),
      ...(langService ? [typeHover(langService, makeSymbolCard, cellLang), signatureHelp(langService, makeSigCard, cellLang)] : []),
      EditorView.updateListener.of((u) => {
        if (!(u.selectionSet || u.docChanged)) return
        if (u.docChanged) refreshCanRun()
        onCursor?.(cellLabel(), u.state.selection.main.head)
        if (u.docChanged && !programmaticDoc && onEdit) onEdit(cellLabel(), u.state.doc.toString())
        if (!onCaretView) return
        const name = viewAtPos(u.state.doc.toString(), u.state.selection.main.head)
        if (name && name !== lastCaretView) {
          lastCaretView = name
          onCaretView(name)
        }
      }),
      remoteCursorField,
      dslHover(getViews, getPlayIndex, buildTablePreview),
      numberScrub(),
      oneDark,
      Prec.highest(keymap.of([
        { key: 'Mod-Enter', run: () => { run(); return true } },
        // Escape a code cell back to the program; falls through (return false)
        // to vim when there's no cell open or vim is still in insert mode.
        { key: 'Escape', run: () => {
          if (!cellTarget || vimInsertActive()) return false
          exitCell(true)
          return true
        } },
      ])),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'auto' },
      }),
    ],
  })

  // External loads always mean "show the program" — leave any cell target
  // without restoring its stash (the new code wins).
  function setCode(code: string, opts: { preserveView?: boolean } = {}): void {
    exitCell(false)
    setDoc(code, opts.preserveView)
  }

  return {
    run,
    getCode: () => view.state.doc.toString(),
    setCode,
    setError,
    editCell,
    expand: () => setExpandTick((n) => n + 1),
    expandTick,
    title,
    runLabel,
    canRun,
    refreshCanRun,
    backVisible,
    error,
    initialVimMode: vimMode,
    initialMidiEnabled: midiEnabled,
    setVimMode(enabled: boolean): void {
      view.dispatch({ effects: vimCompartment.reconfigure(enabled ? [vim()] : []) })
      onVimModeChange?.(enabled)
    },
    setMidiEnabled(enabled: boolean): void {
      onMidiEnabledChange?.(enabled)
    },
    resetHydra(): void {
      onResetHydra?.()
    },
    exportScene(): void {
      onExport?.()
    },
    importScene(): void {
      onImport?.()
    },
    back: () => exitCell(true),
    cmDom: view.dom,
    setRemoteCursors(cursors: RemoteCursor[]): void {
      view.dispatch({ effects: setRemoteCursorsEffect.of(cursors) })
    },
    activeCellLang,
    insertSnippet(text: string, cursorBack = 0): void {
      const head = view.state.selection.main.head
      view.dispatch({
        changes: { from: head, insert: text },
        selection: { anchor: head + text.length - cursorBack },
        userEvent: 'input',
      })
      view.focus()
    },
  }
}

// Insert targets for the "=" cell token bar; `back` places the caret that
// many characters from the end (inside quotes/parens).
const EXPR_TOKENS: { label: string; insert: string; back: number }[] = [
  { label: 'slider', insert: 'slider("")', back: 2 },
  { label: 'midi', insert: 'midi("")', back: 2 },
  { label: 'time', insert: 'time()', back: 0 },
  { label: 'progress', insert: 'progress()', back: 0 },
  { label: 'field', insert: 'field("")', back: 2 },
  { label: '.add', insert: '.add()', back: 1 },
  { label: '.sub', insert: '.sub()', back: 1 },
  { label: '.mul', insert: '.mul()', back: 1 },
  { label: '.div', insert: '.div()', back: 1 },
  { label: '.mod', insert: '.mod()', back: 1 },
  { label: 'sin', insert: 'sin()', back: 1 },
  { label: 'cos', insert: 'cos()', back: 1 },
  { label: 'abs', insert: 'abs()', back: 1 },
  { label: 'floor', insert: 'floor()', back: 1 },
  { label: 'fract', insert: 'fract()', back: 1 },
  { label: 'min', insert: 'min()', back: 1 },
  { label: 'max', insert: 'max()', back: 1 },
  { label: 'clamp', insert: 'clamp()', back: 1 },
  { label: 'lerp', insert: 'lerp()', back: 1 },
  { label: 'tau', insert: 'tau', back: 0 },
]

// Canvases the pending-edit preview draws into, filled by this render and
// driven imperatively from main.ts — one per language, since each is a GPU
// surface of its own (a second hydra, a second post renderer). Only the open
// cell's shows, behind the code.
export interface PreviewMounts {
  hydra: HTMLCanvasElement
  post: HTMLCanvasElement
}

// `children` slots between the header and the CodeMirror host (app.tsx puts
// the session selector/bar there).
export function EditorPane(props: { ctl: EditorController; currentTable?: Accessor<string | null>; preview?: PreviewMounts; children?: JSX.Element }) {
  const { ctl } = props
  const previewLang = (): CodeLanguage | null => {
    const lang = ctl.activeCellLang()
    return lang === 'hydra' || lang === 'post' ? lang : null
  }
  const [collapsed, setCollapsed] = createSignal(window.matchMedia('(max-width: 767px)').matches)
  // The token bar targets thumbs; fine-pointer users type with completions.
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches
  // A code cell click (ctl.expand()) opens the panel if collapsed.
  createEffect(on(ctl.expandTick, () => setCollapsed(false), { defer: true }))
  // The settings menu is positioned fixed (not absolute) so it isn't clipped
  // by #editor-pane's overflow:hidden when the panel is collapsed.
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [menuPos, setMenuPos] = createSignal<{ top: number; right: number }>({ top: 0, right: 0 })
  let settingsWrap: HTMLDivElement | undefined
  let settingsBtn: HTMLButtonElement | undefined

  listenGlobal(document, 'click', (e) => {
    if (settingsWrap && !settingsWrap.contains(e.target as Node)) setSettingsOpen(false)
  })

  return (
    <div id="editor-pane" classList={{ 'editor-collapsed': collapsed(), previewing: !!previewLang() }}>
      <canvas
        class="editor-preview"
        classList={{ active: previewLang() === 'hydra' }}
        ref={(el) => { if (props.preview) props.preview.hydra = el }}
      />
      <canvas
        class="editor-preview"
        classList={{ active: previewLang() === 'post' }}
        ref={(el) => { if (props.preview) props.preview.post = el }}
      />
      <div class="editor-header">
        <button
          class="collapse-btn"
          aria-label={collapsed() ? 'Expand code panel' : 'Collapse code panel'}
          onClick={() => setCollapsed(!collapsed())}
        >
          {collapsed() ? '▸' : '▾'}
        </button>
        <span class="editor-title">{ctl.title()}</span>
        <button
          class="editor-back-btn"
          title="Back to the program"
          style={{ display: ctl.backVisible() ? '' : 'none' }}
          onClick={() => ctl.back()}
        >
          Back
        </button>
        <button class="run-btn" disabled={!ctl.canRun()} onClick={() => ctl.run()}>{ctl.runLabel()}</button>
        <DocsPopover currentTable={props.currentTable} />
        <div class="settings-wrap" ref={settingsWrap}>
          <button
            class="settings-btn"
            title="Settings"
            aria-label="Settings"
            ref={settingsBtn}
            onClick={(e) => {
              e.stopPropagation()
              const opening = !settingsOpen()
              if (opening && settingsBtn) {
                const r = settingsBtn.getBoundingClientRect()
                setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right })
              }
              setSettingsOpen(opening)
            }}
          >
            ⚙
          </button>
          <div
            class="settings-menu"
            classList={{ open: settingsOpen() }}
            style={{ top: `${menuPos().top}px`, right: `${menuPos().right}px` }}
          >
            <label class="settings-row">
              <input
                type="checkbox"
                checked={ctl.initialVimMode}
                onChange={(e) => ctl.setVimMode(e.currentTarget.checked)}
              />
              Vim mode
            </label>
            <label class="settings-row">
              <input
                type="checkbox"
                checked={ctl.initialMidiEnabled}
                onChange={(e) => ctl.setMidiEnabled(e.currentTarget.checked)}
              />
              MIDI
            </label>
            <button
              class="settings-row settings-action"
              title="Fixes hydra visuals stuck in an error state (same fix as resizing the window)"
              onClick={() => { ctl.resetHydra(); setSettingsOpen(false) }}
            >
              Reset visuals
            </button>
            <button
              class="settings-row settings-action"
              title="Copy the current scene to the clipboard as an example you can paste into samples.ts"
              onClick={() => { ctl.exportScene(); setSettingsOpen(false) }}
            >
              Export scene
            </button>
            <button
              class="settings-row settings-action"
              title="Load a scene from the clipboard (exported from here, or a SAMPLES entry)"
              onClick={() => { ctl.importScene(); setSettingsOpen(false) }}
            >
              Import scene
            </button>
          </div>
        </div>
      </div>
      {props.children}
      <Show when={coarsePointer && ctl.activeCellLang() === 'expr'}>
        <div class="editor-token-bar">
          {EXPR_TOKENS.map((t) => (
            <button
              class="token-btn"
              // Keep the editor focused — a focus loss would close the cell's
              // soft keyboard between taps.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => ctl.insertSnippet(t.insert, t.back)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </Show>
      <div class="editor-host" ref={(el) => el.appendChild(ctl.cmDom)} />
      <Show when={ctl.error()}>
        <div class="editor-error" style={{ display: 'block' }}>{ctl.error()}</div>
      </Show>
    </div>
  )
}
