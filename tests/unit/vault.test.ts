// The vault: what a locked tab keeps (web design "Logged in": every item as its envelope, unsynced edits included).
// Sealing then opening gives the same library and the same sync bookkeeping; nothing sealed holds plaintext.
import { describe, expect, test } from 'vitest'
import { ARGON2_V1 } from '../../src/core/crypto/argon2.ts'
import { CryptoError } from '../../src/core/crypto/errors.ts'
import { Library } from '../../src/core/library/library.ts'
import { seedSampleLibrary } from '../../src/core/library/sample.ts'
import type { Note } from '../../src/core/library/types.ts'
import { Vault, type VaultCredentials } from '../../src/core/vault/vault.ts'
import { newUlid } from '../../src/core/ulid.ts'
import { fakeClock } from './support/clock.ts'
import { fakeCrypto } from './support/fake-cloud.ts'

const MASTER = new Uint8Array(32).fill(7)
const LIBRARY = '01JC8ZN0AB1CD2EF3GH4JK5MN6'
const CREDS: VaultCredentials = {
  email: 'ada@example.com', serverOrigin: 'https://cloud.test', token: 'fn1_token', deviceId: 'dev_1', libraryId: LIBRARY,
  wrappedMasterPassword: new Uint8Array(74).fill(1), salt: new Uint8Array(16).fill(2), kdf: { ...ARGON2_V1 },
}
const SECRETS = ['Secret plan', 'the treasure is under the oak', 'Expeditions', 'buried', 'map-of-the-oak.png', 'lost name']
const utf8 = new TextEncoder()

/** A library with one of everything the vault must keep: clean and dirty items, a body that hasn't arrived, an
 *  attachment not downloaded, a pending tombstone, newer metadata (v 2) with unknown fields, a lost rename, a cursor. */
function richLibrary() {
  const clock = fakeClock()
  const lib = new Library(clock)
  const nb = lib.createNotebook('Expeditions', null)
  const tag = lib.createTag('buried')
  const img = lib.addAttachment({ bytes: utf8.encode('PNG bytes of the oak'), filename: 'map-of-the-oak.png', mime: 'image/png', sha256: 'ab'.repeat(32) })
  const secret = lib.createNote({ title: 'Secret plan', body: `the treasure is under the oak\n![map](feather://attachment/${img.id})`, notebookId: nb.id, tagIds: [tag.id] })
  const gone = lib.createNote({ title: 'Gone soon', body: 'x' })
  // everything so far reached the server
  for (const s of lib.dirtyItems()) lib.markPushed(s.id, 3, s.type === 'note' || s.type === 'attachment' ? 'cd'.repeat(32) : null, s.dirtySeq!)
  // unsynced edits on top
  clock.advance(1000)
  lib.updateNote(secret.id, { body: 'the treasure is under the oak, typed offline' })
  lib.setPinned(secret.id, true)
  lib.deleteNotePermanently(gone.id)
  lib.trashNote(lib.createNote({ title: 'In the trash', body: 'trashed body' }).id)
  // from the server: a note whose body hasn't arrived, an attachment not downloaded, and a v2 item
  const t = clock()
  const unloaded: Note = { id: newUlid(clock), title: 'Arrived without its body', body: '', notebookId: null, tagIds: [], pinned: false, created: t, modified: t, trashedAt: null, origin: 'user' }
  lib.applyRemoteNote(unloaded, { version: 5, extra: null, metaVersion: 1, blobSha: 'ef'.repeat(32), bodyLoaded: false })
  const fileId = newUlid(clock)
  lib.applyRemoteAttachment({ id: fileId, filename: 'report.pdf', mime: 'application/pdf', size: 1234, sha256: '12'.repeat(32), created: t }, null, { version: 2, extra: null, metaVersion: 1, blobSha: '34'.repeat(32) })
  const future: Note = { ...unloaded, id: newUlid(clock), title: 'From a newer app', body: 'newer body' }
  lib.applyRemoteNote(future, { version: 1, extra: { colour: 'teal', z_list: [1, 2] }, metaVersion: 2, blobSha: '56'.repeat(32), bodyLoaded: true })
  lib.recordSyncConflict({ itemId: tag.id, type: 'tag', lostName: 'lost name', device: 'Mac B', at: t })
  lib.setSyncValue('pull_cursor', 'c_000000000042')
  return { clock, lib, secret, gone, img, fileId, future, unloaded }
}

