// Loading a library (web design "Loading a library"; Phase 20 Task 12): the list shows from the metadata at once,
// bodies arrive in the background without redrawing the list, a note whose body hasn't arrived is read-only and says
// so, attachments from another device download when first shown, and a file being added when the library changes
// (a lock) never lands in the new one.
import { afterEach, describe, expect, test } from 'vitest'
import { Library } from '../../src/core/library/library.ts'
import type { Note } from '../../src/core/library/types.ts'
import { ApiClient } from '../../src/core/sync/api.ts'
import { BodyLoader } from '../../src/core/sync/bodies.ts'
import { SyncEngine } from '../../src/core/sync/engine.ts'
import { createAppModel } from '../../src/model/app-model.ts'
import { listDate, noteMeta, rowLabel } from '../../src/model/format.ts'
import type { CryptoClient } from '../../src/worker/crypto-client.ts'
import { fakeClock } from './support/clock.ts'
import { fakeCrypto, FakeCloud } from './support/fake-cloud.ts'
import { fakeTimers } from './support/timers.ts'

const remote = (o: Partial<Note> & { id: string }): Note => ({
  title: 'Remote', body: '', notebookId: null, tagIds: [], pinned: false, created: 1, modified: 1, trashedAt: null, origin: 'user', ...o,
})
const ULID = (n: number) => `01JC8ZV2VW3XY4ZA5BC6DE${String(n).padStart(4, '0')}`

/** A library holding `n` notes from the server whose bodies haven't arrived (blob `sha-<i>`). */
function unloadedLibrary(n: number) {
  const clock = fakeClock()
  const lib = new Library(clock)
  for (let i = 0; i < n; i++) {
    lib.applyRemoteNote(remote({ id: ULID(i), title: `Note ${i}`, modified: 1000 + i }), { version: 1, extra: null, metaVersion: 1, blobSha: `sha-${i}`, bodyLoaded: false })
  }
  return { clock, lib }
}

describe('the list while bodies arrive', () => {
  let restore: (() => void) | null = null
  afterEach(() => {
    restore?.()
    restore = null
  })

  test('formatting a row makes no new date formatter each time', () => {
    const Real = Intl.DateTimeFormat
    let made = 0
    const Counting = function (this: unknown, ...a: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      made++
      return new Real(...a)
    } as unknown as typeof Intl.DateTimeFormat
    Intl.DateTimeFormat = Counting
    restore = () => void (Intl.DateTimeFormat = Real)
    const now = Date.UTC(2026, 10, 13, 12)
    const s = { id: ULID(1), title: 'A', notebookId: null, pinned: false, created: 1, modified: now - 3 * 86_400_000, trashedAt: null, origin: 'user' as const, preview: '' }
    // warm up: the formatters each option set needs are made once
    rowLabel(s, 'Home', now)
    noteMeta(s, 'Home', now)
    listDate(now, now)
    listDate(now - 86_400_000, now)
    const before = made
    for (let i = 0; i < 1000; i++) {
      rowLabel({ ...s, modified: now - i * 3_600_000 }, 'Home', now)
      noteMeta({ ...s, modified: now - i * 3_600_000 }, null, now)
    }
    expect(made - before).toBe(0)
  })

  test("a body that arrives for a note that isn't open leaves the list, counts and notebooks alone", () => {
    const { lib, clock } = unloadedLibrary(50)
    const m = createAppModel(lib, { clock, setTimer: fakeTimers(clock) })
    m.selectNote(ULID(0))
    const rows = m.rows.value
    const counts = m.counts.value
    const notebooks = m.notebooks.value
    expect(lib.setRemoteBody(ULID(7), 'seven', 'sha-7')).toBe(true)
    expect(m.rows.value).toBe(rows)
    expect(m.counts.value).toBe(counts)
    expect(m.notebooks.value).toBe(notebooks)
    // and the body is there for whoever reads the note
    m.selectNote(ULID(7))
    expect(m.openNote.value?.body).toBe('seven')
  })

  test('while searching, an arriving body is searched', () => {
    const { lib, clock } = unloadedLibrary(5)
    const m = createAppModel(lib, { clock, setTimer: fakeTimers(clock) })
    m.setSearch('turnip')
    expect(m.rows.value).toEqual([])
    lib.setRemoteBody(ULID(3), 'a turnip soup', 'sha-3')
    expect(m.rows.value.map((r) => r.note.id)).toEqual([ULID(3)])
  })

  test("a pull page's metadata is opened in one call to the worker", async () => {
    const cloud = new FakeCloud()
    const clock = fakeClock()
    const crypto = fakeCrypto(new Uint8Array(32).fill(7))
    const a = new Library(clock)
    for (let i = 0; i < 30; i++) a.createNote({ title: `N${i}`, body: `b${i}` })
    const engineFor = (library: Library, c: CryptoClient, name: string) =>
      new SyncEngine({ library, api: new ApiClient({ base: cloud.base, token: cloud.token(name), fetch: cloud.fetch }), crypto: c, session: 1, libraryId: cloud.libraryId, deviceName: name, clock })
    await engineFor(a, crypto, 'A').syncOnce()

    const calls: number[] = []
    const counting: CryptoClient = { ...crypto, open: (s, list) => (calls.push(list.length), crypto.open(s, list)) }
    const b = new Library(clock)
    await engineFor(b, counting, 'B').syncOnce()
    expect(b.notes({ kind: 'all' })).toHaveLength(30)
    expect(calls).toEqual([30])
  })
})

