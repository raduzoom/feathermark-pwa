// The sync engine, two devices on one in-memory FakeCloud, through the real ApiClient. Ported from
// TwoDeviceTests.swift and ReviewFixTests.swift by name, plus the Phase 20 plan's cases (Task 6).
import { describe, expect, test } from 'vitest'
import { Library } from '../../src/core/library/library.ts'
import type { Note } from '../../src/core/library/types.ts'
import { ApiClient } from '../../src/core/sync/api.ts'
import { BodyLoader } from '../../src/core/sync/bodies.ts'
import { SyncEngine } from '../../src/core/sync/engine.ts'
import { fakeClock } from './support/clock.ts'
import { fakeCrypto, FakeCloud, sha256 } from './support/fake-cloud.ts'
import { fakeTimers } from './support/timers.ts'

const MASTER = new Uint8Array(32).fill(7)
const text = new TextEncoder()

type Hook = (event: 'afterPush' | 'beforeApply', id?: string) => void | Promise<void>

function device(cloud: FakeCloud, name: string) {
  const clock = fakeClock()
  const library = new Library(clock)
  const token = cloud.token(name)
  const api = new ApiClient({ base: cloud.base, token, fetch: cloud.fetch })
  const crypto = fakeCrypto(MASTER)
  const timers = fakeTimers(clock)
  const dev = {
    name,
    clock,
    library,
    token,
    crypto,
    timers,
    hook: null as Hook | null,
    progress: [] as Array<[number, number]>,
    engine: null as unknown as SyncEngine,
    loader: null as unknown as BodyLoader,
    /** One pass, then every note body that hasn't arrived (as the app's BodyLoader would, in the background). */
    async sync() {
      const { report } = await dev.engine.syncOnce()
      await dev.loadAll()
      return report
    },
    async loadAll() {
      for (const n of allNotes(library)) if (library.syncItem(n.id)?.bodyLoaded === false) await dev.loader.openNote(n.id)
    },
    notes: () => allNotes(library),
  }
  dev.engine = new SyncEngine({
    library, api, crypto, session: 1, libraryId: cloud.libraryId, deviceName: name, clock, timers, random: () => 0.5,
    testHook: (e, id) => dev.hook?.(e, id),
  })
  dev.loader = new BodyLoader({ library, api, crypto, session: 1, timers, random: () => 0.5, onProgress: (d, t) => void dev.progress.push([d, t]) })
  return dev
}
type Device = ReturnType<typeof device>

function allNotes(library: Library): Note[] {
  return [...library.notes({ kind: 'all' }), ...library.notes({ kind: 'trash' })]
    .map((s) => library.note(s.id)!)
    .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))
}

/** Lets the engine's promises run until `cond` holds. */
async function until(cond: () => boolean, what = 'condition') {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return
    await new Promise((r) => setImmediate(r))
  }
  throw new Error(`timed out waiting for ${what}`)
}
const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r))
}

/** Two devices on one account, with a synced note "Groceries". */
async function pair() {
  const cloud = new FakeCloud()
  const a = device(cloud, 'Mac A')
  const b = device(cloud, 'Mac B')
  const id = a.library.createNote({ title: 'Groceries', body: 'milk' }).id
  await a.sync()
  await b.sync()
  expect(b.library.note(id)?.body).toBe('milk')
  return { cloud, a, b, id }
}

const bodies = (d: Device) => new Set(d.notes().map((n) => n.body))
const callsBy = (cloud: FakeCloud, d: Device) => cloud.calls.filter((c) => c.token === d.token)

