// THE one CodeMirror view for the app. It is created detached and reparented
// into whichever surface currently owns editing (see editor-host.ts); nothing
// else may construct an EditorView, because the language-service client is a
// module singleton and the completion/hover/signature sources each close over
// this one view. Static highlighting for the read-only facades therefore goes
// through highlightInto(), not a second view.

import { EditorView, basicSetup } from 'codemirror'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import { LanguageSupport } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { keymap } from '@codemirror/view'
import { Prec, Compartment } from '@codemirror/state'
import { vim, getCM } from '@replit/codemirror-vim'
import { classHighlighter, highlightCode } from '@lezer/highlight'
import {
  viewNameCompletions, codeCompletions, typeHover, signatureHelp, dslHover,
  viewAtPos, minimalEdit, remoteCursorField, setRemoteCursorsEffect,
  type RemoteCursor, type SymbolCardData, type SigCardFactory,
} from '../editor-support.js'
import { createLangClient, type LangClient } from '../lang-client.js'
import type { LangSignatureHelp } from '../lang-service.js'
import type { CodeLanguage } from '../editable-tables.js'
import { numberScrub } from './num-scrub.js'
import { buildTablePreview } from './table-preview.js'
import type { Table } from '../dsl.js'

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

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text) node.textContent = text
  return node
}

// Tooltip cards, built as plain detached DOM for CodeMirror to adopt (they are
// static, so there is nothing for a component to react to).
function makeInfoNode(sig: string, info: string): () => { dom: HTMLElement } {
  return () => {
    const dom = el('div', 'cm-completion-info')
    dom.append(el('code', undefined, sig), el('p', undefined, info))
    return { dom }
  }
}

function makeSymbolCard({ display, docs, curated }: SymbolCardData): { dom: HTMLElement } {
  const dom = el('div', 'cm-completion-info cm-symbol-card')
  if (display) dom.append(el('code', undefined, display))
  if (docs) dom.append(el('p', undefined, docs))
  if (curated) dom.append(el('p', undefined, curated.info))
  return { dom }
}

const makeSigCard: SigCardFactory = (sig: LangSignatureHelp) => {
  const item = sig.signatures[Math.min(sig.activeSignature, sig.signatures.length - 1)]
  const code = el('code')
  code.append(item.prefix)
  item.params.forEach((p, i) => {
    if (i > 0) code.append(item.separator)
    code.append(el('span', i === sig.activeParameter ? 'cm-signature-param-active' : undefined, p.label))
  })
  code.append(item.suffix)
  const dom = el('div', 'cm-signature-help')
  dom.append(code)
  if (sig.signatures.length > 1) {
    dom.append(el('span', 'cm-signature-overloads', `+${sig.signatures.length - 1} overload${sig.signatures.length > 2 ? 's' : ''}`))
  }
  const docs = item.params[sig.activeParameter]?.docs
  if (docs) dom.append(el('p', undefined, docs))
  return { dom }
}

// What the view needs to know about the target it is currently editing.
// createEditorHost installs this; the defaults make a parked view inert.
export interface CmContext {
  label(): string
  lang(): CodeLanguage
  // Mod-Enter.
  commit(): void
  // Escape; false falls through to vim (or does nothing).
  escape(): boolean
  // The user edited the doc — recompute dirtiness.
  changed(): void
}

export interface CmOptions {
  getViews?: () => Map<string, Table>
  onCaretView?: (name: string) => void
  getPlayIndex?: () => number
  vimMode?: boolean
  // Multiplayer presence: the cell this view is a window onto plus the cursor
  // offset.
  onCursor?: (cell: string, head: number) => void
  // Multiplayer live typing: fired only for doc changes the *user* made, not
  // programmatic setDoc — re-announcing those would echo every mirrored remote
  // keystroke back.
  onEdit?: (cell: string, code: string) => void
}

