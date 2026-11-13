// Sync bookkeeping in the in-memory library: ported from FeatherCore's SyncSupportTests.swift by name
// (sync-protocol.md "Client sync algorithm", "Conflict resolution"; data-model.md "Trash"). The web has no change
// log to collect: each mutation marks its item dirty itself, so the Swift tests' collectChanges() steps are gone.
import { beforeEach, expect, test } from 'vitest'
import type { AttachmentMeta } from '../../src/core/sync/codec.ts'
import { Library } from '../../src/core/library/library.ts'
import { seedSampleLibrary } from '../../src/core/library/sample.ts'
import type { Note, Notebook, Tag } from '../../src/core/library/types.ts'
import { newUlid } from '../../src/core/ulid.ts'
import { fakeClock } from './support/clock.ts'

let clock: ReturnType<typeof fakeClock>
let lib: Library
let t0: number
beforeEach(() => {
  clock = fakeClock()
  lib = new Library(clock)
  t0 = clock()
})

const id = () => newUlid(clock)
const remoteNote = (o: Partial<Note> = {}): Note => ({
  id: id(), title: 'Remote', body: 'from B', notebookId: null, tagIds: [], pinned: false, created: t0, modified: t0, trashedAt: null, origin: 'user', ...o,
})
const apply = { blobSha: null, extra: null, metaVersion: 1, bodyLoaded: true, ifDirtySeq: null }
const dirtyById = () => new Map(lib.dirtyItems().map((s) => [s.id, s]))

test('collectMarksLocalEditsDirty', () => {
  const note = lib.createNote({ title: 'A', body: 'a' })
  const gone = lib.createNote({ title: 'B' })
  const tag = lib.createTag('x')
  for (const s of lib.dirtyItems()) lib.markPushed(s.id, 1, null, s.dirtySeq!)
  expect(lib.dirtyItems()).toEqual([])
  lib.renameTag(tag.id, 'y')
  lib.deleteNotePermanently(gone.id)
  lib.updateNote(note.id, { body: 'a2' })
  const dirty = dirtyById()
  expect(dirty.size).toBe(3)
  expect(dirty.get(note.id)).toMatchObject({ bodyDirty: true, type: 'note' })
  expect(dirty.get(gone.id)?.deleted).toBe(true)
  expect(dirty.get(tag.id)).toMatchObject({ type: 'tag', bodyDirty: false })
  // ordered by dirtySeq: the order the changes were made
  expect(lib.dirtyItems().map((s) => s.id)).toEqual([tag.id, gone.id, note.id])
})

test('every local mutation marks its item dirty; a title edit is not a body change', () => {
  const nb = lib.createNotebook('N', null)
  const nb2 = lib.createNotebook('M', null)
  const tag = lib.createTag('t')
  const n = lib.createNote({ title: 'A', body: 'a' })
  const a = lib.addAttachment({ bytes: new Uint8Array([1]), filename: 'a.bin', mime: 'application/octet-stream', sha256: 'aa' })
  expect(dirtyById().get(a.id)).toMatchObject({ type: 'attachment', bodyDirty: true })
  expect(dirtyById().get(nb.id)).toMatchObject({ type: 'notebook', bodyDirty: false })
  for (const s of lib.dirtyItems()) lib.markPushed(s.id, 1, null, s.dirtySeq!)
  const steps: Array<[string, () => void]> = [
    [n.id, () => lib.updateNote(n.id, { title: 'A2' })],
    [n.id, () => lib.setPinned(n.id, true)],
    [n.id, () => lib.moveNote(n.id, nb.id)],
    [n.id, () => lib.setTags(n.id, [tag.id])],
    [n.id, () => lib.trashNote(n.id)],
    [n.id, () => lib.restoreNote(n.id)],
    [nb.id, () => lib.renameNotebook(nb.id, 'N2')],
    [nb2.id, () => lib.moveNotebook(nb2.id, nb.id)],
    [tag.id, () => lib.renameTag(tag.id, 't2')],
  ]
  let last = 0
  for (const [itemId, step] of steps) {
    step()
    const s = lib.syncItem(itemId)!
    expect(s.dirtySeq).toBeGreaterThan(last)
    last = s.dirtySeq!
  }
  expect(lib.syncItem(n.id)!.bodyDirty).toBe(false)
  // a no-op is not a change
  const before = lib.syncItem(n.id)!.dirtySeq
  lib.setPinned(n.id, false)
  lib.setPinned(n.id, false)
  expect(lib.syncItem(n.id)!.dirtySeq).toBe(last + 1)
  expect(before).toBeLessThan(last)
})