describe('TwoDeviceTests', () => {
  for (const aFirst of [true, false]) {
    test(`noteConflictBothOrders (aFirst: ${aFirst})`, async () => {
      const { a, b, id } = await pair()
      a.library.updateNote(id, { body: 'milk, eggs' })
      b.library.updateNote(id, { body: 'milk, bread' })
      const [first, second] = aFirst ? [a, b] : [b, a]
      await first.sync()
      const report = await second.sync()
      expect(report.conflictCopies.length).toBe(1)
      await first.sync()
      await second.sync()
      const winner = aFirst ? 'milk, eggs' : 'milk, bread'
      const loser = aFirst ? 'milk, bread' : 'milk, eggs'
      for (const d of [a, b]) {
        const notes = d.notes()
        expect(notes.length, d.name).toBe(2)
        expect(notes.find((n) => n.id === id)?.body).toBe(winner)
        const copy = notes.find((n) => n.id !== id)!
        expect(copy.body).toBe(loser)
        expect(copy.title.startsWith(`Groceries (conflict, ${second.name}, `)).toBe(true)
      }
    })
  }

  test('metadataOnlyConflictMerges', async () => {
    const { a, b, id } = await pair()
    const tag = a.library.createTag('shopping')
    a.library.setTags(id, [tag.id])
    b.library.setPinned(id, true)
    await a.sync()
    const report = await b.sync()
    await a.sync()
    expect(report.conflictCopies).toEqual([])
    for (const d of [a, b]) {
      const notes = d.notes()
      expect(notes.length).toBe(1)
      expect(notes[0]!.tagIds, d.name).toEqual([tag.id])
    }
  })

  for (const deleteFirst of [true, false]) {
    test(`editVersusDelete (deleteFirst: ${deleteFirst})`, async () => {
      const { a, b, id } = await pair()
      a.library.updateNote(id, { body: 'milk, edited' })
      b.library.deleteNotePermanently(id)
      if (deleteFirst) {
        await b.sync()
        await a.sync() // the edit revives the note
        await b.sync()
      } else {
        await a.sync()
        await b.sync() // the delete loses to the edit
        await a.sync()
      }
      for (const d of [a, b]) expect(d.library.note(id)?.body, d.name).toBe('milk, edited')
    })
  }

  test('notebookRenameConflict', async () => {
    const { a, b } = await pair()
    const nb = a.library.createNotebook('Trips', null)
    await a.sync()
    await b.sync()
    a.library.renameNotebook(nb.id, 'Travel')
    b.library.renameNotebook(nb.id, 'Journeys')
    await a.sync()
    const report = await b.sync()
    expect(report.nameConflicts).toBe(1)
    expect(b.library.notebooks().find((n) => n.id === nb.id)?.name).toBe('Travel')
    const conflicts = b.library.syncConflicts()
    expect(conflicts.length).toBe(1)
    expect(conflicts[0]).toMatchObject({ lostName: 'Journeys', device: 'Mac B', itemId: nb.id, type: 'notebook' })
    expect(a.library.syncConflicts()).toEqual([])
  })

  test('tagConflicts', async () => {
    const { a, b, id } = await pair()
    const tag = a.library.createTag('home')
    await a.sync()
    await b.sync()
    a.library.renameTag(tag.id, 'house')
    b.library.renameTag(tag.id, 'flat')
    await a.sync()
    await b.sync()
    expect(b.library.tags().find((t) => t.id === tag.id)?.name).toBe('house')
    // A deletes the tag while B tags the note with it
    a.library.deleteTag(tag.id)
    b.library.setTags(id, [tag.id])
    await a.sync()
    await b.sync()
    await a.sync()
    expect(b.library.tags().some((t) => t.id === tag.id)).toBe(false)
    expect(a.library.note(id)).toBeDefined()
    expect(b.library.note(id)?.tagIds.includes(tag.id)).toBe(false)
  })

  test('attachmentsTravel', async () => {
    const { a, b } = await pair()
    const image = Uint8Array.from({ length: 5000 }, (_, i) => i % 251)
    const att = a.library.addAttachment({ bytes: image, filename: 'plan.png', mime: 'image/png', sha256: sha256(image) })
    const note = a.library.createNote({ title: 'Plan', body: `![Plan](feather://attachment/${att.id})` })
    await a.sync()
    await b.sync()
    // attachments download only when shown (web design "Loading a library")
    expect(b.library.attachment(att.id)).toMatchObject({ filename: 'plan.png', mime: 'image/png', size: 5000 })
    expect(b.library.syncItem(att.id)?.bodyLoaded).toBe(false)
    const bytes = await b.loader.loadAttachment(att.id)
    expect(bytes).toEqual(image)
    expect(b.library.attachment(att.id)?.bytes).toEqual(image)
    expect(b.library.syncItem(att.id)?.bodyLoaded).toBe(true)
    expect(b.library.note(note.id)?.body.includes(att.id)).toBe(true)
  })

  test('signInMergesLocalNotes', async () => {
    const { cloud, a } = await pair()
    const d = device(cloud, 'Mac D')
    for (let i = 1; i <= 3; i++) d.library.createNote({ title: `Local ${i}`, body: `${i}` })
    d.library.resetSync(true)
    await d.sync()
    await a.sync()
    expect(a.notes().length).toBe(4)
    expect(d.notes().length).toBe(4)
  })

  test('readOnlyKeepsPulling', async () => {
    const { cloud, a, b, id } = await pair()
    cloud.plan = 'read_only'
    a.library.updateNote(id, { body: 'offline edit' })
    const report = await a.sync()
    expect(report.readOnly).toBe(true)
    expect(a.library.dirtyItems().some((s) => s.id === id)).toBe(true)
    // pulls continue: re-activate briefly to let B push, lapse again, and A still receives it
    cloud.plan = 'active'
    const n = b.library.createNote({ title: 'From B' })
    await b.sync()
    cloud.plan = 'read_only'
    await a.sync()
    expect(a.library.note(n.id)?.title).toBe('From B')
    expect(a.library.note(id)?.body).toBe('offline edit')
  })
})

describe('ReviewFixTests', () => {
  test('bodyEditAgainstMetadataChangeKeepsText', async () => {
    const { a, b, id } = await pair()
    a.library.setPinned(id, true)
    b.library.updateNote(id, { body: 'milk, bread' })
    await a.sync()
    await b.sync()
    await a.sync()
    for (const d of [a, b]) expect(bodies(d), d.name).toEqual(new Set(['milk', 'milk, bread']))
    expect(b.library.dirtyItems()).toEqual([])
  })

  test('revivedNoteHasItsBody', async () => {
    const { a, b, id } = await pair()
    a.library.setPinned(id, true)
    b.library.deleteNotePermanently(id)
    await a.sync()
    await b.engine.syncOnce() // no background loading: the conflict path brought the body
    expect(b.library.note(id)?.body).toBe('milk')
    expect(b.library.syncItem(id)?.bodyLoaded).toBe(true)
  })

  test('editBetweenPushAndPullIsPushedLater', async () => {
    const { a, b, id } = await pair()
    a.library.updateNote(id, { body: 'v1' })
    a.hook = (e) => {
      if (e === 'afterPush') a.library.updateNote(id, { body: 'v2' })
    }
    await a.sync()
    a.hook = null
    await a.sync()
    await b.sync()
    expect(b.library.note(id)?.body).toBe('v2')
    expect(a.notes().length).toBe(1)
    expect(b.notes().length).toBe(1)
  })

  test('typingDuringPullIsKept', async () => {
    const { a, b, id } = await pair()
    b.library.updateNote(id, { body: 'from B' })
    await b.sync()
    a.hook = (e, item) => {
      if (e === 'beforeApply' && item === id) a.library.updateNote(id, { body: 'A typed during pull' })
    }
    await a.sync()
    a.hook = null
    await a.sync()
    await b.sync()
    for (const d of [a, b]) expect(bodies(d), d.name).toEqual(new Set(['from B', 'A typed during pull']))
  })

  test('referencesSurviveSeqOrder', async () => {
    const cloud = new FakeCloud()
    const a = device(cloud, 'Mac A')
    const b = device(cloud, 'Mac B')
    const nb = a.library.createNotebook('Work', null)
    const tag = a.library.createTag('todo')
    const note = a.library.createNote({ title: 'Plan', body: 'x', notebookId: nb.id, tagIds: [tag.id] })
    await a.sync()
    a.library.renameNotebook(nb.id, 'Office')
    a.library.renameTag(tag.id, 'next')
    await a.sync()
    await b.sync()
    const onB = b.library.note(note.id)!
    expect(onB.notebookId).toBe(nb.id)
    expect(onB.tagIds).toEqual([tag.id])
    expect(b.library.dirtyItems()).toEqual([])
  })

  test('blobMissingIsReuploaded', async () => {
    const { cloud, a, b, id } = await pair()
    cloud.blobs.clear()
    a.library.setPinned(id, true)
    const first = await a.sync()
    expect(first.rejected[id]).toBe('blob_missing')
    const second = await a.sync()
    expect(second.rejected).toEqual({})
    expect(a.library.dirtyItems()).toEqual([])
    await b.sync()
    expect(b.library.note(id)).toMatchObject({ pinned: true, body: 'milk' })
  })

  test('concurrentPassesAreSerial', async () => {
    const { a, b } = await pair()
    for (let i = 1; i <= 5; i++) a.library.createNote({ title: `N${i}`, body: `${i}` })
    const [x, y] = await Promise.all([a.engine.syncOnce(), a.engine.syncOnce()])
    expect(x.report.pushed + y.report.pushed).toBe(5)
    expect([...x.report.conflictCopies, ...y.report.conflictCopies]).toEqual([])
    await b.sync()
    expect(b.notes().length).toBe(6)
  })

  test('scheduleRestartsAfterSignOut', async () => {
    const { cloud, a } = await pair()
    let signedOut = false
    cloud.tokens.delete(a.token)
    a.engine.start({ beforeSync: () => {}, onPulled: () => {}, onSignedOut: () => void (signedOut = true) })
    await until(() => signedOut, 'sign-out')
    cloud.tokens.add(a.token) // signed in again; same engine
    a.engine.start({ beforeSync: () => {}, onPulled: () => {}, onSignedOut: () => {} })
    await until(() => a.engine.status.value.kind === 'idle' && (a.engine.status.value as { lastSynced: number | null }).lastSynced !== null, 'idle')
    a.engine.stop()
    expect(a.timers.count).toBe(0)
  })
})

