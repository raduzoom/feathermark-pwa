import { beforeEach, expect, test, vi } from 'vitest'
import { Library } from '../../src/core/library/library.ts'
import { createAppModel, type AppModel } from '../../src/model/app-model.ts'
import { DAY, fakeClock } from './support/clock.ts'
import { fakeTimers } from './support/timers.ts'

let clock: ReturnType<typeof fakeClock>
let timers: ReturnType<typeof fakeTimers>
let lib: Library
let m: AppModel
const start = () => (m = createAppModel(lib, { clock, setTimer: timers }))
beforeEach(() => {
  clock = fakeClock()
  timers = fakeTimers(clock)
  lib = new Library(clock)
})
const rowTitles = () => m.rows.value.map((r) => r.note.title)
const later = (ms = 1) => clock.advance(ms)

test('the title of each view', () => {
  const nb = lib.createNotebook('Home', null)
  const tag = lib.createTag('to-do')
  start()
  const titles: string[] = []
  for (const v of [{ kind: 'all' }, { kind: 'recent' }, { kind: 'pinned' }, { kind: 'trash' }, { kind: 'notebook', id: nb.id }, { kind: 'tag', id: tag.id }] as const) {
    m.select(v)
    titles.push(m.title.value)
  }
  expect(titles).toEqual(['All notes', 'Recent', 'Pinned', 'Trash', 'Home', '#to-do'])
})

test('the first note opens at start, and expired trash is purged once', () => {
  const old = lib.createNote({ title: 'old' })
  lib.trashNote(old.id)
  clock.advance(31 * DAY)
  lib.createNote({ title: 'a' })
  start()
  expect(lib.note(old.id)).toBeUndefined()
  expect(m.openNote.value?.title).toBe('a')
})

test('new note lands in the notebook or tag of the view, and switches from Pinned and Trash to All', () => {
  const nb = lib.createNotebook('Home', null)
  const tag = lib.createTag('x')
  start()
  m.select({ kind: 'notebook', id: nb.id })
  m.newNote()
  expect(m.openNote.value).toMatchObject({ notebookId: nb.id })
  expect(m.titleWantsFocus.value).toBe(true)
  m.select({ kind: 'tag', id: tag.id })
  m.newNote()
  expect(m.openNote.value!.tagIds).toEqual([tag.id])
  for (const kind of ['pinned', 'trash'] as const) {
    m.select({ kind })
    m.newNote()
    expect(m.selection.value).toEqual({ kind: 'all' })
  }
})

test('edits save 500 ms after the last keystroke', () => {
  const n = lib.createNote({ title: 'a' })
  start()
  m.editBody('h')
  timers.tick(300)
  m.editBody('he')
  timers.tick(499)
  expect(lib.note(n.id)!.body).toBe('')
  expect(m.draft.value).toEqual({ title: 'a', body: 'he' })
  timers.tick(1)
  expect(lib.note(n.id)!.body).toBe('he')
  expect(m.draft.value).toBeNull()
})

test('a pending edit is saved before every navigation', () => {
  const nb = lib.createNotebook('Home', null)
  const a = lib.createNote({ title: 'a' })
  later()
  const b = lib.createNote({ title: 'b' })
  start()
  const actions: Array<[string, () => void]> = [
    ['select', () => m.select({ kind: 'recent' })],
    ['selectNote', () => m.selectNote(a.id)],
    ['newNote', () => m.newNote()],
    ['search', () => m.setSearch('a')],
    ['pin', () => m.togglePin(b.id)],
    ['move', () => m.move(b.id, nb.id)],
    ['trash', () => m.trashWithUndo(a.id)],
  ]
  for (const [name, act] of actions) {
    m.selectNote(b.id)
    m.editBody(`typed before ${name}`)
    act()
    expect(lib.note(b.id)!.body, name).toBe(`typed before ${name}`)
    m.setSearch('')
    if (lib.note(a.id)!.trashedAt) lib.restoreNote(a.id)
  }
  m.selectNote(b.id)
  m.editBody('typed before dispose')
  m.dispose()
  expect(lib.note(b.id)!.body).toBe('typed before dispose')
})