test('deleting a notebook trashes its notes and tombstones the tree; deleting a tag tombstones only the tag', () => {
  const nb = lib.createNotebook('N', null)
  const child = lib.createNotebook('C', nb.id)
  const tag = lib.createTag('t')
  const n = lib.createNote({ notebookId: child.id, tagIds: [tag.id] })
  for (const s of lib.dirtyItems()) lib.markPushed(s.id, 1, null, s.dirtySeq!)
  lib.deleteNotebook(nb.id)
  const dirty = dirtyById()
  expect(dirty.get(nb.id)?.deleted).toBe(true)
  expect(dirty.get(child.id)?.deleted).toBe(true)
  expect(dirty.get(n.id)).toMatchObject({ deleted: false, bodyDirty: false })
  lib.markPushed(n.id, 2, null, dirty.get(n.id)!.dirtySeq!)
  lib.deleteTag(tag.id)
  expect(dirtyById().get(tag.id)?.deleted).toBe(true)
  expect(lib.syncItem(n.id)!.dirtySeq).toBe(null)
  lib.emptyTrash()
  expect(dirtyById().get(n.id)?.deleted).toBe(true)
})

test('remoteApplyIsNotALocalChange', () => {
  const note = remoteNote({ pinned: true })
  let calls = 0
  lib.subscribe(() => calls++)
  const v = lib.version
  expect(lib.applyRemoteNote(note, { ...apply, version: 4, blobSha: 'b1' })).toBe(true)
  expect(calls).toBe(1)
  expect(lib.version).toBe(v + 1)
  expect(lib.dirtyItems()).toEqual([])
  expect(lib.note(note.id)).toEqual(note)
  expect(lib.syncItem(note.id)).toMatchObject({ serverVersion: 4, dirtySeq: null, blobSha: 'b1', type: 'note', bodyLoaded: true })
  expect(lib.search('from').map((h) => h.note.id)).toEqual([note.id])
  // an update to the same note, and a remote delete
  lib.applyRemoteNote({ ...note, title: 'Remote 2', body: 'changed words' }, { ...apply, version: 5, blobSha: 'b2' })
  expect(lib.note(note.id)?.title).toBe('Remote 2')
  expect(lib.search('from')).toEqual([])
  expect(lib.search('changed').length).toBe(1)
  expect(lib.applyRemoteDelete(note.id, 'note', 6)).toBe(true)
  expect(lib.note(note.id)).toBe(undefined)
  expect(lib.syncItem(note.id)).toBe(null)
  expect(lib.search('changed')).toEqual([])
  expect(lib.dirtyItems()).toEqual([])
  expect(calls).toBe(3)
})

test('remote notebook and tag deletes cascade like the Mac: sub-notebooks go, notes go to the root, tags leave notes', () => {
  const nb = lib.createNotebook('N', null)
  const child = lib.createNotebook('C', nb.id)
  const tag = lib.createTag('t')
  const n = lib.createNote({ notebookId: child.id, tagIds: [tag.id] })
  for (const s of lib.dirtyItems()) lib.markPushed(s.id, 1, null, s.dirtySeq!)
  expect(lib.applyRemoteDelete(nb.id, 'notebook', 2)).toBe(true)
  expect(lib.notebooks()).toEqual([])
  expect(lib.note(n.id)).toMatchObject({ notebookId: null, trashedAt: null })
  expect(lib.applyRemoteDelete(tag.id, 'tag', 2)).toBe(true)
  expect(lib.note(n.id)!.tagIds).toEqual([])
  expect(lib.dirtyItems()).toEqual([])
})

test('markPushedKeepsLaterEdits', () => {
  const note = lib.createNote({ title: 'A' })
  const s1 = lib.syncItem(note.id)!.dirtySeq!
  lib.updateNote(note.id, { body: 'later' })
  const s2 = lib.syncItem(note.id)!.dirtySeq!
  lib.markPushed(note.id, 5, 'x', s1)
  expect(lib.syncItem(note.id)!.dirtySeq).toBe(s2)
  expect(lib.syncItem(note.id)!.serverVersion).toBe(5)
  lib.markPushed(note.id, 6, 'y', s2)
  const item = lib.syncItem(note.id)!
  expect(item.dirtySeq).toBe(null)
  expect(item.bodyDirty).toBe(false)
  expect(item.blobSha).toBe('y')
  expect(lib.dirtyItems()).toEqual([])
  // a pushed tombstone is done: the item is forgotten
  lib.deleteNotePermanently(note.id)
  lib.markPushed(note.id, 7, null, lib.syncItem(note.id)!.dirtySeq!)
  expect(lib.syncItem(note.id)).toBe(null)
})

