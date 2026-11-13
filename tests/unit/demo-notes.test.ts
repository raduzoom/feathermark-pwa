// Bringing demo notes along on log-in (web design "The demo": "Add the 2 notes you wrote here to your account?"): only
// notes the visitor wrote, with the notebooks, tags and attachments they made; never a sample item.
import { expect, test } from 'vitest'
import { carryDemoNotes, demoNotesToOffer } from '../../src/core/library/demo-notes.ts'
import { Library } from '../../src/core/library/library.ts'
import { seedSampleLibrary } from '../../src/core/library/sample.ts'
import { fakeClock } from './support/clock.ts'

function visit() {
  const clock = fakeClock()
  const demo = new Library(clock)
  seedSampleLibrary(demo, clock)
  const sampleNotebook = demo.notebooks().find((n) => n.origin === 'sample')!
  const sampleTag = demo.tags().find((t) => t.origin === 'sample')!
  // edited samples stay samples
  const sample = demo.notes({ kind: 'all' }).find((n) => n.origin === 'sample')!
  demo.updateNote(sample.id, { body: 'edited sample' })
  const inSample = demo.createNote({ title: 'In a sample notebook', body: 'one', notebookId: sampleNotebook.id })
  const tagged = demo.createNote({ title: 'With a sample tag', body: 'two', tagIds: [sampleTag.id] })
  const garden = demo.createNotebook('Garden', sampleNotebook.id)
  const mine = demo.createTag('mine')
  const bytes = new Uint8Array([1, 2, 3])
  const photo = demo.addAttachment({ bytes, filename: 'p.png', mime: 'image/png', sha256: 'abc' })
  const filed = demo.createNote({ title: 'Filed', body: `![](feather://attachment/${photo.id})`, notebookId: garden.id, tagIds: [mine.id, sampleTag.id] })
  demo.createNote({}) // never typed into
  const trashed = demo.createNote({ title: 'Gone', body: 'x' })
  demo.trashNote(trashed.id)
  return { clock, demo, inSample, tagged, filed, photo }
}

test('offers the notes the visitor wrote: not samples, not empty notes, not the Trash', () => {
  const { demo, inSample, tagged, filed } = visit()
  expect(demoNotesToOffer(demo).sort()).toEqual([inSample.id, tagged.id, filed.id].sort())
  const clean = new Library(fakeClock())
  seedSampleLibrary(clean, fakeClock())
  expect(demoNotesToOffer(clean)).toEqual([])
})

test('carries them with their own notebooks, tags and attachments; a sample notebook or tag is left behind', () => {
  const { clock, demo, inSample, tagged, filed, photo } = visit()
  const account = new Library(clock)
  expect(carryDemoNotes(demo, account, demoNotesToOffer(demo))).toBe(3)

  const notes = account.notes({ kind: 'all' }).map((s) => account.note(s.id)!)
  const byTitle = new Map(notes.map((n) => [n.title, n]))
  expect([...byTitle.keys()].sort()).toEqual(['Filed', 'In a sample notebook', 'With a sample tag'])
  expect(byTitle.get('In a sample notebook')).toMatchObject({ body: 'one', notebookId: null, tagIds: [], origin: 'user', created: inSample.created, modified: inSample.modified })
  expect(byTitle.get('With a sample tag')).toMatchObject({ body: 'two', notebookId: null, tagIds: [], created: tagged.created })
  // the visitor's notebook (made inside a sample one) goes to the top level; their tag comes, the sample tag doesn't
  expect(account.notebooks()).toMatchObject([{ name: 'Garden', parentId: null, origin: 'user' }])
  expect(account.tags()).toMatchObject([{ name: 'mine', origin: 'user' }])
  const f = byTitle.get('Filed')!
  expect(f.notebookId).toBe(account.notebooks()[0]!.id)
  expect(f.tagIds).toEqual([account.tags()[0]!.id])
  expect(f.created).toBe(filed.created)
  // the attachment comes along under its own id, so the link still points at it
  expect(account.attachment(photo.id)).toMatchObject({ filename: 'p.png', bytes: new Uint8Array([1, 2, 3]), origin: 'user' })
  expect(f.body).toBe(`![](feather://attachment/${photo.id})`)

  // everything carried is new to the server, and nothing in the account is a sample
  const dirty = new Set(account.dirtyItems().map((s) => s.id))
  for (const n of notes) expect(dirty.has(n.id)).toBe(true)
  expect(dirty.has(photo.id)).toBe(true)
  expect([...account.notebooks(), ...account.tags(), ...account.attachments(), ...notes].every((i) => i.origin === 'user')).toBe(true)
})

test('a tag the account already has by that name is used, not made twice', () => {
  const { clock, demo } = visit()
  const account = new Library(clock)
  const existing = account.createTag('Mine')
  carryDemoNotes(demo, account, demoNotesToOffer(demo))
  expect(account.tags().map((t) => t.id)).toEqual([existing.id])
  const filed = account.notes({ kind: 'all' }).find((s) => s.title === 'Filed')!
  expect(account.note(filed.id)!.tagIds).toEqual([existing.id])
})
