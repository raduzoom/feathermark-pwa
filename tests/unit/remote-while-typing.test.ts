// Another device's edit to the open note arrives while someone is typing in it (Task 12 fix round 1): no keystroke is
// refused, the editor never turns read-only, and both texts survive (the one typed here as a conflict copy,
// sync-protocol.md "Conflict resolution").
import { effect } from '@preact/signals'
import { expect, test } from 'vitest'
import { Library } from '../../src/core/library/library.ts'
import { ApiClient } from '../../src/core/sync/api.ts'
import { SyncEngine } from '../../src/core/sync/engine.ts'
import { createAppModel } from '../../src/model/app-model.ts'
import { fakeClock } from './support/clock.ts'
import { fakeCrypto, FakeCloud } from './support/fake-cloud.ts'
import { fakeTimers } from './support/timers.ts'

function devices() {
  const cloud = new FakeCloud()
  const clock = fakeClock()
  const crypto = fakeCrypto(new Uint8Array(32).fill(7))
  const device = (name: string) => {
    const library = new Library(clock)
    const engine = new SyncEngine({ library, api: new ApiClient({ base: cloud.base, token: cloud.token(name), fetch: cloud.fetch }), crypto, session: 1, libraryId: cloud.libraryId, deviceName: name, clock })
    return { library, engine }
  }
  return { cloud, clock, here: device('Chrome on macOS'), mac: device('Mac') }
}

const allTexts = (lib: Library) =>
  [...lib.notes({ kind: 'all' })].map((s) => lib.note(s.id)!).map((n) => ({ title: n.title, body: n.body })).sort((a, b) => (a.title < b.title ? -1 : 1))

test("a remote edit to the open note while a draft is pending keeps both texts and refuses no keystroke", async () => {
  const { clock, here, mac } = devices()
  const id = here.library.createNote({ title: 'Groceries', body: 'milk' }).id
  await here.engine.syncOnce()
  await mac.engine.syncOnce()
  const timers = fakeTimers(clock)
  const m = createAppModel(here.library, { clock, setTimer: timers })
  m.selectNote(id)
  await Promise.resolve()

  // typing here, not saved yet (inside the 500 ms delay)
  m.editBody('milk, eggs')
  // the Mac changes the same note and syncs first
  mac.library.updateNote(id, { body: 'milk, bread' })
  await mac.engine.syncOnce()
  // this tab pulls it while the draft is pending
  let loadingSeen = false
  const stop = effect(() => void (loadingSeen ||= m.openNoteLoading.value))
  await here.engine.syncOnce()
  stop()
  expect(loadingSeen).toBe(false)
  expect(m.openNoteLoading.value).toBe(false)

  // the next keystroke is taken
  const before = m.openNote.value!.body
  m.editBody(before + '!')
  expect(m.draft.value?.body).toBe(before + '!')
  timers.tick(1000)

  // both texts are there: the Mac's on the note, this tab's as a conflict copy
  const texts = allTexts(here.library).map((t) => t.body)
  expect(texts.some((b) => b.startsWith('milk, bread'))).toBe(true)
  expect(texts.some((b) => b.startsWith('milk, eggs'))).toBe(true)
  expect(here.library.notes({ kind: 'all' }).some((s) => /\(conflict, Chrome on macOS, /.test(s.title))).toBe(true)
})

test('a remote edit to the open note with nothing pending shows the new text at once, never as loading', async () => {
  const { clock, here, mac } = devices()
  const id = here.library.createNote({ title: 'Groceries', body: 'milk' }).id
  await here.engine.syncOnce()
  await mac.engine.syncOnce()
  const m = createAppModel(here.library, { clock, setTimer: fakeTimers(clock) })
  m.selectNote(id)
  mac.library.updateNote(id, { body: 'milk, bread' })
  await mac.engine.syncOnce()
  await here.engine.syncOnce()
  expect(m.openNoteLoading.value).toBe(false)
  expect(m.openNote.value?.body).toBe('milk, bread')
  // a note that isn't open still loads in the background
  const other = mac.library.createNote({ title: 'Other', body: 'later' }).id
  await mac.engine.syncOnce()
  await here.engine.syncOnce()
  expect(here.library.syncItem(other)?.bodyLoaded).toBe(false)
})