test('extraMetaRoundTrips', () => {
  const note = remoteNote({ title: 'R', body: '' })
  lib.applyRemoteNote(note, { ...apply, version: 1, extra: { color: 'red' } })
  lib.updateNote(note.id, { title: 'R2' })
  expect(lib.syncItem(note.id)!.extra).toEqual({ color: 'red' })
  expect(lib.syncItem(note.id)!.dirtySeq).not.toBe(null)
})

test('resetForMerge', () => {
  const nb = lib.createNotebook('N', null)
  const tag = lib.createTag('t')
  const note = lib.createNote({ title: 'x', notebookId: nb.id })
  const a = lib.addAttachment({ bytes: new Uint8Array([1]), filename: 'a.bin', mime: 'application/octet-stream', sha256: 'aa' })
  for (const s of lib.dirtyItems()) lib.markPushed(s.id, 3, 'sha', s.dirtySeq!)
  lib.setSyncValue('pull_cursor', 'c_000000000009')
  lib.recordSyncConflict({ itemId: tag.id, type: 'tag', lostName: 'old', device: 'Mac', at: t0 })
  lib.resetSync(true)
  const dirty = lib.dirtyItems()
  expect(new Set(dirty.map((s) => s.id))).toEqual(new Set([nb.id, tag.id, note.id, a.id]))
  expect(dirty.every((s) => s.serverVersion === 0 && s.blobSha === null && !s.deleted)).toBe(true)
  expect(dirty.find((s) => s.id === note.id)!.bodyDirty).toBe(true)
  expect(dirty.find((s) => s.id === a.id)!.bodyDirty).toBe(true)
  expect(dirty.find((s) => s.id === nb.id)!.bodyDirty).toBe(false)
  expect(lib.syncValue('pull_cursor')).toBe(null)
  expect(lib.syncConflicts()).toEqual([])
  lib.resetSync(false)
  expect(lib.dirtyItems()).toEqual([])
  expect(lib.syncItem(note.id)).toBe(null)
})

test('resetSync keeps a body that has not arrived unloaded and never marks it for upload', () => {
  const n = remoteNote({ body: '' })
  lib.applyRemoteNote(n, { ...apply, version: 2, blobSha: 'b1', bodyLoaded: false })
  const loaded = lib.createNote({ title: 'here', body: 'typed' })
  lib.resetSync(true)
  expect(lib.syncItem(n.id)).toMatchObject({ dirtySeq: expect.any(Number), serverVersion: 0, bodyLoaded: false, bodyDirty: false })
  expect(lib.syncItem(loaded.id)).toMatchObject({ bodyLoaded: true, bodyDirty: true })
})

test('conflictCopyIsALocalCreate', () => {
  const nb = lib.createNotebook('N', null)
  const tag = lib.createTag('t')
  let note = lib.createNote({ title: 'Groceries', body: 'milk', notebookId: nb.id, tagIds: [tag.id] })
  lib.setPinned(note.id, true)
  note = lib.note(note.id)!
  for (const s of lib.dirtyItems()) lib.markPushed(s.id, 1, null, s.dirtySeq!)
  const copy = lib.createConflictCopy(note, 'Groceries (conflict, Mac, 9 Nov 14:32)')
  expect(copy.id).not.toBe(note.id)
  expect(copy).toMatchObject({ body: 'milk', tagIds: [tag.id], notebookId: nb.id, pinned: true, origin: 'user' })
  expect(copy.title).toBe('Groceries (conflict, Mac, 9 Nov 14:32)')
  expect(lib.note(copy.id)).toEqual(copy)
  expect(lib.dirtyItems().some((s) => s.id === copy.id && s.bodyDirty)).toBe(true)
  // references that are gone here are dropped
  const orphan = lib.createConflictCopy({ ...note, notebookId: id(), tagIds: [id(), tag.id] }, 'x')
  expect(orphan).toMatchObject({ notebookId: null, tagIds: [tag.id] })
})

test('remoteNotesTolerateMissingReferences', () => {
  const note = remoteNote({ title: 'R', body: '', notebookId: id(), tagIds: [id()] })
  lib.applyRemoteNote(note, { ...apply, version: 1 })
  const stored = lib.note(note.id)!
  expect(stored.notebookId).toBe(null)
  expect(stored.tagIds).toEqual([])
})

