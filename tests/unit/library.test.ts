import { beforeEach, expect, test } from 'vitest'
import { Library } from '../../src/core/library/library.ts'
import { LibraryError, type View } from '../../src/core/library/types.ts'
import { DAY, fakeClock } from './support/clock.ts'

let clock: ReturnType<typeof fakeClock>
let lib: Library
beforeEach(() => {
  clock = fakeClock()
  lib = new Library(clock)
})

const ids = (view: View) => lib.notes(view).map((n) => n.title)
const later = (ms = 1) => clock.advance(ms)

test('notes keep their exact text', () => {
  const title = ''
  const body = 'line one\r\nCafé\ttab  \n\n  trailing  '
  const n = lib.createNote({ title, body })
  expect(lib.note(n.id)!.title).toBe(title)
  expect(lib.note(n.id)!.body).toBe(body)
  lib.updateNote(n.id, { title: ' T ' })
  expect(lib.note(n.id)!.title).toBe(' T ')
  expect(lib.note(n.id)!.body).toBe(body)
})

test('modified moves only when the title or body bytes change', () => {
  const nb = lib.createNotebook('Home', null)
  const tag = lib.createTag('x')
  const n = lib.createNote({ title: 'a', body: 'b' })
  const t0 = lib.note(n.id)!.modified
  later(1000)
  lib.setPinned(n.id, true)
  lib.moveNote(n.id, nb.id)
  lib.setTags(n.id, [tag.id])
  lib.trashNote(n.id)
  lib.restoreNote(n.id)
  lib.updateNote(n.id, { title: 'a', body: 'b' })
  expect(lib.note(n.id)!.modified).toBe(t0)
  lib.updateNote(n.id, { body: 'b!' })
  expect(lib.note(n.id)!.modified).toBe(t0 + 1000)
  later(5)
  lib.updateNote(n.id, { body: 'é' })
  later(5)
  lib.updateNote(n.id, { body: 'é' }) // different bytes, same look: still a change
  expect(lib.note(n.id)!.modified).toBe(t0 + 1010)
})

test('views list and order notes as data-model.md says: All', () => {
  const a = lib.createNote({ title: 'A' })
  later()
  lib.createNote({ title: 'B' })
  later()
  const c = lib.createNote({ title: 'C' })
  lib.setPinned(a.id, true)
  lib.trashNote(c.id)
  expect(ids({ kind: 'all' })).toEqual(['A', 'B'])
})

test('views: ties on modified are broken by id descending', () => {
  const a = lib.createNote({ title: 'A' })
  const b = lib.createNote({ title: 'B' }) // same ms, larger id (monotonic within the ms is not assumed)
  const order = [a, b].sort((x, y) => (x.id < y.id ? 1 : -1)).map((n) => n.title)
  expect(ids({ kind: 'all' })).toEqual(order)
})

test('views: Pinned sorts by modified only, Trash by trash time', () => {
  const a = lib.createNote({ title: 'A' })
  later()
  const b = lib.createNote({ title: 'B' })
  lib.setPinned(a.id, true)
  lib.setPinned(b.id, true)
  expect(ids({ kind: 'pinned' })).toEqual(['B', 'A'])
  lib.trashNote(b.id)
  later()
  lib.trashNote(a.id)
  expect(ids({ kind: 'trash' })).toEqual(['A', 'B'])
})

test('views: a notebook includes sub-notebooks; a tag lists its notes', () => {
  const home = lib.createNotebook('Home', null)
  const kitchen = lib.createNotebook('Kitchen', home.id)
  const tag = lib.createTag('to-do')
  lib.createNote({ title: 'In home', notebookId: home.id })
  later()
  lib.createNote({ title: 'In kitchen', notebookId: kitchen.id, tagIds: [tag.id] })
  later()
  lib.createNote({ title: 'Root' })
  expect(ids({ kind: 'notebook', id: home.id })).toEqual(['In kitchen', 'In home'])
  expect(ids({ kind: 'notebook', id: kitchen.id })).toEqual(['In kitchen'])
  expect(ids({ kind: 'tag', id: tag.id })).toEqual(['In kitchen'])
})

test('recent keeps 7 days and at most 50', () => {
  lib.createNote({ title: 'old', modified: clock() - 7 * DAY - 1 })
  lib.createNote({ title: 'edge', modified: clock() - 7 * DAY })
  for (let i = 0; i < 55; i++) lib.createNote({ title: `n${i}`, modified: clock() - i })
  const recent = ids({ kind: 'recent' })
  expect(recent).toHaveLength(50)
  expect(recent).not.toContain('old')
  expect(recent[0]).toBe('n0')
  lib.setPinned(lib.notes({ kind: 'all' }).find((n) => n.title === 'n10')!.id, true)
  expect(ids({ kind: 'recent' })[0]).toBe('n0')
})