describe('a note whose body has not arrived', () => {
  test('says so, is read-only, and shows the body once it arrives', () => {
    const { lib, clock } = unloadedLibrary(1)
    const timers = fakeTimers(clock)
    const m = createAppModel(lib, { clock, setTimer: timers })
    m.selectNote(ULID(0))
    expect(m.openNoteLoading.value).toBe(true)
    m.editBody('typed over the placeholder')
    expect(m.draft.value).toBeNull()
    // the title may change; the body it is saved with is never the placeholder, even if the body arrives meanwhile
    m.editTitle('A new title')
    lib.setRemoteBody(ULID(0), 'the real text', 'sha-0')
    expect(m.draft.value).toEqual({ title: 'A new title', body: 'the real text' })
    timers.tick(1000)
    expect(lib.note(ULID(0))).toMatchObject({ title: 'A new title', body: 'the real text' })
    expect(lib.syncItem(ULID(0))).toMatchObject({ bodyDirty: false, bodyLoaded: true })

    expect(m.openNoteLoading.value).toBe(false)
    expect(m.openNote.value?.body).toBe('the real text')
    m.editBody('the real text, edited')
    timers.tick(1000)
    expect(lib.note(ULID(0))?.body).toBe('the real text, edited')
  })

  test('stays read-only when its download failed', () => {
    const { lib, clock } = unloadedLibrary(1)
    const m = createAppModel(lib, { clock, setTimer: fakeTimers(clock) })
    m.selectNote(ULID(0))
    // the loader gave up on it (no blob on the server): nothing arrived
    expect(m.openNoteLoading.value).toBe(true)
    m.editBody('x')
    expect(m.draft.value).toBeNull()
  })

  test('a note made here, or in the demo, is never loading', () => {
    const clock = fakeClock()
    const lib = new Library(clock)
    const n = lib.createNote({ title: 'mine' })
    const m = createAppModel(lib, { clock, setTimer: fakeTimers(clock) })
    m.selectNote(n.id)
    expect(m.openNoteLoading.value).toBe(false)
  })
})

describe('attachments from another device', () => {
  function withRemoteAttachment() {
    const clock = fakeClock()
    const lib = new Library(clock)
    const id = ULID(9)
    lib.applyRemoteAttachment({ id, filename: 'photo.png', mime: 'image/png', size: 3, sha256: 'x', created: 1 }, null, { version: 1, extra: null, metaVersion: 1, blobSha: 'blob-9' })
    return { clock, lib, id, url: `feather://attachment/${id}` }
  }

  test('download when first shown, once; then resolve', async () => {
    const { clock, lib, id, url } = withRemoteAttachment()
    const m = createAppModel(lib, { clock, setTimer: fakeTimers(clock) })
    const asked: string[] = []
    let finish!: () => void
    m.setLibrary(lib, {
      loadAttachment: (a) => {
        asked.push(a)
        return new Promise<Uint8Array | null>((resolve) => {
          finish = () => {
            lib.applyRemoteAttachment({ id, filename: 'photo.png', mime: 'image/png', size: 3, sha256: 'x', created: 1 }, new Uint8Array([1, 2, 3]), { version: 1, extra: null, metaVersion: 1, blobSha: 'blob-9' })
            resolve(new Uint8Array([1, 2, 3]))
          }
        })
      },
    })
    const before = m.attachmentsVersion.value
    expect(m.attachmentUrl(url)).toBeNull()
    expect(m.attachmentUrl(url)).toBeNull()
    expect(asked).toEqual([id])
    finish()
    await Promise.resolve()
    await Promise.resolve()
    expect(m.attachmentsVersion.value).toBeGreaterThan(before)
    expect(m.attachmentUrl(url)).toMatchObject({ filename: 'photo.png', image: true })
  })

  test('a download that fails is not tried again on every redraw', async () => {
    const { clock, lib, url } = withRemoteAttachment()
    const m = createAppModel(lib, { clock, setTimer: fakeTimers(clock) })
    let asked = 0
    m.setLibrary(lib, { loadAttachment: () => (asked++, Promise.reject(new Error('offline'))) })
    expect(m.attachmentUrl(url)).toBeNull()
    await Promise.resolve()
    await Promise.resolve()
    expect(m.attachmentUrl(url)).toBeNull()
    expect(asked).toBe(1)
  })
})