describe('the sync engine', () => {
  test("both devices see each other's notes, notebooks, tags and attachments", async () => {
    const cloud = new FakeCloud()
    const a = device(cloud, 'Mac A')
    const b = device(cloud, 'Mac B')
    const nbA = a.library.createNotebook('Work', null)
    const tagA = a.library.createTag('urgent')
    const bytesA = text.encode('receipt')
    const attA = a.library.addAttachment({ bytes: bytesA, filename: 'receipt.pdf', mime: 'application/pdf', sha256: sha256(bytesA) })
    const noteA = a.library.createNote({ title: 'From A', body: `see [receipt](feather://attachment/${attA.id})`, notebookId: nbA.id, tagIds: [tagA.id] })
    a.library.setPinned(noteA.id, true)
    const nbB = b.library.createNotebook('Home', null)
    const tagB = b.library.createTag('later')
    const bytesB = Uint8Array.of(1, 2, 3)
    const attB = b.library.addAttachment({ bytes: bytesB, filename: 'dot.png', mime: 'image/png', sha256: sha256(bytesB) })
    const noteB = b.library.createNote({ title: 'From B', body: 'b text', notebookId: nbB.id, tagIds: [tagB.id] })
    await a.sync()
    await b.sync()
    await a.sync()
    for (const d of [a, b]) {
      expect(d.notes().map((n) => n.title), d.name).toEqual(['From A', 'From B'])
      expect(d.library.note(noteA.id)).toMatchObject({ body: `see [receipt](feather://attachment/${attA.id})`, notebookId: nbA.id, tagIds: [tagA.id], pinned: true })
      expect(d.library.note(noteB.id)).toMatchObject({ body: 'b text', notebookId: nbB.id, tagIds: [tagB.id], pinned: false })
      expect(d.library.notebooks().map((n) => n.name).sort()).toEqual(['Home', 'Work'])
      expect(d.library.tags().map((t) => t.name).sort()).toEqual(['later', 'urgent'])
      expect(d.library.dirtyItems()).toEqual([])
    }
    expect(await b.loader.loadAttachment(attA.id)).toEqual(bytesA)
    expect(await a.loader.loadAttachment(attB.id)).toEqual(bytesB)
    expect(b.library.attachment(attA.id)).toMatchObject({ filename: 'receipt.pdf', size: bytesA.length })
  })

  for (const aFirst of [true, false]) {
    test(`an edit on both sides makes exactly one conflict copy, in either order (${aFirst ? 'A' : 'B'} first)`, async () => {
      const { a, b, id } = await pair()
      a.library.updateNote(id, { body: 'from A' })
      b.library.updateNote(id, { body: 'from B' })
      const [first, second] = aFirst ? [a, b] : [b, a]
      const r1 = await first.sync()
      const r2 = await second.sync()
      const r3 = await first.sync()
      const r4 = await second.sync()
      expect(r1.conflictCopies.length + r2.conflictCopies.length + r3.conflictCopies.length + r4.conflictCopies.length).toBe(1)
      expect(r2.conflictCopies.length).toBe(1)
      for (const d of [a, b]) {
        expect(d.notes().length, d.name).toBe(2)
        expect(bodies(d)).toEqual(new Set(['from A', 'from B']))
        expect(d.library.note(id)?.body).toBe(aFirst ? 'from A' : 'from B')
      }
    })
  }

  test('only metadata changed: tags merge, no copy', async () => {
    const { a, b, id } = await pair()
    const t1 = a.library.createTag('one')
    await a.sync()
    await b.sync()
    const t2 = b.library.createTag('two')
    a.library.setTags(id, [t1.id])
    a.library.setPinned(id, true)
    b.library.setTags(id, [t2.id])
    await a.sync()
    const report = await b.sync()
    await a.sync()
    expect(report.conflictCopies).toEqual([])
    for (const d of [a, b]) {
      expect(d.notes().length).toBe(1)
      expect(d.library.note(id)).toMatchObject({ tagIds: [t1.id, t2.id].sort(), pinned: true, body: 'milk' })
    }
  })

  test('an edit beats a delete, and a delete loses to an edit', async () => {
    // the delete reaches the server first: the edit revives the note (rule 3)
    {
      const { a, b, id } = await pair()
      a.library.updateNote(id, { body: 'kept' })
      b.library.deleteNotePermanently(id)
      await b.sync()
      await a.sync()
      await b.sync()
      for (const d of [a, b]) expect(d.library.note(id)?.body, d.name).toBe('kept')
    }
    // the edit reaches the server first: the local delete is dropped (rule 4)
    {
      const { a, b, id } = await pair()
      a.library.updateNote(id, { body: 'kept' })
      b.library.deleteNotePermanently(id)
      await a.sync()
      const report = await b.sync()
      expect(report.conflictCopies).toEqual([])
      await a.sync()
      for (const d of [a, b]) {
        expect(d.library.note(id)?.body, d.name).toBe('kept')
        expect(d.notes().length).toBe(1)
      }
    }
  })

  test('a rename on both sides: server wins, one entry in sync conflicts', async () => {
    const { a, b } = await pair()
    const tag = a.library.createTag('home')
    await a.sync()
    await b.sync()
    a.library.renameTag(tag.id, 'house')
    b.library.renameTag(tag.id, 'flat')
    await a.sync()
    const report = await b.sync()
    await b.sync()
    await a.sync()
    expect(report.nameConflicts).toBe(1)
    for (const d of [a, b]) expect(d.library.tags().find((t) => t.id === tag.id)?.name).toBe('house')
    expect(b.library.syncConflicts()).toEqual([expect.objectContaining({ itemId: tag.id, type: 'tag', lostName: 'flat', device: 'Mac B' })])
    expect(a.library.syncConflicts()).toEqual([])
  })

  test('typing during a pull keeps the typed text', async () => {
    const { a, b, id } = await pair()
    b.library.updateNote(id, { body: 'from B' })
    await b.sync()
    let typed = 0
    a.hook = (e, item) => {
      // between the pull's decode and its apply
      if (e === 'beforeApply' && item === id && typed++ === 0) a.library.updateNote(id, { body: 'typed on A' })
    }
    const report = await a.engine.syncOnce()
    a.hook = null
    expect(report.report.conflictCopies.length).toBe(1)
    expect(a.library.note(id)?.body).toBe('from B')
    expect(a.library.note(report.report.conflictCopies[0]!)?.body).toBe('typed on A')
    await b.sync()
    for (const d of [a, b]) expect(bodies(d), d.name).toEqual(new Set(['from B', 'typed on A']))
  })

  test('blob_missing uploads the body again next pass', async () => {
    const { cloud, a, id } = await pair()
    cloud.blobs.clear()
    a.library.setPinned(id, true)
    const puts = () => callsBy(cloud, a).filter((c) => c.method === 'PUT').length
    const before = puts()
    const { report } = await a.engine.syncOnce()
    expect(report.rejected[id]).toBe('blob_missing')
    // the pass's repeat uploaded the body and pushed again
    expect(puts()).toBe(before + 1)
    expect(a.library.dirtyItems()).toEqual([])
    expect(cloud.items.get(id)?.blobSha).not.toBeNull()
    expect(cloud.blobs.has(cloud.items.get(id)!.blobSha!)).toBe(true)
  })

  test('quota_exceeded keeps the item dirty and reports full', async () => {
    const cloud = new FakeCloud()
    const a = device(cloud, 'Mac A')
    const small = a.library.createNote({ title: 'small', body: 'x' })
    await a.sync()
    cloud.quotaBytes = cloud.usedBytes() + 500
    const big = a.library.createNote({ title: 'big', body: 'y'.repeat(5000) })
    const ok = a.library.createNote({ title: 'ok', body: 'z' })
    const { report } = await a.engine.syncOnce()
    expect(report.quotaFull).toBe(true)
    expect(report.rejected[big.id]).toBe('quota_exceeded')
    expect(a.library.dirtyItems().map((s) => s.id)).toEqual([big.id])
    expect(cloud.items.has(ok.id)).toBe(true)
    expect(cloud.items.has(small.id)).toBe(true)
    // the schedule shows it
    a.engine.start({ beforeSync: () => {}, onPulled: () => {}, onSignedOut: () => {} })
    await until(() => a.engine.status.value.kind === 'quotaFull', 'quotaFull')
    a.engine.stop()
  })

  test('read_only stops pushing and keeps pulling', async () => {
    const { cloud, a, b, id } = await pair()
    cloud.plan = 'read_only'
    a.library.updateNote(id, { body: 'kept here' })
    const n = b.library.createNote({ title: 'blocked' })
    const r = await b.sync()
    expect(r.readOnly).toBe(true)
    expect(cloud.items.has(n.id)).toBe(false)
    // the other device still receives what is on the server
    const tag = a.library.createTag('t')
    cloud.plan = 'active'
    await a.engine.syncOnce() // pushes the tag and the edit
    cloud.plan = 'read_only'
    // a write attempt: the blob upload comes first and gets the 403
    const pushes = () => callsBy(cloud, b).filter((c) => c.path === '/sync/push' || c.method === 'PUT').length
    const before = pushes()
    const report = await b.sync()
    expect(report.readOnly).toBe(true)
    expect(b.library.tags().map((t) => t.id)).toEqual([tag.id])
    expect(b.library.note(id)?.body).toBe('kept here')
    expect(b.library.dirtyItems().map((s) => s.id)).toEqual([n.id])
    expect(pushes()).toBe(before + 1) // one try per pass, no repeat
    expect(b.library.syncItem(n.id)?.dirtySeq).not.toBeNull()
    b.engine.start({ beforeSync: () => {}, onPulled: () => {}, onSignedOut: () => {} })
    await until(() => b.engine.status.value.kind === 'readOnly', 'readOnly')
    b.engine.stop()
  })

  test('401 signs out', async () => {
    const { cloud, a } = await pair()
    cloud.tokens.delete(a.token)
    let signedOut = 0
    a.library.createNote({ title: 'unsynced' })
    a.engine.start({ beforeSync: () => {}, onPulled: () => {}, onSignedOut: () => void signedOut++ })
    await until(() => signedOut === 1, 'sign-out')
    expect(a.engine.status.value).toEqual({ kind: 'signedOut' })
    // local notes stay; the schedule stops
    expect(a.notes().length).toBe(2)
    expect(a.timers.count).toBe(0)
    a.engine.localChanged()
    a.engine.syncNow()
    a.timers.tick(600_000)
    await settle()
    expect(signedOut).toBe(1)
  })

  test('429 waits Retry-After', async () => {
    const { cloud, a } = await pair()
    cloud.fail((c) => c.path === '/sync/pull' && c.token === a.token, { status: 429, code: 'rate_limited', retryAfter: 30 })
    const pulls = () => callsBy(cloud, a).filter((c) => c.path === '/sync/pull').length
    const before = pulls()
    a.engine.start({ beforeSync: () => {}, onPulled: () => {}, onSignedOut: () => {} })
    await until(() => a.engine.status.value.kind === 'error', 'error')
    expect(a.engine.status.value).toEqual({ kind: 'error', message: 'Too many requests.' })
    expect(pulls()).toBe(before + 1)
    a.timers.tick(29_999)
    a.engine.syncNow() // on demand still waits for Retry-After
    a.engine.localChanged()
    a.timers.tick(0)
    await settle()
    expect(pulls()).toBe(before + 1)
    a.timers.tick(1)
    await until(() => a.engine.status.value.kind === 'idle', 'idle')
    expect(pulls()).toBe(before + 2)
    a.engine.stop()
  })

  test('push order: attachments, then notebooks and tags, then notes, in batches of 100', async () => {
    const cloud = new FakeCloud()
    const a = device(cloud, 'Mac A')
    for (let i = 0; i < 250; i++) a.library.createNote({ title: `N${i}`, body: `${i}` })
    const bytes = Uint8Array.of(9, 9, 9)
    const att = a.library.addAttachment({ bytes, filename: 'a.bin', mime: 'application/octet-stream', sha256: sha256(bytes) })
    const nb = a.library.createNotebook('Notebook', null)
    const tag = a.library.createTag('tag')
    const { report } = await a.engine.syncOnce()
    expect(report.pushed).toBe(253)
    const pushes = cloud.calls.filter((c) => c.path === '/sync/push')
    expect(pushes.map((p) => p.changes!.length)).toEqual([100, 100, 53])
    const changes = pushes.flatMap((p) => p.changes!)
    expect(changes.slice(0, 3).map((c) => c.id)).toEqual([att.id, nb.id, tag.id])
    expect(changes.slice(3).every((c) => c.type === 'note')).toBe(true)
    expect(changes.slice(3).map((c) => a.library.note(c.id)!.title)).toEqual(Array.from({ length: 250 }, (_, i) => `N${i}`))
    // blobs first, the attachment's before the notes'
    const puts = cloud.calls.filter((c) => c.method === 'PUT')
    expect(puts.length).toBe(251)
    expect(puts[0]!.path).toBe(`/blobs/${a.library.syncItem(att.id)!.blobSha}`)
    expect(cloud.calls.findIndex((c) => c.path === '/sync/push')).toBeGreaterThan(cloud.calls.lastIndexOf(puts.at(-1)!))
  })

  test("a pulled note's body loads in the background, the opened note first", async () => {
    const cloud = new FakeCloud()
    const a = device(cloud, 'Mac A')
    const b = device(cloud, 'Mac B')
    const oldest = a.library.createNote({ title: 'oldest', body: 'one' })
    a.clock.advance(60_000)
    const middle = a.library.createNote({ title: 'middle', body: 'two' })
    a.clock.advance(60_000)
    const newest = a.library.createNote({ title: 'newest', body: 'three' })
    a.clock.advance(60_000)
    const edited = a.library.createNote({ title: 'edited', body: 'four' })
    await a.sync()
    await b.engine.syncOnce()
    // metadata first: titles at once, bodies not yet
    expect(b.notes().map((n) => n.title)).toEqual(['edited', 'middle', 'newest', 'oldest'])
    for (const n of b.notes()) {
      expect(n.body).toBe('')
      expect(b.library.syncItem(n.id)?.bodyLoaded).toBe(false)
    }
    const shaOf = (id: string) => b.library.syncItem(id)!.blobSha!
    const idOfSha = new Map([oldest, middle, newest, edited].map((n) => [shaOf(n.id), n.id]))
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    cloud.hook = async (c) => {
      if (c.method !== 'GET' || !c.path.startsWith('/blobs/')) return
      const id = idOfSha.get(c.path.slice('/blobs/'.length))!
      order.push(id)
      if (order.length === 1) await gate // the first download is in flight while the note is opened
      if (id === edited.id) b.library.updateNote(id, { body: 'typed here' }) // typed while its body downloads
    }
    b.loader.start()
    await until(() => order.length >= 1, 'first download')
    const opened = b.loader.openNote(oldest.id)
    release()
    await opened
    expect(b.library.note(oldest.id)?.body).toBe('one')
    await until(() => order.length === 4 && b.library.syncItem(middle.id)?.bodyLoaded === true, 'all downloads')
    await settle()
    // newest `modified` first, four at once (BodyLoader PARALLEL), so here all four started together; an opened note
    // jumping a longer queue is in loading.test.ts
    expect(order).toEqual([edited.id, newest.id, middle.id, oldest.id])
    expect(b.library.note(newest.id)?.body).toBe('three')
    expect(b.library.note(middle.id)?.body).toBe('two')
    // the note edited here meanwhile keeps its edit (setRemoteBody refused it)
    expect(b.library.note(edited.id)?.body).toBe('typed here')
    expect(b.progress.at(-1)).toEqual([4, 4])
    b.loader.stop()
  })
})