export interface CmEditor {
  dom: HTMLElement
  setContext(ctx: CmContext): void
  getCode(): string
  // preserveView applies the code as a minimal splice so the caret and scroll
  // ride the unchanged text (a scrub to a past run shouldn't jump either).
  setDoc(code: string, preserveView?: boolean): void
  // Reparent the view; without an argument it returns to wherever it last was.
  mount(into?: HTMLElement): void
  unmount(): void
  focus(): void
  vimInsertActive(): boolean
  setVimMode(enabled: boolean): void
  insertSnippet(text: string, cursorBack?: number): void
  setRemoteCursors(cursors: RemoteCursor[]): void
}

export function createCmEditor(
  { getViews, onCaretView, getPlayIndex, vimMode = true, onCursor, onEdit }: CmOptions = {},
): CmEditor {
  let ctx: CmContext = {
    label: () => '', lang: () => 'dsl', commit: () => {}, escape: () => false, changed: () => {},
  }
  const lang = (): CodeLanguage => ctx.lang()

  const vimCompartment = new Compartment()
  let lastCaretView: string | null = null
  let programmaticDoc = false
  let parent: HTMLElement | null = null

  const langService = getLangClient()

  const view = new EditorView({
    doc: '',
    extensions: [
      vimCompartment.of(vimMode ? [vim()] : []),
      basicSetup,
      // Bare language, not javascript(): its bundled completion sources would
      // duplicate what the language service returns.
      new LanguageSupport(javascriptLanguage),
      javascriptLanguage.data.of({ autocomplete: viewNameCompletions(getViews, lang) }),
      javascriptLanguage.data.of({ autocomplete: codeCompletions(langService, makeInfoNode, makeSymbolCard, lang) }),
      ...(langService ? [typeHover(langService, makeSymbolCard, lang), signatureHelp(langService, makeSigCard, lang)] : []),
      EditorView.updateListener.of((u) => {
        if (!(u.selectionSet || u.docChanged)) return
        if (u.docChanged) ctx.changed()
        onCursor?.(ctx.label(), u.state.selection.main.head)
        if (u.docChanged && !programmaticDoc && onEdit) onEdit(ctx.label(), u.state.doc.toString())
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
        { key: 'Mod-Enter', run: () => { ctx.commit(); return true } },
        // The host decides what Escape means (and defers to vim's insert mode);
        // false falls through to vim's own binding.
        { key: 'Escape', run: () => ctx.escape() },
      ])),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'auto' },
      }),
    ],
  })

  return {
    dom: view.dom,
    setContext(next: CmContext): void { ctx = next },
    getCode: () => view.state.doc.toString(),
    setDoc(code: string, preserveView = false): void {
      const changes = preserveView
        ? minimalEdit(view.state.doc.toString(), code)
        : { from: 0, to: view.state.doc.length, insert: code }
      // Programmatic replacements must not read as the user typing — the update
      // listener runs synchronously inside the dispatch.
      programmaticDoc = true
      try {
        view.dispatch({ changes })
      } finally {
        programmaticDoc = false
      }
    },
    mount(into?: HTMLElement): void {
      const target = into ?? parent
      if (!target) return
      parent = target
      target.appendChild(view.dom)
      view.requestMeasure()
    },
    unmount(): void {
      parent = view.dom.parentElement ?? parent
      view.dom.remove()
    },
    focus: () => view.focus(),
    vimInsertActive: () => !!getCM(view)?.state?.vim?.insertMode,
    setVimMode(enabled: boolean): void {
      view.dispatch({ effects: vimCompartment.reconfigure(enabled ? [vim()] : []) })
    },
    insertSnippet(text: string, cursorBack = 0): void {
      const head = view.state.selection.main.head
      view.dispatch({
        changes: { from: head, insert: text },
        selection: { anchor: head + text.length - cursorBack },
        userEvent: 'input',
      })
      view.focus()
    },
    setRemoteCursors(cursors: RemoteCursor[]): void {
      view.dispatch({ effects: setRemoteCursorsEffect.of(cursors) })
    },
  }
}

// Static syntax highlighting for the facades: the same parser the live view
// uses, rendered as spans into a plain element (never a second EditorView).
export function highlightInto(into: HTMLElement, code: string): void {
  into.textContent = ''
  highlightCode(
    code,
    javascriptLanguage.parser.parse(code),
    classHighlighter,
    (text, classes) => into.append(classes ? el('span', classes, text) : text),
    () => into.append(el('br')),
  )
}