test('typing into a trashed note changes nothing', () => {
  const n = lib.createNote({ title: 'a' })
  lib.trashNote(n.id)
  start()
  m.select({ kind: 'trash' })
  m.selectNote(n.id)
  m.editBody('x')
  m.editTitle('y')
  timers.tick(1000)
  expect(lib.note(n.id)).toMatchObject({ title: 'a', body: '' })
  expect(m.draft.value).toBeNull()
})

test('the next note opens when the open one leaves the list', () => {
  for (const t of ['c', 'b', 'a']) {
    lib.createNote({ title: t })
    later()
  }
  start()
  expect(rowTitles()).toEqual(['a', 'b', 'c'])
  m.selectNote(m.rows.value[1]!.note.id)
  m.trashWithUndo(m.openNote.value!.id)
  expect(m.openNote.value?.title).toBe('c')
  m.trashWithUndo(m.openNote.value!.id)
  expect(m.openNote.value?.title).toBe('a')
  m.trashWithUndo(m.openNote.value!.id)
  expect(m.openNote.value).toBeNull()
})

test('undo restores only the last trashed note', () => {
  const a = lib.createNote({ title: 'a' })
  const b = lib.createNote({ title: 'b' })
  start()
  m.trashWithUndo(a.id)
  m.trashWithUndo(b.id)
  expect(m.undo.value).toEqual({ noteId: b.id, title: 'b' })
  m.undoLastTrash()
  expect(lib.note(b.id)!.trashedAt).toBeNull()
  expect(lib.note(a.id)!.trashedAt).not.toBeNull()
  expect(m.undo.value).toBeNull()
  m.undoLastTrash()
  expect(lib.note(a.id)!.trashedAt).not.toBeNull()
})

test('undo expires after five seconds', () => {
  const a = lib.createNote({ title: 'a' })
  const b = lib.createNote({ title: 'b' })
  start()
  m.trashWithUndo(a.id)
  timers.tick(3000)
  m.trashWithUndo(b.id)
  timers.tick(2500)
  expect(m.undo.value?.noteId).toBe(b.id)
  timers.tick(2500)
  expect(m.undo.value).toBeNull()
  m.undoLastTrash()
  expect(lib.note(b.id)!.trashedAt).not.toBeNull()
})

test("search scopes to the view's notebook or tag, and searchAll searches everything", () => {
  const nb = lib.createNotebook('Home', null)
  const tag = lib.createTag('x')
  lib.createNote({ title: 'pasta home', notebookId: nb.id })
  lib.createNote({ title: 'pasta tagged', tagIds: [tag.id] })
  lib.createNote({ title: 'pasta root' })
  start()
  m.select({ kind: 'notebook', id: nb.id })
  m.setSearch('pasta')
  expect(rowTitles()).toEqual(['pasta home'])
  expect(m.searchNotebookId.value).toBe(nb.id)
  m.setSearchNotebook(null)
  expect(rowTitles()).toHaveLength(3)
  m.select({ kind: 'tag', id: tag.id })
  m.setSearch('pasta')
  expect(rowTitles()).toEqual(['pasta tagged'])
  m.searchAll('pasta')
  expect(m.selection.value).toEqual({ kind: 'all' })
  expect(rowTitles()).toHaveLength(3)
  m.setSearch('  ')
  expect(m.searchText.value).toBe('')
  expect(rowTitles()).toHaveLength(3)
})

test('search in the Trash finds only trashed notes', () => {
  const t = lib.createNote({ title: 'pasta old' })
  lib.createNote({ title: 'pasta new' })
  lib.trashNote(t.id)
  start()
  m.select({ kind: 'trash' })
  m.setSearch('pasta')
  expect(rowTitles()).toEqual(['pasta old'])
})

test('an older search result never replaces a newer one', () => {
  lib.createNote({ title: 'apple' })
  lib.createNote({ title: 'banana' })
  start()
  m.setSearch('app')
  m.setSearch('ban')
  expect(rowTitles()).toEqual(['banana'])
})

test('search results follow library changes', () => {
  const n = lib.createNote({ title: 'apple' })
  start()
  m.setSearch('apple')
  lib.updateNote(n.id, { title: 'pear' })
  expect(rowTitles()).toEqual([])
})