describe('carried rules', () => {
  test('an item from a newer app (v 2) is never pushed, and the server version wins', async () => {
    const { cloud, a, b } = await pair()
    const id = '01JC8ZQ6V4N1XG2H3K5M7P9R0T'
    const meta = (title: string) => text.encode(JSON.stringify({ v: 2, title, notebook_id: null, tag_ids: [], pinned: false, created: 1, modified: 1, trashed_at: null, shade: 'mint' }))
    const [m1, body] = await a.crypto.seal(1, [{ plain: meta('Future'), part: 'metadata', id }, { plain: text.encode('future body'), part: 'noteBody', id }])
    const sha = sha256(body!)
    cloud.blobs.set(sha, body!)
    cloud.put({ id, type: 'note', version: 1, deleted: false, meta: m1!, blobSha: sha })
    await b.sync()
    expect(b.library.note(id)).toMatchObject({ title: 'Future', body: 'future body' })
    expect(b.library.syncItem(id)?.metaVersion).toBe(2)
    b.library.setPinned(id, true)
    const before = cloud.calls.length
    const { report } = await b.engine.syncOnce()
    expect(cloud.calls.slice(before).some((c) => c.changes?.some((ch) => ch.id === id))).toBe(false)
    expect(report.pushed).toBe(0)
    expect(b.library.dirtyItems().map((s) => s.id)).toEqual([id])
    // the server moves on: its version replaces the local edit
    const [m2] = await a.crypto.seal(1, [{ plain: meta('Future 2'), part: 'metadata', id }])
    cloud.put({ id, type: 'note', version: 2, deleted: false, meta: m2!, blobSha: sha })
    await b.engine.syncOnce()
    expect(b.library.note(id)).toMatchObject({ title: 'Future 2', pinned: false, body: 'future body' })
    expect(b.library.dirtyItems()).toEqual([])
    expect(cloud.calls.slice(before).some((c) => c.changes?.some((ch) => ch.id === id))).toBe(false)
  })

  test("a note whose body hasn't loaded pushes its metadata without a body", async () => {
    const cloud = new FakeCloud()
    const a = device(cloud, 'Mac A')
    const b = device(cloud, 'Mac B')
    const id = a.library.createNote({ title: 'Groceries', body: 'milk' }).id
    await a.sync()
    await b.engine.syncOnce()
    expect(b.library.syncItem(id)?.bodyLoaded).toBe(false)
    const sha = cloud.items.get(id)!.blobSha
    b.library.setPinned(id, true)
    const before = callsBy(cloud, b).length
    const { report } = await b.engine.syncOnce()
    expect(report.pushed).toBe(1)
    expect(callsBy(cloud, b).slice(before).some((c) => c.method === 'PUT')).toBe(false)
    expect(cloud.items.get(id)!.blobSha).toBe(sha)
    await a.sync()
    expect(a.library.note(id)).toMatchObject({ pinned: true, body: 'milk' })
    await b.loadAll()
    expect(b.library.note(id)).toMatchObject({ pinned: true, body: 'milk' })
  })

  test('an unloaded note in a conflict is compared with its real text', async () => {
    const cloud = new FakeCloud()
    const a = device(cloud, 'Mac A')
    const b = device(cloud, 'Mac B')
    const id = a.library.createNote({ title: 'Groceries', body: 'milk' }).id
    await a.sync()
    await b.engine.syncOnce()
    a.library.updateNote(id, { title: 'Shopping' })
    await a.sync()
    b.library.setPinned(id, true) // metadata only, body not loaded
    const { report } = await b.engine.syncOnce()
    expect(report.conflictCopies.length).toBe(1)
    const copy = b.library.note(report.conflictCopies[0]!)!
    expect(copy.title.startsWith('Groceries (conflict, Mac B, ')).toBe(true)
    expect(copy.body).toBe('milk')
    expect(b.library.note(id)).toMatchObject({ title: 'Shopping', body: 'milk' })
    expect(b.library.syncItem(id)?.bodyLoaded).toBe(true)
  })

  test('a notebook moved into a cycle goes to the top level and is pushed', async () => {
    const { cloud, a, b } = await pair()
    const p = a.library.createNotebook('P', null)
    const q = a.library.createNotebook('Q', null)
    await a.sync()
    await b.sync()
    a.library.moveNotebook(p.id, q.id) // P inside Q
    b.library.moveNotebook(q.id, p.id) // Q inside P
    await a.sync()
    const before = cloud.calls.length
    // B gets P inside Q, but Q is inside P here: P goes to the top level and B pushes that
    await b.sync()
    expect(b.library.notebooks().find((n) => n.id === p.id)?.parentId).toBeNull()
    expect(cloud.calls.slice(before).some((c) => c.token === b.token && c.changes?.some((ch) => ch.id === p.id))).toBe(true)
    // A gets Q inside P while P is inside Q here: the same rule (as on the Mac) puts Q at the top level
    await a.sync()
    await b.sync()
    for (const d of [a, b]) {
      const parents = d.library.notebooks().map((n) => [n.name, n.parentId])
      expect(parents, d.name).toEqual([['P', null], ['Q', null]])
      expect(d.library.dirtyItems()).toEqual([])
    }
  })

  test('a stale body download is refused and the new body loads', async () => {
    const { cloud, a, b, id } = await pair()
    a.library.updateNote(id, { body: 'v2' })
    await a.sync()
    await b.engine.syncOnce()
    const v2sha = b.library.syncItem(id)!.blobSha!
    let fired = false
    cloud.hook = async (c) => {
      if (fired || c.token !== b.token || c.path !== `/blobs/${v2sha}`) return
      fired = true
      // while v2 downloads, v3 arrives
      a.library.updateNote(id, { body: 'v3' })
      await a.engine.syncOnce()
      await b.engine.syncOnce()
    }
    await b.loader.openNote(id)
    await until(() => b.library.syncItem(id)?.bodyLoaded === true, 'v3 body')
    expect(b.library.note(id)?.body).toBe('v3')
  })

  test('a failed download is tried again later, with backoff', async () => {
    const { cloud, a, b, id } = await pair()
    a.library.updateNote(id, { body: 'later' })
    await a.sync()
    await b.engine.syncOnce()
    cloud.fail((c) => c.token === b.token && c.path.startsWith('/blobs/'), 'network', 2)
    b.loader.start()
    await settle()
    expect(b.library.syncItem(id)?.bodyLoaded).toBe(false)
    b.timers.tick(1999)
    await settle()
    expect(b.library.syncItem(id)?.bodyLoaded).toBe(false)
    b.timers.tick(1) // 2 s: fails again
    await settle()
    b.timers.tick(4000) // 4 s: loads
    await until(() => b.library.syncItem(id)?.bodyLoaded === true, 'body')
    expect(b.library.note(id)?.body).toBe('later')
    b.loader.stop()
  })
})

