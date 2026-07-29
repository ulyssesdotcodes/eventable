import { test } from 'node:test'
import assert from 'node:assert/strict'
import { minimalEdit, programText } from '../src/editor-support.js'
import { createEditorHost } from '../src/editor-host.js'
import type { CmContext, CmEditor } from '../src/ui/cm-editor.js'

// Apply a {from,to,insert} splice the way CodeMirror would, so the tests pin
// the behavioral contract (result text + which span moved), not the internals.
function apply(a: string, edit: { from: number; to: number; insert: string }): string {
  return a.slice(0, edit.from) + edit.insert + a.slice(edit.to)
}

test('minimalEdit: the splice turns a into b', () => {
  for (const [a, b] of [
    ['hello world', 'hello brave world'], // insert in the middle
    ['line1\nline2\nline3', 'line1\nline3'], // delete a middle line
    ['abc', 'xyz'], // full replace, no shared affixes
    ['', 'seeded'], // grow from empty
    ['drop me', ''], // shrink to empty
  ]) {
    assert.equal(apply(a, minimalEdit(a, b)), b, `${JSON.stringify(a)} -> ${JSON.stringify(b)}`)
  }
})

test('minimalEdit: identical text is an empty no-op splice', () => {
  const edit = minimalEdit('same text', 'same text')
  assert.equal(edit.from, edit.to)
  assert.equal(edit.insert, '')
})

test('minimalEdit: leaves the shared prefix and suffix untouched', () => {
  // Only the "2" -> "9" in the middle should move; a caret in the prefix or
  // suffix must keep its offset, which is what preserves the editor view.
  const edit = minimalEdit('const beat = 2 // keep', 'const beat = 9 // keep')
  assert.equal(edit.from, 13)
  assert.equal(edit.to, 14)
  assert.equal(edit.insert, '9')
})

// A stand-in for the one CodeMirror view the host drives, so the promote/demote
// contract can be exercised without a DOM.
function fakeCm() {
  let doc = ''
  let ctx: CmContext | null = null
  const state = { vimInsert: false, mounted: false, inserts: 0 }
  const cm: CmEditor = {
    dom: null as unknown as HTMLElement,
    setContext: (next) => { ctx = next },
    getCode: () => doc,
    setDoc: (code) => { doc = code },
    mount: () => { state.mounted = true },
    unmount: () => { state.mounted = false },
    focus: () => {},
    enterInsert: () => { state.inserts++ },
    vimInsertActive: () => state.vimInsert,
    setVimMode: () => {},
    insertSnippet: () => {},
    setRemoteCursors: () => {},
  }
  return { cm, state, ctx: () => ctx!, type: (text: string) => { doc = text; ctx!.changed() } }
}

test('editor host: one target holds the view, and taking it commits what the last one typed', () => {
  const { cm, state, ctx, type } = fakeCm()
  const commits: string[] = []
  const host = createEditorHost(cm)

  host.promote({ label: 'a', lang: 'dsl', text: 'one', onCommit: (t) => commits.push(`a:${t}`) })
  assert.equal(host.promoted(), 'a')
  assert.equal(cm.getCode(), 'one')
  assert.equal(state.mounted, true)

  type('one edited')
  assert.equal(host.dirty('a'), true)
  assert.equal(host.dirty('b'), false, 'a facade that does not hold the view has nothing to apply')

  host.promote({ label: 'b', lang: 'expr', text: 'two', onCommit: (t) => commits.push(`b:${t}`) })
  assert.deepEqual(commits, ['a:one edited'])
  assert.equal(host.promoted(), 'b')
  assert.equal(ctx().lang(), 'expr', 'the view is told which language service to serve')
  assert.equal(state.inserts, 2, 'every promote enters insert mode — a click means "type here", and vim normal mode would eat the first keystrokes')
})

test('editor host: committing re-baselines, Escape leaves without committing', () => {
  const { cm, state, ctx, type } = fakeCm()
  const commits: string[] = []
  const host = createEditorHost(cm)
  host.promote({ label: 'a', lang: 'dsl', text: 'one', onCommit: (t) => commits.push(t) })

  type('edited')
  host.commit()
  host.commit()
  assert.deepEqual(commits, ['edited'], 'the committed text is the value now — nothing left to apply')
  assert.equal(host.dirty('a'), false)

  type('unsaved')
  state.vimInsert = true
  assert.equal(ctx().escape(), false, 'vim owns Escape while in insert mode')
  assert.equal(host.promoted(), 'a')

  state.vimInsert = false
  assert.equal(ctx().escape(), true)
  assert.equal(host.promoted(), null)
  assert.deepEqual(commits, ['edited'], 'leaving a cell discards, as it always has')
})

test('programText: joins the code table rows in storage order, dropping blanks', () => {
  assert.equal(
    programText([{ code: 'const a = 1' }, { code: '   ' }, { code: '' }, { code: 'define("x", a)' }]),
    'const a = 1\ndefine("x", a)',
    'blank/whitespace fragments are skipped, the rest join with newlines',
  )
  // Order is the array's, not sorted — a fragment's const must reach the next.
  assert.equal(programText([{ code: 'b' }, { code: 'a' }]), 'b\na')
  assert.equal(programText([]), '')
  assert.equal(programText([{}]), '', 'a row with no code cell contributes nothing')
})
