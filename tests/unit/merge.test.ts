// Joining a tab's own unsynced notes into the kept copy it takes back (src/core/vault/merge.ts).
import { describe, expect, test } from 'vitest'
import { Library } from '../../src/core/library/library.ts'
import type { Note } from '../../src/core/library/types.ts'
import { newUlid } from '../../src/core/ulid.ts'
import { mergeUnsynced } from '../../src/core/vault/merge.ts'
import { fakeClock } from './support/clock.ts'

/** Two libraries that both have a note from the server whose body never arrived. */
function pair() {
  const clock = fakeClock()
  const t = clock()
  const note: Note = { id: newUlid(clock), title: 'From the Mac', body: '', notebookId: null, tagIds: [], pinned: false, created: t, modified: t, trashedAt: null, origin: 'user' }
  const make = () => {
    const lib = new Library(clock)
    lib.applyRemoteNote(note, { version: 4, extra: null, metaVersion: 1, blobSha: 'ab'.repeat(32), bodyLoaded: false })
    return lib
  }
  return { clock, note, from: make(), into: make() }
}

describe('mergeUnsynced', () => {
  test('a title changed on a note whose body never loaded is carried, and no body is made up', () => {
    const { clock, note, from, into } = pair()
    from.updateNote(note.id, { title: 'Retitled offline' })
    expect(mergeUnsynced(into, from, 'Chrome on macOS', clock)).toBe(1)
    expect(into.note(note.id)!.title).toBe('Retitled offline')
    expect(into.syncItem(note.id)).toMatchObject({ bodyLoaded: false, bodyDirty: false })
    expect(into.dirtyItems().map((s) => s.id)).toEqual([note.id])
  })

  test('when the copy changed that note too, the title typed here goes to the sync-conflicts list', () => {
    const { clock, note, from, into } = pair()
    from.updateNote(note.id, { title: 'Retitled here' })
    into.updateNote(note.id, { title: 'Retitled in the other tab' })
    expect(mergeUnsynced(into, from, 'Chrome on macOS', clock)).toBe(1)
    expect(into.note(note.id)!.title).toBe('Retitled in the other tab')
    expect(into.syncConflicts().map((c) => c.lostName)).toEqual(['Retitled here'])
  })
})