describe('fix round 1', () => {
  test('a deferred item re-applied after the pull never rolls back a newer version of itself', async () => {
    const cloud = new FakeCloud()
    const a = device(cloud, 'Mac A')
    const b = device(cloud, 'Mac B')
    const nb = a.library.createNotebook('Work', null)
    const n = a.library.createNote({ title: 'v1', body: 'x', notebookId: nb.id })
    await a.sync() // notebook seq 1, note seq 2
    a.library.renameNotebook(nb.id, 'Office')
    await a.sync() // notebook seq 3: B sees the note (v1) before its notebook
    cloud.pageSize = 1
    let pulls = 0
    cloud.hook = async (c) => {
      if (c.token !== b.token || c.path !== '/sync/pull' || ++pulls !== 2) return
      // between page 1 (the note at v1, deferred) and page 2, the note moves on to v2
      a.library.updateNote(n.id, { title: 'v2' })
      await a.engine.syncOnce()
    }
    await b.engine.syncOnce()
    cloud.hook = null
    expect(b.library.note(n.id)).toMatchObject({ title: 'v2', notebookId: nb.id })
    expect(b.library.syncItem(n.id)?.serverVersion).toBe(2)
    // later edits here still reach the server
    b.library.updateNote(n.id, { title: 'v3 from B' })
    const { report } = await b.engine.syncOnce()
    expect(report.rejected).toEqual({})
    expect(report.conflictCopies).toEqual([])
    expect(b.library.dirtyItems()).toEqual([])
    await a.engine.syncOnce()
    expect(a.library.note(n.id)?.title).toBe('v3 from B')
  })

  test("after resetSync(true), a note whose body hasn't loaded never pushes its placeholder", async () => {
    const cloud = new FakeCloud()
    const a = device(cloud, 'Mac A')
    const b = device(cloud, 'Mac B')
    const id = a.library.createNote({ title: 'Groceries', body: 'milk' }).id
    await a.sync()
    await b.engine.syncOnce()
    expect(b.library.syncItem(id)?.bodyLoaded).toBe(false)
    const sha = cloud.items.get(id)!.blobSha
    b.library.resetSync(true) // signed in again: everything is new to the server
    const before = callsBy(cloud, b).length
    const { report } = await b.engine.syncOnce()
    expect(callsBy(cloud, b).slice(before).some((c) => c.method === 'PUT')).toBe(false)
    expect(report.conflictCopies).toEqual([])
    expect(cloud.items.get(id)!.blobSha).toBe(sha)
    expect(b.notes().length).toBe(1)
    expect(b.library.note(id)?.body).toBe('milk')
    await a.sync()
    expect(a.library.note(id)?.body).toBe('milk')
    expect(a.notes().length).toBe(1)
  })
})