test('remote notebooks: a missing parent or a cycle makes it top-level', () => {
  const a: Notebook = { id: id(), name: 'A', parentId: id(), created: t0, modified: t0, origin: 'user' }
  expect(lib.applyRemoteNotebook(a, { ...apply, version: 1 })).toBe(true)
  expect(lib.notebooks()[0]).toEqual({ ...a, parentId: null })
  const b: Notebook = { id: id(), name: 'B', parentId: a.id, created: t0, modified: t0, origin: 'user' }
  lib.applyRemoteNotebook(b, { ...apply, version: 1 })
  lib.applyRemoteNotebook({ ...a, parentId: b.id }, { ...apply, version: 2 })
  expect(lib.notebooks().find((n) => n.id === a.id)!.parentId).toBe(null)
  expect(lib.descendants(a.id)).toEqual([a.id, b.id])
  expect(lib.dirtyItems()).toEqual([])
})

test('remoteTagWithATakenNameIsKept', () => {
  lib.createTag('Travel')
  const remote: Tag = { id: id(), name: 'travel', created: t0, modified: t0, origin: 'user' }
  expect(lib.applyRemoteTag(remote, { ...apply, version: 1 })).toBe(true)
  expect(lib.tags().length).toBe(2)
  expect(lib.syncItem(remote.id)).toMatchObject({ type: 'tag', serverVersion: 1, dirtySeq: null })
})

test('remoteAttachmentStoresContent', () => {
  const content = new TextEncoder().encode('hello')
  const a: AttachmentMeta = { id: id(), filename: 'h.txt', mime: 'text/plain', size: 5, sha256: 'abc', created: t0 }
  expect(lib.applyRemoteAttachment(a, content, { ...apply, version: 1, blobSha: 'e1' })).toBe(true)
  expect(lib.attachment(a.id)).toEqual({ ...a, origin: 'user', bytes: content })
  expect(lib.syncItem(a.id)).toMatchObject({ type: 'attachment', blobSha: 'e1', dirtySeq: null, bodyLoaded: true })
  expect(lib.dirtyItems()).toEqual([])
})

test('nameConflictsListNewestFirst', () => {
  const itemId = id()
  lib.recordSyncConflict({ itemId, type: 'notebook', lostName: 'Old', device: 'Mac', at: clock() })
  clock.advance(1000)
  lib.recordSyncConflict({ itemId, type: 'tag', lostName: 'Newer', device: 'Mac', at: clock() })
  lib.recordSyncConflict({ itemId, type: 'tag', lostName: 'Same time, later', device: 'Mac', at: clock() })
  expect(lib.syncConflicts().map((c) => c.lostName)).toEqual(['Same time, later', 'Newer', 'Old'])
  expect(lib.syncConflicts()[2]).toMatchObject({ itemId, type: 'notebook', device: 'Mac', at: t0 })
})

test('rebaseKeepsItDirty', () => {
  const note = lib.createNote({ title: 'A' })
  lib.markPushed(note.id, 1, 'x', lib.syncItem(note.id)!.dirtySeq!)
  lib.updateNote(note.id, { title: 'B' })
  lib.rebase(note.id, 7)
  const item = lib.syncItem(note.id)!
  expect(item.serverVersion).toBe(7)
  expect(item.dirtySeq).not.toBe(null)
  expect(item.bodyDirty).toBe(true)
  expect(item.deleted).toBe(false)
})

// review C3: an edit made after the engine looked is never overwritten by a remote write
test('applyRemoteRefusesUnseenLocalEdits', () => {
  const remote = remoteNote({ title: 'R', body: 'server' })
  expect(lib.applyRemoteNote(remote, { ...apply, version: 1 })).toBe(true)
  lib.updateNote(remote.id, { body: 'typed' })
  expect(lib.applyRemoteNote(remote, { ...apply, version: 2 })).toBe(false) // dirty, not expected
  expect(lib.note(remote.id)!.body).toBe('typed')
  const seq = lib.syncItem(remote.id)!.dirtySeq!
  expect(lib.applyRemoteNote(remote, { ...apply, version: 2, ifDirtySeq: seq })).toBe(true)
  expect(lib.note(remote.id)!.body).toBe('server')
  expect(lib.applyRemoteDelete(remote.id, 'note', 3, seq)).toBe(false) // clean now: seq no longer matches
  expect(lib.applyRemoteDelete(remote.id, 'note', 3)).toBe(true)
})

test('markBodyDirty', () => {
  const note = lib.createNote({ title: 'A' })
  lib.markPushed(note.id, 1, 'x', lib.syncItem(note.id)!.dirtySeq!)
  lib.markBodyDirty(note.id)
  const item = lib.syncItem(note.id)!
  expect(item.bodyDirty).toBe(true)
  expect(item.dirtySeq).not.toBe(null)
})

