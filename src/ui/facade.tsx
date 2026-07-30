// The surfaces that stand in for the app's single CodeMirror view: one static,
// syntax-highlighted facade per code-bearing row (click to promote the live
// view into it), an anchored overlay for "=" expression cells, and the mobile
// full-screen popover. None of them is an EditorView — the facades highlight
// through cm-editor's highlightInto, so exactly one view exists app-wide.

import { For, Show, createEffect, onCleanup, onMount, createSignal } from 'solid-js'
import { highlightInto } from './cm-editor.js'
import type { EditorHost, EditTarget } from '../editor-host.js'

// Canvases the pending-edit preview draws into — one per language, since each
// is a GPU surface of its own. They obey the same one-instance rule the editor
// view does: created once, detached, then reparented behind whichever surface
// is live (a WebGL/WebGPU context does not survive being recreated). main.ts
// hands them to initHydra/initPost at boot via app.tsx's CanvasMounts.
export type PreviewMounts = Record<'hydra' | 'post', HTMLCanvasElement>

function previewCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.className = 'editor-preview'
  return c
}

export const previewMounts: PreviewMounts = { hydra: previewCanvas(), post: previewCanvas() }

const previewFor = (t: EditTarget): HTMLCanvasElement | null =>
  t.preview && (t.lang === 'hydra' || t.lang === 'post') ? previewMounts[t.lang] : null

// Move the target's preview canvas behind `root` while it is live, and out
// again when it isn't — appendChild, exactly as the editor view is mounted.
function mountPreview(root: () => HTMLElement, canvas: () => HTMLCanvasElement | null): void {
  createEffect(() => {
    const c = canvas()
    if (!c) return
    c.classList.add('active')
    root().appendChild(c)
    onCleanup(() => { c.classList.remove('active'); c.remove() })
  })
}

// Insert targets for the "=" cell token bar; `back` places the caret that
// many characters from the end (inside quotes/parens).
export const EXPR_TOKENS: { label: string; insert: string; back: number }[] = [
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

// The "=" marker is the cell's storage convention, not part of the expression:
// an overlay edits the bare expression and re-marks it on the way back. Blank
// and plain-numeric text stay unmarked so a number column can store a number.
function withExprMarker(text: string): string {
  const t = text.trim()
  return t === '' || t.startsWith('=') || Number.isFinite(Number(t)) ? text : `=${t}`
}

const exprTarget = (t: EditTarget): EditTarget => t.lang !== 'expr' ? t : {
  ...t,
  text: t.text.startsWith('=') ? t.text.slice(1) : t.text,
  onCommit: (text) => t.onCommit(withExprMarker(text)),
}

function TokenBar(props: { host: EditorHost }) {
  return (
    <div class="editor-token-bar">
      <For each={EXPR_TOKENS}>
        {(t) => (
          <button
            class="token-btn"
            // Keep the editor focused — a focus loss would close the cell's
            // soft keyboard between taps.
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => props.host.insert(t.insert, t.back)}
          >
            {t.label}
          </button>
        )}
      </For>
    </div>
  )
}

// The live view's chrome, shared by the overlay and the mobile popover: header,
// the mount the view is reparented into, the touch token bar and the error slot.
// Promotes on mount and closes when something else takes the view (Escape, or
// another facade).
function PromotedSurface(props: { host: EditorHost; target: EditTarget; onClose: () => void }) {
  let mount!: HTMLDivElement
  let surface!: HTMLDivElement
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches
  let opened = false
  const live = (): boolean => props.host.promoted() === props.target.label
  const preview = (): HTMLCanvasElement | null => live() ? previewFor(props.target) : null

  onMount(() => props.host.promote(props.target, mount))
  onCleanup(() => {
    if (live()) props.host.demote()
  })
  createEffect(() => {
    if (live()) opened = true
    else if (opened) props.onClose()
  })
  mountPreview(() => surface, preview)

  return (
    <div class="editor-surface" classList={{ previewing: !!preview() }} ref={surface}>
      <div class="editor-surface-head">
        <span class="editor-surface-label">{props.target.label}</span>
        <button
          class="run-btn"
          disabled={!props.host.dirty(props.target.label)}
          onClick={() => props.host.commit()}
        >
          Apply
        </button>
        <button class="editor-surface-close" aria-label="Close" onClick={() => props.onClose()}>×</button>
      </div>
      <div class="editor-mount" ref={mount} />
      <Show when={coarsePointer && props.target.lang === 'expr'}>
        <TokenBar host={props.host} />
      </Show>
      <Show when={props.host.error(props.target.label)}>
        {(msg) => <div class="editor-error">{msg()}</div>}
      </Show>
    </div>
  )
}