describe('the schedule', () => {
  test('now, 2 s after a local change, every 5 minutes, and on demand', async () => {
    const { cloud, a } = await pair()
    const pulls = () => callsBy(cloud, a).filter((c) => c.path === '/sync/pull').length
    let saved = 0
    const pulled: Array<Set<string>> = []
    const base = pulls()
    a.engine.start({ beforeSync: () => void saved++, onPulled: (ids) => void pulled.push(ids), onSignedOut: () => {} })
    await until(() => pulls() === base + 1 && a.engine.status.value.kind === 'idle', 'first pass')
    expect(saved).toBe(1)
    expect(a.engine.status.value).toEqual({ kind: 'idle', lastSynced: a.clock() })
    // 2 s after the last local change
    a.library.createNote({ title: 'x' })
    a.engine.localChanged()
    a.timers.tick(1000)
    a.engine.localChanged()
    a.timers.tick(1999)
    await settle()
    expect(pulls()).toBe(base + 1)
    a.timers.tick(1)
    await until(() => pulls() === base + 2, 'debounced pass')
    await settle()
    expect(a.library.dirtyItems()).toEqual([])
    // every 5 minutes
    a.timers.tick(299_999)
    await settle()
    expect(pulls()).toBe(base + 2)
    a.timers.tick(1)
    await until(() => pulls() === base + 3, '5-minute pass')
    await settle()
    // on demand
    a.engine.syncNow()
    a.timers.tick(0)
    await until(() => pulls() === base + 4, 'on demand')
    await settle()
    expect(saved).toBe(4)
    a.engine.stop()
    expect(a.timers.count).toBe(0)
  })

  test('onPulled gets the ids that changed here', async () => {
    const { a, b } = await pair()
    const n = a.library.createNote({ title: 'new', body: 'n' })
    await a.sync()
    let got: Set<string> | null = null
    b.engine.start({ beforeSync: () => {}, onPulled: (ids) => void (got = ids), onSignedOut: () => {} })
    await until(() => got !== null, 'onPulled')
    expect([...got!]).toEqual([n.id])
    b.engine.stop()
  })

  test('stop() ends a pass in flight at the next pull page, calls no hook, and settles once it has ended', async () => {
    const { cloud, a, b } = await pair()
    for (let i = 0; i < 3; i++) a.library.createNote({ title: `page ${i}`, body: 'b' })
    await a.sync()
    cloud.pageSize = 1
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let held = false
    cloud.hook = async (c) => {
      if (c.token === b.token && c.path === '/sync/pull' && !held) {
        held = true
        await gate
      }
    }
    let hooked = 0
    b.engine.start({ beforeSync: () => {}, onPulled: () => void hooked++, onSignedOut: () => void hooked++ })
    await until(() => held, 'pull held')
    let ended = false
    const stopped = b.engine.stop().then(() => void (ended = true))
    await settle()
    expect(ended).toBe(false)
    release()
    await stopped
    cloud.hook = null
    // one page applied, its cursor stored, no further page asked for
    expect(b.notes().filter((n) => n.title.startsWith('page ')).length).toBe(1)
    expect(hooked).toBe(0)
    expect(b.timers.count).toBe(0)
  })

  test('a push stopped while a blob uploads uploads no further blob and pulls nothing', async () => {
    const cloud = new FakeCloud()
    const a = device(cloud, 'Mac A')
    for (let i = 0; i < 3; i++) a.library.createNote({ title: `${i}`, body: `body ${i}` })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let held = false
    cloud.hook = async (c) => {
      if (c.method === 'PUT' && !held) {
        held = true
        await gate
      }
    }
    a.engine.start({ beforeSync: () => {}, onPulled: () => {}, onSignedOut: () => {} })
    await until(() => held, 'upload held')
    const stopped = a.engine.stop()
    release()
    await stopped
    cloud.hook = null
    expect(cloud.calls.filter((c) => c.method === 'PUT').length).toBe(1)
    expect(cloud.calls.filter((c) => c.path === '/sync/pull' || c.path === '/sync/push')).toEqual([])
    // nothing was lost: every note is still dirty for the next schedule
    expect(a.library.dirtyItems().length).toBe(3)
  })

  test('offline: retries after 2 s, then 4 s, until a pass succeeds', async () => {
    const { cloud, a } = await pair()
    const pulls = () => callsBy(cloud, a).filter((c) => c.path === '/sync/pull').length
    cloud.fail((c) => c.token === a.token && c.path === '/sync/pull', 'network', 2)
    const base = pulls()
    a.engine.start({ beforeSync: () => {}, onPulled: () => {}, onSignedOut: () => {} })
    await until(() => a.engine.status.value.kind === 'offline', 'offline')
    a.timers.tick(1999)
    await settle()
    expect(pulls()).toBe(base + 1)
    a.timers.tick(1)
    await until(() => pulls() === base + 2, 'retry 1')
    await settle()
    expect(a.engine.status.value.kind).toBe('offline')
    a.timers.tick(3999)
    await settle()
    expect(pulls()).toBe(base + 2)
    a.timers.tick(1)
    await until(() => a.engine.status.value.kind === 'idle', 'success')
    a.engine.stop()
  })

  test('a server error shows an error and retries', async () => {
    const { cloud, a } = await pair()
    cloud.fail((c) => c.token === a.token && c.path === '/sync/pull', { status: 500, code: 'server_error' })
    a.engine.start({ beforeSync: () => {}, onPulled: () => {}, onSignedOut: () => {} })
    await until(() => a.engine.status.value.kind === 'error', 'error')
    expect(a.engine.status.value).toEqual({ kind: 'error', message: "The server didn't respond." })
    a.timers.tick(2000)
    await until(() => a.engine.status.value.kind === 'idle', 'idle')
    a.engine.stop()
  })

  test('syncing counts pushed changes; loading counts bodies', async () => {
    const cloud = new FakeCloud()
    const a = device(cloud, 'Mac A')
    for (let i = 0; i < 3; i++) a.library.createNote({ title: `${i}` })
    const seen: string[] = []
    cloud.hook = () => {
      const s = a.engine.status.value
      if (s.kind === 'syncing') seen.push(`${s.done}/${s.total}`)
    }
    await a.engine.syncOnce()
    cloud.hook = null
    expect(seen).toContain('0/3')
    expect(a.engine.status.value).toEqual({ kind: 'syncing', done: 3, total: 3 })
    a.engine.loading(1, 4)
    expect(a.engine.status.value).toEqual({ kind: 'loading', done: 1, total: 4 })
    a.engine.loading(4, 4)
    expect(a.engine.status.value).toEqual({ kind: 'idle', lastSynced: null })
  })
})

