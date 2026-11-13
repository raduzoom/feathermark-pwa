// The block menu's state in the editor: when "/" opens it, how typing filters and closes it (specs/editor.md
// "Block menu"). No view: transactions on an EditorState, as the editor would make them.
import { EditorState } from '@codemirror/state'
import { expect, test } from 'vitest'
import { blockMenuField, closeBlockMenu, menuOf } from '../../src/editor/block-menu.ts'
import { markdown } from '../../src/editor/live-preview.ts'

const make = (doc: string) => EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [markdown(), blockMenuField] })
const type = (s: EditorState, text: string) => {
  for (const ch of text) {
    const at = s.selection.main.head
    s = s.update({ changes: { from: at, insert: ch }, selection: { anchor: at + ch.length }, userEvent: 'input.type' }).state
  }
  return s
}

test('typing / at a line start opens the menu', () => {
  const s = type(make('a\n'), '/')
  const m = menuOf(s)!
  expect(m.trigger).toEqual({ from: 2, to: 3 })
  expect(m.items).not.toContain('scan')
  expect(m.items.length).toBe(10)
  expect(menuOf(type(make('- [ ] '), '/'))).not.toBe(null)
})

test('/ mid-sentence does not open it', () => {
  expect(menuOf(type(make('and'), '/'))).toBe(null)
  expect(menuOf(type(make('```\n'), '/'))).toBe(null)
})

test('typing filters and a leading space closes', () => {
  let s = type(make(''), '/h')
  expect(menuOf(s)!.items).toEqual(['heading1', 'heading2', 'heading3'])
  expect(menuOf(s)!.query).toBe('h')
  s = type(s, '2')
  expect(menuOf(s)!.items).toEqual(['heading2'])
  const spaced = type(make(''), '/ ')
  expect(menuOf(spaced)).toBe(null)
  expect(spaced.doc.toString()).toBe('/ ')
  expect(menuOf(type(make(''), '/zz'))).toBe(null)
})

test('25 characters close it', () => {
  const s = type(make(''), '/heading' + ' '.repeat(17))
  expect(menuOf(s)!.query.length).toBe(24)
  expect(menuOf(type(s, ' '))).toBe(null)
})

test('Escape closes and keeps the typed text', () => {
  const s = type(make(''), '/co')
  const closed = s.update({ effects: closeBlockMenu.of(null) }).state
  expect(menuOf(closed)).toBe(null)
  expect(closed.doc.toString()).toBe('/co')
})

test('moving the caret off the query closes it', () => {
  const s = type(make('x\n'), '/q')
  expect(menuOf(s.update({ selection: { anchor: 0 } }).state)).toBe(null)
})
