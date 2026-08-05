// Which of the many editable surfaces owns the app's single CodeMirror view.
// N code facades are on screen; at most one is *promoted* — the view is
// reparented into its mount and loaded with its text. Demoting commits a dirty
// buffer the way the grid's inline inputs commit on blur; dismissing an "="
// overlay with Escape demotes without committing, which is what leaving a cell
// has always meant.

import { createSignal, type Accessor } from 'solid-js'
import type { CodeLanguage } from './editable-tables.js'
import type { CmEditor } from './ui/cm-editor.js'

export interface EditTarget {
  // `${table}[${row}].${col}`, or whatever names this buffer uniquely.
  label: string
  lang: CodeLanguage
  text: string
  onCommit(text: string): void
  // Defaults to "the buffer differs from the text it was promoted with". A
  // target whose Apply commits more than its own text (pending grid edits, the
  // whole program) overrides it.
  isDirty?(text: string, baseline: string): boolean
  // Folds this cell's committed text back into the running program, for the
  // sketch drawn behind the target while it is promoted. Only hydra/post code
  // cells have one — see main.ts's previewHook and ui/facade.tsx's
  // previewMounts.
  preview?(text: string): string | null
  // The row's identifying cells (`beat 3`, `setCode`, `o0`) — a surface
  // detached from the row (the overlay, the phone popover) has to say which
  // row it edits without reading the code.
  context?: string[]
}

export interface EditorHost {
  // Move the view into `mount` (omitted: back where it last was) and load the
  // target's text. Re-promoting the live target only refocuses it.
  promote(target: EditTarget, mount?: HTMLElement): void
  demote(commit?: boolean): void
  // Fire the promoted target's onCommit, if the buffer has anything to commit.
  commit(): void
  // The target's stored text changed under us (a scrub, a room merge).
  load(text: string, opts?: { preserveView?: boolean }): void
  promoted: Accessor<string | null>
  // The stored text the promoted buffer is measured against — advanced by each
  // commit, so a watcher can tell "the cell changed because we just applied"
  // from "the cell changed under us".
  committed: Accessor<string | null>
  dirty(label: string): boolean
  error(label: string): string | null
  setError(msg: string | null, label?: string): void
  // Recompute dirtiness after an out-of-band change (a grid edit, an apply).
  refresh(): void
  insert(text: string, cursorBack?: number): void
}

export function createEditorHost(
  cm: CmEditor,
  { onPromote, onDemote }: { onPromote?: (target: EditTarget) => void; onDemote?: (label: string) => void } = {},
): EditorHost {
  const [target, setTarget] = createSignal<EditTarget | null>(null)
  const [errors, setErrors] = createSignal<ReadonlyMap<string, string>>(new Map())
  // Bumped on every doc change so dirty() re-reads the live buffer.
  const [tick, setTick] = createSignal(0)

  const promoted = (): string | null => target()?.label ?? null
  const refresh = (): void => { setTick((n) => n + 1) }

  const isDirty = (t: EditTarget): boolean => {
    const text = cm.getCode()
    return t.isDirty ? t.isDirty(text, t.text) : text !== t.text
  }

  function commit(): void {
    const t = target()
    // Read the live buffer, not the dirty() signal: a grid Ctrl-Enter commits
    // and runs synchronously, before the signal's refresh has caught up.
    if (!t || !isDirty(t)) return
    const text = cm.getCode()
    // Advance the baseline BEFORE the write, not after: onCommit reaches the
    // store synchronously, and a watcher reacting to that write reads
    // `committed()` to tell our own edit from someone else's. Advancing
    // afterwards let the panel see this commit as a foreign one and flush the
    // buffer mid-Apply, blanking the cell the user was working in.
    setTarget({ ...t, text })
    t.onCommit(text)
    refresh()
  }

  function demote(commitFirst = true): void {
    const t = target()
    if (!t) return
    if (commitFirst) commit()
    setTarget(null)
    cm.unmount()
    refresh()
    onDemote?.(t.label)
  }

  function promote(next: EditTarget, mount?: HTMLElement): void {
    if (promoted() === next.label) {
      // Same cell: adopt the caller's fresher target (the panel rebuilds these
      // on every store change, so it carries the cell's current stored text and
      // a commit bound to it) without touching the buffer, which holds edits
      // the user has not applied yet. Re-mount too — anything that took the
      // view away (a rebound slot, a surface that closed) leaves this cell
      // looking empty and unresponsive, and re-clicking it is how a performer
      // expects to get it back.
      setTarget(next)
      cm.mount(mount)
      refresh()
      cm.focus()
      return
    }
    demote()
    setTarget(next)
    cm.mount(mount)
    cm.setDoc(next.text)
    refresh()
    cm.focus()
    // A promote is an explicit "edit this" click, so typing must insert
    // immediately — vim's normal mode would eat the first keystrokes as
    // commands (and with them, any autocompletion). Expr cells append at the
    // line end, the quick-edit spot; there Escape steps insert → normal →
    // dismiss.
    cm.enterInsert(next.lang === 'expr')
    onPromote?.(next)
  }

  cm.setContext({
    label: () => promoted() ?? '',
    lang: () => target()?.lang ?? 'dsl',
    commit,
    // Vim owns Escape in a code buffer — it is the modal exit (insert →
    // normal, visual → normal, cancel a pending operator), pressed constantly
    // and never meant as "give the view back". Only an "=" overlay leaves on
    // Escape: it is a quick edit anchored to its cell, and dismissing it is
    // what Escape means there — once vim is out of insert mode (or off).
    escape: () => {
      const t = target()
      if (!t || t.lang !== 'expr' || cm.vimInsertActive()) return false
      demote(false)
      return true
    },
    changed: refresh,
  })

  return {
    promote,
    demote,
    commit,
    load(text: string, { preserveView = false }: { preserveView?: boolean } = {}): void {
      const t = target()
      if (t) setTarget({ ...t, text })
      cm.setDoc(text, preserveView)
      refresh()
    },
    promoted,
    committed: () => target()?.text ?? null,
    dirty(label: string): boolean {
      tick()
      const t = target()
      return !!t && t.label === label && isDirty(t)
    },
    error: (label: string) => errors().get(label) ?? null,
    setError(msg: string | null, label = promoted() ?? ''): void {
      const next = new Map(errors())
      if (msg == null) next.delete(label)
      else next.set(label, msg)
      setErrors(next)
    },
    refresh,
    insert: (text: string, cursorBack?: number) => cm.insertSnippet(text, cursorBack),
  }
}