describe('final review: typing while the same note changes elsewhere (C1)', () => {
  // the review's scratch case (stuck.test.ts): at every remote write to the note a keystroke is pending, so the app
  // model's beforeWrite turns it into a local change; the typing stops after the first pass
  test('a note edited at every remote write during one pass heals on the next passes', async () => {
    const { cloud, a, b, id } = await pair()
    b.library.updateNote(id, { body: 'from B' })
    await b.sync()
    let keys = 0
    a.library.watchRemote({ beforeWrite: (n) => void (n === id && a.library.updateNote(n, { body: `typed ${++keys}` })), wantsBody: (n) => n === id })
    await a.engine.syncOnce()
    a.library.watchRemote({})
    for (let i = 0; i < 3; i++) await a.sync()
    await b.sync()
    expect(a.library.dirtyItems()).toEqual([])
    expect(b.library.dirtyItems()).toEqual([])
    const last = `typed ${keys}`
    for (const d of [a, b]) {
      expect(d.library.note(id)?.body, d.name).toBe('from B')
      expect(bodies(d), d.name).toEqual(new Set(['from B', last]))
    }
    expect(cloud.items.get(id)!.version).toBe(a.library.syncItem(id)!.serverVersion)
  })

  // continuous typing: a key arrives during every request this device makes (each blob download included) and is
  // flushed into the note by beforeWrite, as the app model's 500 ms save would
  test('continuous typing during the pull: the first pass lands a conflict copy and no typed key is lost', async () => {
    const { cloud, a, b, id } = await pair()
    b.library.updateNote(id, { body: 'from B' })
    await b.sync()
    let pending = ''
    let typed = ''
    let n = 0
    const flush = () => {
      if (!pending) return
      a.library.updateNote(id, { body: a.library.note(id)!.body + pending })
      pending = ''
    }
    a.library.watchRemote({ beforeWrite: (x) => void (x === id && flush()), wantsBody: (x) => x === id })
    cloud.hook = (c) => {
      if (c.token !== a.token) return
      const key = String.fromCharCode(97 + (n++ % 26))
      pending += key
      typed += key
    }
    const { report } = await a.engine.syncOnce()
    cloud.hook = null
    a.library.watchRemote({})
    expect(report.conflictCopies.length).toBe(1)
    expect(a.library.note(id)?.body).toBe('from B')
    flush()
    // every key typed is in the conflict copy (those typed before B's version landed) or in the note, in order
    const copy = a.library.note(report.conflictCopies[0]!)!
    const k = copy.body.length - 'milk'.length
    expect(k).toBeGreaterThan(0)
    expect(copy.body).toBe('milk' + typed.slice(0, k))
    expect(a.library.note(id)!.body).toBe('from B' + typed.slice(k))
    await a.sync()
    await b.sync()
    await a.sync()
    expect(a.library.dirtyItems()).toEqual([])
    expect(b.library.dirtyItems()).toEqual([])
    expect(bodies(a)).toEqual(new Set(['milk' + typed.slice(0, k), 'from B' + typed.slice(k)]))
    expect(bodies(b)).toEqual(bodies(a))
  })

  // the push-conflict path: an item whose newer server version the pull will never return again (the cursor went past
  // it, as a kept copy stuck by the old engine has) is resolved from the push result's `current`
  test("a push conflict is resolved from the server's current item, not left to the pull", async () => {
    const { a, b, id } = await pair()
    b.library.updateNote(id, { body: 'from B' })
    await b.sync()
    // A's cursor is already past B's version of the note
    a.library.setSyncValue('pull_cursor', b.library.syncValue('pull_cursor'))
    a.library.updateNote(id, { body: 'from A' })
    const { report } = await a.engine.syncOnce()
    expect(report.conflictCopies.length).toBe(1)
    await a.sync()
    await b.sync()
    for (const d of [a, b]) {
      expect(d.library.dirtyItems(), d.name).toEqual([])
      expect(d.library.note(id)?.body, d.name).toBe('from B')
      expect(bodies(d), d.name).toEqual(new Set(['from B', 'from A']))
    }
  })

  test('an item the pull had to skip keeps the cursor before it, and the pass is not shown as synced', async () => {
    const { a, b, id } = await pair()
    const before = a.library.syncValue('pull_cursor')
    b.library.updateNote(id, { body: 'from B' })
    await b.sync()
    // typing at every remote write, without end: nothing can land
    let keys = 0
    const stopTyping = a.library.watchRemote({ beforeWrite: (n) => void (n === id && a.library.updateNote(n, { body: `typed ${++keys}` })), wantsBody: (n) => n === id })
    let passes = 0
    a.engine.start({ beforeSync: () => {}, onPulled: () => {}, onSignedOut: () => {}, afterPass: () => void passes++ })
    await until(() => passes === 1, 'first pass')
    await settle()
    expect(a.library.syncValue('pull_cursor')).toBe(before)
    expect(a.engine.status.value.kind).not.toBe('idle')
    // the typing stops: the next pass (soon, not in 5 minutes) lands it
    stopTyping()
    a.timers.tick(2_000)
    await until(() => passes === 2, 'second pass')
    expect(a.engine.status.value.kind).toBe('idle')
    await settle()
    await a.engine.stop()
    expect(a.library.dirtyItems()).toEqual([])
    expect(a.library.note(id)?.body).toBe('from B')
    expect(bodies(a)).toEqual(new Set(['from B', `typed ${keys}`]))
  })
})