test('referencesResolve', () => {
  const nb = lib.createNotebook('N', null)
  const tag = lib.createTag('t')
  expect(lib.referencesResolve(nb.id, [tag.id])).toBe(true)
  expect(lib.referencesResolve(null, [])).toBe(true)
  expect(lib.referencesResolve(id(), [])).toBe(false)
  expect(lib.referencesResolve(null, [id()])).toBe(false)
})

test('sample items are never dirty', () => {
  seedSampleLibrary(lib, clock)
  expect(lib.dirtyItems()).toEqual([])
  const [first] = lib.notes({ kind: 'all' })
  lib.updateNote(first!.id, { body: 'edited' })
  lib.setPinned(first!.id, false)
  const nb = lib.notebooks()[0]!
  lib.renameNotebook(nb.id, 'Renamed')
  lib.renameTag(lib.tags()[0]!.id, 'renamed')
  lib.deleteNotebook(nb.id)
  lib.emptyTrash()
  expect(lib.dirtyItems()).toEqual([])
  expect(lib.syncItem(first!.id)).toBe(null)
  lib.resetSync(true)
  expect(lib.dirtyItems()).toEqual([])
  // what people add to the demo is theirs
  const mine = lib.createNote({ title: 'mine' })
  expect(lib.dirtyItems().map((s) => s.id)).toEqual([mine.id])
})

test("a body download doesn't overwrite a newer local edit", () => {
  const note = remoteNote({ title: 'R', body: '' })
  lib.applyRemoteNote(note, { ...apply, version: 1, blobSha: 'b1', bodyLoaded: false })
  expect(lib.syncItem(note.id)!.bodyLoaded).toBe(false)
  let calls = 0
  lib.subscribe(() => calls++)
  expect(lib.setRemoteBody(note.id, 'the body', 'b1')).toBe(true)
  expect(calls).toBe(1)
  expect(lib.note(note.id)!.body).toBe('the body')
  expect(lib.search('body').length).toBe(1)
  expect(lib.syncItem(note.id)).toMatchObject({ bodyLoaded: true, blobSha: 'b1', dirtySeq: null })
  expect(lib.dirtyItems()).toEqual([])

  const other = remoteNote({ title: 'S', body: '' })
  lib.applyRemoteNote(other, { ...apply, version: 1, blobSha: 'c1', bodyLoaded: false })
  lib.updateNote(other.id, { body: 'typed here' })
  expect(lib.setRemoteBody(other.id, 'downloaded', 'c1')).toBe(false)
  expect(lib.note(other.id)!.body).toBe('typed here')
  expect(lib.setRemoteBody(id(), 'nobody', 'd1')).toBe(false)
  // a local-only note counts as loaded
  expect(lib.syncItem(lib.createNote({ title: 'local' }).id)!.bodyLoaded).toBe(true)
})

test('a body download for an older blob is refused', () => {
  const note = remoteNote({ title: 'R', body: '' })
  lib.applyRemoteNote(note, { ...apply, version: 1, blobSha: 'b1', bodyLoaded: false })
  // a newer version lands while b1 is still downloading
  lib.applyRemoteNote({ ...note, title: 'R2' }, { ...apply, version: 2, blobSha: 'b2', bodyLoaded: false })
  expect(lib.setRemoteBody(note.id, 'v1 text', 'b1')).toBe(false)
  expect(lib.note(note.id)!.body).toBe('')
  expect(lib.syncItem(note.id)).toMatchObject({ blobSha: 'b2', bodyLoaded: false })
  expect(lib.setRemoteBody(note.id, 'v2 text', 'b2')).toBe(true)
  expect(lib.note(note.id)!.body).toBe('v2 text')
  // once loaded, a repeat download doesn't land again
  expect(lib.setRemoteBody(note.id, 'again', 'b2')).toBe(false)
  expect(lib.note(note.id)!.body).toBe('v2 text')
})

test('a pin during the body download: the body still loads', () => {
  const nb = lib.createNotebook('N', null)
  const note = remoteNote({ title: 'R', body: '' })
  lib.applyRemoteNote(note, { ...apply, version: 1, blobSha: 'b1', bodyLoaded: false })
  lib.setPinned(note.id, true)
  lib.moveNote(note.id, nb.id)
  const seq = lib.syncItem(note.id)!.dirtySeq
  expect(lib.setRemoteBody(note.id, 'the body', 'b1')).toBe(true)
  expect(lib.note(note.id)).toMatchObject({ body: 'the body', pinned: true, notebookId: nb.id })
  // still dirty with the same seq and no body to upload: the metadata push goes ahead as it was
  expect(lib.syncItem(note.id)).toMatchObject({ dirtySeq: seq, bodyDirty: false, bodyLoaded: true, blobSha: 'b1' })
})