/** Everything a library holds, for comparing two of them. */
function contents(lib: Library) {
  const ids = [...lib.notes({ kind: 'all' }), ...lib.notes({ kind: 'trash' })].map((n) => n.id).sort()
  return {
    notes: ids.map((id) => lib.note(id)),
    notebooks: lib.notebooks(),
    tags: lib.tags(),
    attachments: lib.attachments().sort((a, b) => (a.id < b.id ? -1 : 1)),
    sync: lib.syncItems().sort((a, b) => (a.id < b.id ? -1 : 1)),
    dirty: lib.dirtyItems().map((s) => s.id),
    conflicts: lib.syncConflicts(),
    cursor: lib.syncValue('pull_cursor'),
  }
}

describe('Vault', () => {
  test('sealing then opening gives back the same library, unsynced edits and bookkeeping included', async () => {
    const { lib, clock, gone, future } = richLibrary()
    const crypto = fakeCrypto(MASTER)
    const vault = await Vault.create(lib, crypto, 1, CREDS)
    expect(vault.email).toBe(CREDS.email)
    expect(vault.cursor).toBe('c_000000000042')
    // the pending tombstone is kept, with nothing to open
    expect(vault.items.get(gone.id)).toMatchObject({ meta: null, blob: null, sync: { deleted: true } })

    const opened = await vault.open(crypto, 1, clock)
    expect(contents(opened)).toEqual(contents(lib))
    // unknown fields and the newer metadata version survive
    expect(opened.syncItem(future.id)).toMatchObject({ metaVersion: 2, extra: { colour: 'teal', z_list: [1, 2] } })
    // and search works on what was opened
    expect(opened.search('treasure').map((h) => h.note.title)).toEqual(['Secret plan'])
    // a new change gets a later seq than every restored one
    const before = Math.max(...opened.dirtyItems().map((s) => s.dirtySeq!))
    opened.createNote({ title: 'after unlock' })
    expect(opened.dirtyItems().at(-1)!.dirtySeq).toBeGreaterThan(before)
  })

  test('nothing sealed holds plaintext', async () => {
    const { lib } = richLibrary()
    const vault = await Vault.create(lib, fakeCrypto(MASTER), 1, CREDS)
    const stored: Uint8Array[] = [vault.conflicts, vault.wrappedMasterPassword]
    for (const it of vault.items.values()) {
      if (it.meta) stored.push(it.meta)
      if (it.blob) stored.push(it.blob)
    }
    const all = Buffer.concat(stored.map((b) => Buffer.from(b)))
    for (const s of SECRETS) expect(all.includes(Buffer.from(utf8.encode(s))), s).toBe(false)
    // and the bookkeeping that sits beside the envelopes holds no names
    expect(JSON.stringify([...vault.items.values()].map((i) => i.sync))).not.toMatch(/Secret|treasure|Expeditions|buried|oak/)
    expect([...vault.items.values()].every((i) => i.sync.extra === null)).toBe(true)
  })

  test('sample items never go into the vault', async () => {
    const clock = fakeClock()
    const lib = new Library(clock)
    seedSampleLibrary(lib, clock)
    const mine = lib.createNote({ title: 'Mine', body: 'mine' })
    const vault = await Vault.create(lib, fakeCrypto(MASTER), 1, CREDS)
    expect([...vault.items.keys()]).toEqual([mine.id])
  })

  test('a vault opened with another master key fails whole, not half', async () => {
    const { lib, clock } = richLibrary()
    const vault = await Vault.create(lib, fakeCrypto(MASTER), 1, CREDS)
    await expect(vault.open(fakeCrypto(new Uint8Array(32).fill(8)), 1, clock)).rejects.toBeInstanceOf(CryptoError)
  })

  test('a title too long for the server is still kept whole', async () => {
    const clock = fakeClock()
    const lib = new Library(clock)
    const n = lib.createNote({ title: 'T'.repeat(70_000), body: 'body' })
    const vault = await Vault.create(lib, fakeCrypto(MASTER), 1, CREDS)
    expect((await vault.open(fakeCrypto(MASTER), 1, clock)).note(n.id)?.title.length).toBe(70_000)
  })

  test('the cursor is the one the sealed items were taken with, not one a pull moved during the seal', async () => {
    const { lib } = richLibrary()
    const crypto = fakeCrypto(MASTER)
    const moving = { ...crypto, seal: async (...a: Parameters<typeof crypto.seal>) => {
      lib.setSyncValue('pull_cursor', 'c_000000000099')
      return crypto.seal(...a)
    } }
    const vault = await Vault.create(lib, moving, 1, CREDS)
    expect(vault.cursor).toBe('c_000000000042')
  })

  test('seal seals every item, dirty ones included, and calls the worker once', async () => {
    const { lib } = richLibrary()
    const crypto = fakeCrypto(MASTER)
    let calls = 0
    const counting = { ...crypto, seal: (...a: Parameters<typeof crypto.seal>) => (calls++, crypto.seal(...a)) }
    const items = await Vault.seal(lib, counting, 1)
    expect(calls).toBe(1)
    expect(new Set(items.keys())).toEqual(new Set(lib.syncItems().map((s) => s.id)))
  })
})