test('empty states follow AppModel.emptyState', () => {
  start()
  expect(m.emptyState.value).toEqual({ kind: 'firstLaunch' })
  m.select({ kind: 'trash' })
  expect(m.emptyState.value).toEqual({ kind: 'emptyTrash' })
  const nb = lib.createNotebook('Home', null)
  lib.createNote({ title: 'a' })
  m.select({ kind: 'notebook', id: nb.id })
  expect(m.emptyState.value).toEqual({ kind: 'emptyView' })
  m.setSearch('zzz')
  expect(m.emptyState.value).toEqual({ kind: 'noSearchResults', query: 'zzz', limitedTo: 'Home' })
  m.select({ kind: 'all' })
  m.selectNote(null)
  expect(m.emptyState.value).toEqual({ kind: 'noNoteSelected' })
})

test('library errors become a message and change nothing', () => {
  start()
  expect(m.createTag('Travel')).not.toBeNull()
  expect(m.createTag('travel')).toBeNull()
  expect(m.error.value).toBe('A tag named “travel” already exists.')
  m.clearError()
  const home = m.createNotebook('Home', null)!
  const kitchen = m.createNotebook('Kitchen', home.id)!
  m.moveNotebook(home.id, kitchen.id)
  expect(m.error.value).toBe("A notebook can't go inside its own sub-notebook.")
  expect(lib.notebooks().find((n) => n.id === home.id)!.parentId).toBeNull()
  m.createNotebook('  ', null)
  expect(m.error.value).toBe("Names can't be empty.")
})

test('toggleTag adds and removes one tag', () => {
  const t = lib.createTag('x')
  const n = lib.createNote({ title: 'a' })
  start()
  m.toggleTag(n.id, t.id)
  expect(lib.note(n.id)!.tagIds).toEqual([t.id])
  m.toggleTag(n.id, t.id)
  expect(lib.note(n.id)!.tagIds).toEqual([])
})

test('a search hit edited until it no longer matches stays open through the next action', () => {
  lib.createNote({ title: 'other', body: 'needle too' })
  const n = lib.createNote({ title: 'hit', body: 'needle' })
  start()
  m.setSearch('needle')
  m.selectNote(n.id)
  m.editBody('nothing here')
  timers.tick(600)
  m.togglePin(n.id)
  expect(m.openNote.value?.id).toBe(n.id)
})

test('Markdown switches the editor between live preview and the raw text, for every note', () => {
  start()
  expect(m.editorRaw.value).toBe(false)
  m.toggleRaw()
  expect(m.editorRaw.value).toBe(true)
  m.newNote()
  expect(m.editorRaw.value).toBe(true)
  m.toggleRaw()
  expect(m.editorRaw.value).toBe(false)
})

test('a library can be swapped: the open note, its unsaved typing, search, Undo and every object URL go with the old one', () => {
  const revoked: string[] = []
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => void revoked.push(u))
  try {
    const a = lib.addAttachment({ bytes: new Uint8Array([1, 2]), filename: 'oak.png', mime: 'image/png', sha256: 'aa' })
    const secret = lib.createNote({ title: 'Secret plan', body: `the treasure is under the oak ![m](feather://attachment/${a.id})` })
    const other = lib.createNote({ title: 'Other' })
    start()
    m.selectNote(secret.id)
    const url = m.attachmentUrl(`feather://attachment/${a.id}`)!.objectUrl
    m.setSearch('treasure')
    m.trashWithUndo(other.id)
    m.editBody('typed but not saved yet')
    const versionBefore = lib.version

    const empty = new Library(clock)
    m.setLibrary(empty)
    expect(m.openNote.value).toBeNull()
    expect(m.draft.value).toBeNull()
    expect(m.rows.value).toEqual([])
    expect(m.searchText.value).toBe('')
    expect(m.undo.value).toBeNull()
    expect(revoked).toEqual([url])
    // the pending save never lands, in either library
    timers.tick(1000)
    expect(lib.version).toBe(versionBefore)
    expect(empty.version).toBe(0)
    // the old library no longer drives the model; the new one does
    lib.createNote({ title: 'old library' })
    expect(m.rows.value).toEqual([])
    const n = empty.createNote({ title: 'new library' })
    expect(m.rows.value.map((r) => r.note.id)).toEqual([n.id])
    m.setLibrary(lib)
    expect(m.openNote.value?.id).toBe(m.rows.value[0]!.note.id)
  } finally {
    revoke.mockRestore()
  }
})