test('counts include sub-notebooks and leave out the Trash', () => {
  const home = lib.createNotebook('Home', null)
  const kitchen = lib.createNotebook('Kitchen', home.id)
  lib.createNote({ notebookId: home.id })
  const k = lib.createNote({ notebookId: kitchen.id })
  const t = lib.createNote({ notebookId: kitchen.id })
  lib.setPinned(k.id, true)
  lib.trashNote(t.id)
  const c = lib.counts()
  expect([c.all, c.pinned, c.trash]).toEqual([2, 1, 1])
  expect(c.notebooks.get(home.id)).toBe(2)
  expect(c.notebooks.get(kitchen.id)).toBe(1)
})

test("deleting a notebook sends its subtree's notes to the Trash at the root and keeps earlier trash times", () => {
  const home = lib.createNotebook('Home', null)
  const kitchen = lib.createNotebook('Kitchen', home.id)
  const a = lib.createNote({ notebookId: home.id })
  const b = lib.createNote({ notebookId: kitchen.id })
  lib.trashNote(b.id)
  const firstTrash = lib.note(b.id)!.trashedAt
  later(10)
  lib.deleteNotebook(home.id)
  expect(lib.notebooks()).toEqual([])
  expect(lib.note(a.id)).toMatchObject({ notebookId: null, trashedAt: clock() })
  expect(lib.note(b.id)).toMatchObject({ notebookId: null, trashedAt: firstTrash })
})

test('moving a notebook inside itself is refused', () => {
  const home = lib.createNotebook('Home', null)
  const kitchen = lib.createNotebook('Kitchen', home.id)
  expect(() => lib.moveNotebook(home.id, kitchen.id)).toThrow(expect.objectContaining({ kind: 'notebookCycle' }))
  expect(() => lib.moveNotebook(home.id, home.id)).toThrow(LibraryError)
  expect(lib.descendants(home.id)).toEqual([home.id, kitchen.id])
})

test("tag names are unique ignoring case and can't be blank", () => {
  const t = lib.createTag('Travel')
  expect(() => lib.createTag('travel')).toThrow(expect.objectContaining({ kind: 'duplicateTagName' }))
  expect(() => lib.createTag('  ')).toThrow(expect.objectContaining({ kind: 'invalidName' }))
  lib.renameTag(t.id, 'TRAVEL')
  expect(lib.tags()[0]!.name).toBe('TRAVEL')
})

test('deleting a tag removes it from notes without changing modified', () => {
  const t = lib.createTag('x')
  const n = lib.createNote({ tagIds: [t.id] })
  const m = lib.note(n.id)!.modified
  later(10)
  lib.deleteTag(t.id)
  expect(lib.note(n.id)).toMatchObject({ tagIds: [], modified: m })
})

test('purge removes notes trashed at least 30 days ago', () => {
  const a = lib.createNote({ title: 'a' })
  const b = lib.createNote({ title: 'b' })
  lib.trashNote(a.id)
  later(1)
  lib.trashNote(b.id)
  later(30 * DAY - 1)
  expect(lib.purgeExpiredTrash()).toBe(1)
  expect(lib.note(a.id)).toBeUndefined()
  expect(lib.note(b.id)).toBeDefined()
  expect(lib.emptyTrash()).toBe(1)
})

test('subscribers hear one notification per real change and none for a no-op', () => {
  let heard = 0
  const off = lib.subscribe(() => heard++)
  const n = lib.createNote({ title: 'a' })
  lib.setPinned(n.id, false)
  lib.updateNote(n.id, { title: 'a' })
  lib.setPinned(n.id, true)
  expect(heard).toBe(2)
  off()
  lib.setPinned(n.id, false)
  expect(heard).toBe(2)
})

test('unknown ids throw notFound', () => {
  expect(() => lib.updateNote('01JC8ZQ6V4N1XG2H3K5M7P9R0T', { title: 'x' })).toThrow(expect.objectContaining({ kind: 'notFound' }))
  expect(() => lib.createNote({ notebookId: '01JC8ZQ6V4N1XG2H3K5M7P9R0T' })).toThrow(expect.objectContaining({ kind: 'notFound' }))
  expect(() => lib.createNote({ tagIds: ['01JC8ZQ6V4N1XG2H3K5M7P9R0T'] })).toThrow(expect.objectContaining({ kind: 'notFound' }))
})

test('items remember where they came from', () => {
  expect(lib.createNote({}).origin).toBe('user')
  expect(lib.createNote({ origin: 'sample' }).origin).toBe('sample')
  expect(lib.createNotebook('x', null, 'sample').origin).toBe('sample')
})