describe('final review: a deleted tag or notebook never comes back on its notes (I1)', () => {
  const tagAndNote = () => {
    const clock = fakeClock()
    const lib = new Library(clock)
    const nb = lib.createNotebook('Work', null)
    const tag = lib.createTag('work')
    const n = lib.createNote({ title: 'N', body: 'x', notebookId: nb.id, tagIds: [tag.id] })
    // clean, as after a sync, so only the tag's or notebook's own record changes below
    for (const s of lib.dirtyItems()) lib.markPushed(s.id, 1, s.type === 'note' ? 'cd'.repeat(32) : null, s.dirtySeq!)
    return { clock, lib, nb, tag, n }
  }

  test('a tag deleted here: the next incremental seal drops it from its notes', async () => {
    const { clock, lib, tag, n } = tagAndNote()
    const crypto = fakeCrypto(MASTER)
    const v1 = await Vault.create(lib, crypto, 1, CREDS)
    lib.deleteTag(tag.id)
    const v2 = await Vault.create(lib, crypto, 1, CREDS, v1)
    const back = await v2.open(crypto, 1, clock)
    expect(back.note(n.id)?.tagIds).toEqual([])
    const home = back.createTag('home')
    back.setTags(n.id, [home.id])
    expect(back.note(n.id)?.tagIds).toEqual([home.id])
  })

  test('a tag or notebook deleted on another device: the same after lock and unlock', async () => {
    const { clock, lib, nb, tag, n } = tagAndNote()
    const crypto = fakeCrypto(MASTER)
    const v1 = await Vault.create(lib, crypto, 1, CREDS)
    lib.applyRemoteDelete(tag.id, 'tag', 2)
    lib.applyRemoteDelete(nb.id, 'notebook', 2)
    const v2 = await Vault.create(lib, crypto, 1, CREDS, v1)
    const back = await v2.open(crypto, 1, clock)
    expect(back.note(n.id)).toMatchObject({ tagIds: [], notebookId: null })
    // and a second round from the opened vault keeps it so
    const v3 = await Vault.create(back, crypto, 1, CREDS, v2)
    expect((await v3.open(crypto, 1, clock)).note(n.id)).toMatchObject({ tagIds: [], notebookId: null })
  })

  test('an unchanged item still keeps its envelope, also right after opening', async () => {
    const { clock, lib, n } = tagAndNote()
    const crypto = fakeCrypto(MASTER)
    const v1 = await Vault.create(lib, crypto, 1, CREDS)
    const v2 = await Vault.create(lib, crypto, 1, CREDS, v1)
    expect(v2.items.get(n.id)!.meta).toBe(v1.items.get(n.id)!.meta)
    const back = await v2.open(crypto, 1, clock)
    const v3 = await Vault.create(back, crypto, 1, CREDS, v2)
    expect(v3.items.get(n.id)!.meta).toBe(v1.items.get(n.id)!.meta)
  })

  test('opening a vault whose note names a tag or notebook that is gone drops the reference', async () => {
    const { clock, lib, nb, tag, n } = tagAndNote()
    const crypto = fakeCrypto(MASTER)
    const v1 = await Vault.create(lib, crypto, 1, CREDS)
    // a copy saved by an older build, with the dangling ids sealed in
    v1.items.delete(tag.id)
    v1.items.delete(nb.id)
    const back = await v1.open(crypto, 1, clock)
    expect(back.note(n.id)).toMatchObject({ tagIds: [], notebookId: null })
    const home = back.createTag('home')
    back.setTags(n.id, [home.id])
    expect(back.note(n.id)?.tagIds).toEqual([home.id])
  })
})