// One row's code, statically highlighted and capped in height. Clicking it
// hands the live view to that row; `onPromote` overrides that (mobile opens the
// popover instead).
export function CodeFacade(props: {
  host: EditorHost
  target: EditTarget
  runLabel?: string
  onPromote?: (target: EditTarget) => void
}) {
  let mount!: HTMLDivElement
  let pre!: HTMLPreElement
  let facade!: HTMLDivElement
  const live = (): boolean => props.host.promoted() === props.target.label
  // onPromote means something else (the mobile popover) hosts the live view for
  // this row — and the preview goes wherever the view went.
  const preview = (): HTMLCanvasElement | null =>
    live() && !props.onPromote ? previewFor(props.target) : null

  // What is currently painted into `pre` — highlighting is the expensive part of
  // a store change, and every store event (every MIDI message, every slider
  // drag frame) otherwise re-parses every facade on screen.
  let shown: string | null = null
  createEffect(() => {
    if (live() || props.target.text === shown) return
    shown = props.target.text
    highlightInto(pre, props.target.text)
  })
  onCleanup(() => {
    if (live()) props.host.demote()
  })
  mountPreview(() => facade, preview)

  const open = (): void => {
    if (props.onPromote) props.onPromote(props.target)
    else props.host.promote(props.target, mount)
  }

  return (
    // data-label is how the grid's code chip finds this facade to promote it.
    <div class="code-facade" classList={{ 'facade-live': live(), previewing: !!preview() }} data-lang={props.target.lang} data-label={props.target.label} ref={facade}>
      <div class="facade-head">
        <span class="facade-label">{props.target.label}</span>
        <button
          class="run-btn facade-run"
          disabled={!props.host.dirty(props.target.label)}
          onClick={() => props.host.commit()}
        >
          {props.runLabel ?? 'Apply'}
        </button>
      </div>
      <pre class="facade-code" ref={pre} tabindex="0" onClick={open} onFocus={open} />
      <div class="editor-mount" ref={mount} />
      <Show when={props.host.error(props.target.label)}>
        {(msg) => <div class="editor-error">{msg()}</div>}
      </Show>
    </div>
  )
}

// A "=" cell edits as a bare expression in an overlay anchored under its grid
// cell — generously wider than the column so the formula is readable.
export function ExprOverlay(props: {
  host: EditorHost
  target: EditTarget
  anchor: HTMLElement
  onClose: () => void
}) {
  const [pos, setPos] = createSignal<{ left: number; top: number }>({ left: 0, top: 0 })
  let box!: HTMLDivElement
  const target = exprTarget(props.target)

  onMount(() => {
    const r = props.anchor.getBoundingClientRect()
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - box.offsetWidth - 8)),
      top: r.bottom + 2,
    })
  })

  return (
    <div class="expr-overlay" ref={box} style={{ left: `${pos().left}px`, top: `${pos().top}px` }}>
      <PromotedSurface host={props.host} target={target} onClose={props.onClose} />
    </div>
  )
}

// The phone surface: the facades are unreadably small there, so promoting opens
// the view full-screen (same pattern as the docs popover).
export function MobileEditorPopover(props: { host: EditorHost; target: EditTarget; onClose: () => void }) {
  const target = exprTarget(props.target)

  return (
    <div class="mobile-editor-popover">
      <PromotedSurface host={props.host} target={target} onClose={props.onClose} />
    </div>
  )
}