describe('adding files', () => {
  test('a file still being read when the library changes (a lock) is dropped, not added to the new library', async () => {
    const clock = fakeClock()
    const lib = new Library(clock)
    const m = createAppModel(lib, { clock, setTimer: fakeTimers(clock) })
    let release!: (b: ArrayBuffer) => void
    const file = { name: 'a.png', type: 'image/png', size: 3, arrayBuffer: () => new Promise<ArrayBuffer>((r) => (release = r)) } as unknown as File
    const adding = m.addFiles([file])
    const next = new Library(clock)
    m.setLibrary(next)
    release(new Uint8Array([1, 2, 3]).buffer)
    expect(await adding).toEqual([])
    expect(next.attachments()).toEqual([])
    expect(lib.attachments()).toEqual([])
  })
})

describe('the body loader', () => {
  /** A server whose blob downloads the test answers one by one. */
  function slowServer() {
    const waiting: Array<{ sha: string; answer: () => void }> = []
    const api = {
      getBlob: (sha: string) => new Promise<Uint8Array>((resolve) => waiting.push({ sha, answer: () => resolve(new TextEncoder().encode(sha)) })),
    } as unknown as ApiClient
    const crypto = { open: async (_s: number, list: Array<{ envelope: Uint8Array }>) => list.map((x) => x.envelope) } as unknown as CryptoClient
    return { api, crypto, waiting }
  }
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }

  test('downloads a few bodies at once, newest first, and the opened note still goes first', async () => {
    const { lib, clock } = unloadedLibrary(10)
    const { api, crypto, waiting } = slowServer()
    const loader = new BodyLoader({ library: lib, api, crypto, session: 1, timers: fakeTimers(clock), onProgress: () => undefined })
    loader.start()
    await flush()
    expect(waiting.map((w) => w.sha)).toEqual(['sha-9', 'sha-8', 'sha-7', 'sha-6'])
    const opened = loader.openNote(ULID(0))
    waiting[0]!.answer()
    await flush()
    // the freed place goes to the opened note
    expect(waiting.map((w) => w.sha)).toEqual(['sha-9', 'sha-8', 'sha-7', 'sha-6', 'sha-0'])
    waiting[4]!.answer()
    await opened
    expect(lib.note(ULID(0))?.body).toBe('sha-0')
    expect(lib.note(ULID(9))?.body).toBe('sha-9')
    for (let i = 0; i < 20 && waiting.some((w) => !lib.syncItem(ULID(Number(w.sha.slice(4))))?.bodyLoaded); i++) {
      for (const w of waiting) w.answer()
      await flush()
    }
    expect(lib.notes({ kind: 'all' }).every((n) => lib.syncItem(n.id)?.bodyLoaded)).toBe(true)
    loader.stop()
  })
})

describe('fix round 1', () => {
  test('a body still downloading when the loader stops (a lock) never lands in the library let go', async () => {
    const { lib, clock } = unloadedLibrary(1)
    const waiting: Array<() => void> = []
    const api = { getBlob: (sha: string) => new Promise<Uint8Array>((r) => waiting.push(() => r(new TextEncoder().encode(sha)))) } as unknown as ApiClient
    const crypto = { open: async (_s: number, list: Array<{ envelope: Uint8Array }>) => list.map((x) => x.envelope) } as unknown as CryptoClient
    const loader = new BodyLoader({ library: lib, api, crypto, session: 1, timers: fakeTimers(clock), onProgress: () => undefined })
    loader.start()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(waiting).toHaveLength(1)
    loader.stop()
    waiting[0]!()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(lib.note(ULID(0))?.body).toBe('')
    expect(lib.syncItem(ULID(0))?.bodyLoaded).toBe(false)
  })

  test('one unreadable item in a pull page still fails the pass, and nothing after it is half-applied', async () => {
    const cloud = new FakeCloud()
    const clock = fakeClock()
    const crypto = fakeCrypto(new Uint8Array(32).fill(7))
    const a = new Library(clock)
    for (let i = 0; i < 5; i++) a.createNote({ title: `N${i}`, body: `b${i}` })
    const engineFor = (library: Library, name: string) =>
      new SyncEngine({ library, api: new ApiClient({ base: cloud.base, token: cloud.token(name), fetch: cloud.fetch }), crypto, session: 1, libraryId: cloud.libraryId, deviceName: name, clock })
    await engineFor(a, 'A').syncOnce()
    // one envelope damaged on the server
    const bad = [...cloud.items.values()].find((it) => it.type === 'note')!
    bad.meta = bad.meta!.slice()
    bad.meta[bad.meta.length - 1]! ^= 1
    const b = new Library(clock)
    await expect(engineFor(b, 'B').syncOnce()).rejects.toThrow()
    // the cursor didn't move past the page, so the next pass takes it again
    expect(b.syncValue('pull_cursor')).toBeNull()
  })
})
