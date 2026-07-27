// Which of the many editable surfaces owns the app's single CodeMirror view.
// N code facades are on screen; at most one is *promoted* — the view is
// reparented into its mount and loaded with its text. Demoting commits a dirty
// buffer the way the grid's inline inputs commit on blur; Escape demotes
// without committing, which is what leaving a cell has always meant.

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
  dirty(label: string): boolean
  error(label: string): string | null
  setError(msg: string | null, label?: string): void
  // Recompute dirtiness after an out-of-band change (a grid edit, an apply).
  refresh(): void
  insert(text: string, cursorBack?: number): void
}

export function createEditorHost(
  cm: CmEditor,
  { onDemote }: { onDemote?: (label: string) => void } = {},
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
    t.onCommit(text)
    // The committed text is the target's value now — nothing left to apply.
    setTarget({ ...t, text })
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
      cm.focus()
      return
    }
    demote()
    setTarget(next)
    cm.mount(mount)
    cm.setDoc(next.text)
    refresh()
    cm.focus()
  }

  cm.setContext({
    label: () => promoted() ?? '',
    lang: () => target()?.lang ?? 'dsl',
    commit,
    // Vim owns Escape (leave insert mode); only treat it as "demote" once vim
    // is out of insert mode (or off), so a code cell's Escape doesn't swallow
    // the modal exit vim users expect.
    escape: () => {
      if (!target() || cm.vimInsertActive()) return false
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
