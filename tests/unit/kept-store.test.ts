// "Keep my notes on this browser" (Phase 20 Task 10): the vault kept in IndexedDB database "feathermark", against
// fake-indexeddb. What is stored is the sealed vault only (no plaintext), it comes back exactly as it went in, a
// damaged record fails the whole load, and removing it leaves no database behind.
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { describe, expect, test } from 'vitest'
import { ARGON2_V1 } from '../../src/core/crypto/argon2.ts'
import { Library } from '../../src/core/library/library.ts'
import type { Note } from '../../src/core/library/types.ts'
import { newUlid } from '../../src/core/ulid.ts'
import { KeptStore, KeptVaultDamaged, NotKeptOwner } from '../../src/core/vault/kept-store.ts'
import { Vault, type VaultCredentials } from '../../src/core/vault/vault.ts'
import { fakeClock } from './support/clock.ts'
import { fakeCrypto } from './support/fake-cloud.ts'

const MASTER = new Uint8Array(32).fill(7)
const LIBRARY = '01JC8ZN0AB1CD2EF3GH4JK5MN6'
const CREDS: VaultCredentials = {
  email: 'ada@example.com', serverOrigin: 'https://cloud.test', token: 'fn1_token', deviceId: 'dev_1', libraryId: LIBRARY,
  wrappedMasterPassword: new Uint8Array(74).fill(1), salt: new Uint8Array(16).fill(2), kdf: { ...ARGON2_V1 },
}
const SECRETS = ['Secret plan', 'the treasure is under the oak', 'Expeditions', 'buried', 'map-of-the-oak.png', 'lost name', 'newer body']
const utf8 = new TextEncoder()

/** A library with what the kept copy must carry exactly: a dirty note, a note whose body hasn't arrived, newer
 *  metadata (v 2) with unknown fields, an attachment, a pending tombstone, a lost rename and a cursor. */
function library() {
  const clock = fakeClock()
  const lib = new Library(clock)
  const nb = lib.createNotebook('Expeditions', null)
  const tag = lib.createTag('buried')
  const img = lib.addAttachment({ bytes: utf8.encode('PNG bytes'), filename: 'map-of-the-oak.png', mime: 'image/png', sha256: 'ab'.repeat(32) })
  const gone = lib.createNote({ title: 'Gone soon', body: 'x' })
  for (const s of lib.dirtyItems()) lib.markPushed(s.id, 3, s.type === 'note' || s.type === 'attachment' ? 'cd'.repeat(32) : null, s.dirtySeq!)
  lib.createNote({ title: 'Secret plan', body: 'the treasure is under the oak', notebookId: nb.id, tagIds: [tag.id] })
  lib.deleteNotePermanently(gone.id)
  const t = clock()
  const unloaded: Note = { id: newUlid(clock), title: 'Arrived without its body', body: '', notebookId: null, tagIds: [], pinned: false, created: t, modified: t, trashedAt: null, origin: 'user' }
  lib.applyRemoteNote(unloaded, { version: 5, extra: null, metaVersion: 1, blobSha: 'ef'.repeat(32), bodyLoaded: false })
  const future: Note = { ...unloaded, id: newUlid(clock), title: 'From a newer app', body: 'newer body' }
  lib.applyRemoteNote(future, { version: 1, extra: { colour: 'teal', z_list: [1, 2] }, metaVersion: 2, blobSha: '56'.repeat(32), bodyLoaded: true })
  lib.recordSyncConflict({ itemId: tag.id, type: 'tag', lostName: 'lost name', device: 'Mac B', at: t })
  lib.setSyncValue('pull_cursor', 'c_000000000042')
  return { clock, lib, img, unloaded, future }
}

async function kept() {
  const { lib, clock, ...rest } = library()
  const crypto = fakeCrypto(MASTER)
  const vault = await Vault.create(lib, crypto, 1, CREDS)
  const idb = new IDBFactory()
  const store = new KeptStore({ indexedDB: idb })
  return { lib, clock, crypto, vault, idb, store, ...rest }
}

/** Every value in every object store of `name`, as stored. */
async function rawRecords(idb: IDBFactory, name = 'feathermark'): Promise<Array<{ store: string; key: IDBValidKey; value: unknown }>> {
  const db = await new Promise<IDBDatabase>((ok, fail) => {
    const r = idb.open(name)
    r.onsuccess = () => ok(r.result)
    r.onerror = () => fail(r.error)
  })
  const out: Array<{ store: string; key: IDBValidKey; value: unknown }> = []
  for (const store of db.objectStoreNames) {
    const tx = db.transaction(store)
    const s = tx.objectStore(store)
    const [keys, values] = await Promise.all([
      new Promise<IDBValidKey[]>((ok) => (s.getAllKeys().onsuccess = (e) => ok((e.target as IDBRequest<IDBValidKey[]>).result))),
      new Promise<unknown[]>((ok) => (s.getAll().onsuccess = (e) => ok((e.target as IDBRequest<unknown[]>).result))),
    ])
    keys.forEach((key, i) => out.push({ store, key, value: values[i] }))
  }
  db.close()
  return out
}

/** Writes `value` at `key` in `store`, as a damaged or tampered browser profile would. */
async function poke(idb: IDBFactory, store: string, key: IDBValidKey, change: (v: Record<string, unknown>) => Record<string, unknown> | undefined) {
  const db = await new Promise<IDBDatabase>((ok, fail) => {
    const r = idb.open('feathermark')
    r.onsuccess = () => ok(r.result)
    r.onerror = () => fail(r.error)
  })
  const tx = db.transaction(store, 'readwrite')
  const s = tx.objectStore(store)
  const value = await new Promise<Record<string, unknown>>((ok) => (s.get(key).onsuccess = (e) => ok((e.target as IDBRequest).result)))
  const next = change(value)
  if (next === undefined) s.delete(key)
  else s.keyPath === null ? s.put(next, key) : s.put(next)
  await new Promise((ok) => (tx.oncomplete = ok))
  db.close()
}

/** Every byte a value holds: strings as UTF-8, byte arrays as they are, the rest walked. */
function bytesOf(v: unknown, out: Uint8Array[] = []): Uint8Array[] {
  if (typeof v === 'string') out.push(utf8.encode(v))
  else if (v instanceof Uint8Array) out.push(v)
  else if (v instanceof ArrayBuffer) out.push(new Uint8Array(v))
  else if (Array.isArray(v)) v.forEach((x) => bytesOf(x, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (bytesOf(k, out), bytesOf(x, out))
  return out
}

function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

/** This tab, writing whatever is there (the tests of what a save writes); the owner rules have their own tests. */
const ME = { as: 'tab-a', force: true } as const

const names = async (idb: IDBFactory) => (await idb.databases()).map((d) => d.name)

describe('KeptStore', () => {
  test('saved vault holds no plaintext', async () => {
    const { vault, idb, store } = await kept()
    await store.save(vault, ME)
    expect(await names(idb)).toEqual(['feathermark'])
    const records = await rawRecords(idb)
    expect(records.length).toBeGreaterThan(vault.items.size)
    const all = records.flatMap((r) => [...bytesOf(r.key), ...bytesOf(r.value)])
    for (const secret of SECRETS) {
      expect(all.some((b) => contains(b, utf8.encode(secret))), secret).toBe(false)
    }
  })

  test('the kept vault comes back exactly: bodyLoaded, metaVersion and extra as they were', async () => {
    const { lib, clock, crypto, vault, idb, store, unloaded, future } = await kept()
    await store.save(vault, ME)
    const back = (await new KeptStore({ indexedDB: idb }).load())!
    expect(back).toBeInstanceOf(Vault)
    const sorted = (v: Vault) => ({ ...v, items: [...v.items.entries()].sort(([a], [b]) => (a < b ? -1 : 1)) })
    expect(sorted(back)).toEqual(sorted(vault))
    const opened = await back.open(crypto, 1, clock)
    const sync = (l: Library) => l.syncItems().sort((a, b) => (a.id < b.id ? -1 : 1))
    expect(sync(opened)).toEqual(sync(lib))
    expect(opened.syncItem(unloaded.id)).toMatchObject({ bodyLoaded: false, metaVersion: 1 })
    expect(opened.syncItem(future.id)).toMatchObject({ bodyLoaded: true, metaVersion: 2, extra: { colour: 'teal', z_list: [1, 2] } })
    expect(opened.dirtyItems().map((s) => s.id).sort()).toEqual(lib.dirtyItems().map((s) => s.id).sort())
  })

  test('saving again replaces the copy in one go: an item gone from the vault is gone from the store', async () => {
    const { lib, crypto, vault, store, unloaded } = await kept()
    await store.save(vault, ME)
    lib.deleteNotePermanently(unloaded.id)
    // an item the server had, deleted here: kept as a tombstone until pushed; then dropped
    lib.markPushed(unloaded.id, 6, null, lib.syncItem(unloaded.id)!.dirtySeq!)
    const next = await Vault.create(lib, crypto, 1, CREDS)
    await store.save(next, ME)
    const back = (await store.load())!
    expect([...back.items.keys()].sort()).toEqual([...next.items.keys()].sort())
    expect(back.items.has(unloaded.id)).toBe(false)
  })

  test('sealing again reuses the envelopes of items that did not change, and seals only what did', async () => {
    const { lib, crypto, vault, unloaded } = await kept()
    const sealed: string[] = []
    const counting = { ...crypto, seal: (s: number, list: Array<{ plain: Uint8Array; part: never; id: string }>) => (list.forEach((r) => sealed.push(r.id)), crypto.seal(s, list)) } as typeof crypto
    const secret = lib.notes({ kind: 'all' }).find((n) => n.title === 'Secret plan')!
    lib.updateNote(secret.id, { body: 'the treasure moved' })
    // a body that arrives changes the bookkeeping (bodyLoaded) and the blob
    lib.setRemoteBody(unloaded.id, 'its body at last', 'ef'.repeat(32))
    const next = await Vault.create(lib, counting, 1, CREDS, vault)
    // the two changed items, and the sync-conflicts list (always sealed again, it is one small record)
    expect(sealed.sort()).toEqual([LIBRARY, secret.id, secret.id, unloaded.id, unloaded.id].sort())
    for (const [id, it] of next.items) {
      if (id === secret.id || id === unloaded.id) expect(it.meta).not.toBe(vault.items.get(id)!.meta)
      else expect(it).toEqual(vault.items.get(id))
    }
    const opened = await next.open(crypto, 1)
    expect(opened.note(secret.id)!.body).toBe('the treasure moved')
    expect(opened.note(unloaded.id)!.body).toBe('its body at last')
    // another account's vault is never reused
    const other = await Vault.create(lib, counting, 1, { ...CREDS, libraryId: '01JC8ZN0AB1CD2EF3GH4JK5MN7' }, next)
    expect([...other.items.values()].every((it, i) => it.meta === null || it.meta !== [...next.items.values()][i]?.meta)).toBe(true)
  })

  test('saving again writes only the records that changed', async () => {
    const { lib, crypto, vault, idb, store } = await kept()
    await store.save(vault, ME)
    const secret = lib.notes({ kind: 'all' }).find((n) => n.title === 'Secret plan')!
    lib.updateNote(secret.id, { body: 'the treasure moved' })
    const next = await Vault.create(lib, crypto, 1, CREDS, vault)
    const writes: unknown[] = []
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      writes.push(this.name === 'items' ? (args[0] as { id: string }).id : this.name)
      return put.apply(this, args)
    }
    try {
      await store.save(next, ME)
    } finally {
      IDBObjectStore.prototype.put = put
    }
    expect(writes.sort()).toEqual([secret.id, 'vault'].sort())
    const back = (await new KeptStore({ indexedDB: idb }).load())!
    const sorted = (v: Vault) => ({ ...v, items: [...v.items.entries()].sort(([a], [b]) => (a < b ? -1 : 1)) })
    expect(sorted(back)).toEqual(sorted(next))
  })

  test('a copy another tab wrote since is replaced whole, not patched', async () => {
    const { lib, crypto, vault, idb, store } = await kept()
    await store.save(vault, ME)
    // another tab saves a different library over it
    const otherLib = new Library(fakeClock())
    otherLib.createNote({ title: 'Other tab', body: 'x' })
    const theirs = await Vault.create(otherLib, crypto, 1, CREDS)
    await new KeptStore({ indexedDB: idb }).save(theirs, ME)
    // this tab, unaware, saves its next version
    lib.createNote({ title: 'One more', body: 'y' })
    const next = await Vault.create(lib, crypto, 1, CREDS, vault)
    await store.save(next, ME)
    const back = (await new KeptStore({ indexedDB: idb }).load())!
    expect([...back.items.keys()].sort()).toEqual([...next.items.keys()].sort())
  })

  test('a damaged record is refused, not half-loaded', async () => {
    const { vault, idb, store, future } = await kept()
    await store.save(vault, ME)
    // one item's envelope replaced by something that isn't bytes
    await poke(idb, 'items', future.id, (v) => ({ ...v, meta: 'not bytes' }))
    await expect(store.load()).rejects.toBeInstanceOf(KeptVaultDamaged)

    // one item missing: the header's count no longer matches
    await store.save(vault, ME)
    await poke(idb, 'items', future.id, () => undefined)
    await expect(store.load()).rejects.toBeInstanceOf(KeptVaultDamaged)

    // bookkeeping that isn't what the vault writes
    await store.save(vault, ME)
    await poke(idb, 'items', future.id, (v) => ({ ...v, sync: { ...(v.sync as object), metaVersion: 'two' } }))
    await expect(store.load()).rejects.toBeInstanceOf(KeptVaultDamaged)

    // the header itself
    await store.save(vault, ME)
    await poke(idb, 'vault', 'vault', (v) => ({ ...v, salt: 'salt' }))
    await expect(store.load()).rejects.toBeInstanceOf(KeptVaultDamaged)

    // and a format this code doesn't know
    await store.save(vault, ME)
    await poke(idb, 'vault', 'vault', (v) => ({ ...v, format: 2 }))
    await expect(store.load()).rejects.toBeInstanceOf(KeptVaultDamaged)

    // saved whole again, it loads
    await store.save(vault, ME)
    expect((await store.load())!.items.size).toBe(vault.items.size)
  })

  test('only the owner writes: a save, claim or remove from another tab is refused and changes nothing', async () => {
    const { lib, crypto, vault, idb, store } = await kept()
    // tab A creates the copy (there was none)
    await store.save(vault, { as: 'tab-a', from: null })
    expect(store.owner).toBe('tab-a')
    // a second creation is refused: the copy exists and is A's
    const b = new KeptStore({ indexedDB: idb })
    await expect(b.save(vault, { as: 'tab-b', from: null })).rejects.toBeInstanceOf(NotKeptOwner)
    // B writes as itself: refused
    lib.createNote({ title: 'From B', body: 'b' })
    const fromB = await Vault.create(lib, crypto, 1, CREDS)
    await expect(b.save(fromB, { as: 'tab-b' })).rejects.toBeInstanceOf(NotKeptOwner)
    // B claims it from someone who isn't the owner: refused
    await expect(b.claim('tab-b', 'tab-c')).rejects.toBeInstanceOf(NotKeptOwner)
    // B can't remove it either
    await expect(b.remove('tab-b')).rejects.toBeInstanceOf(NotKeptOwner)
    const still = (await new KeptStore({ indexedDB: idb }).load())!
    expect([...still.items.keys()].sort()).toEqual([...vault.items.keys()].sort())

    // B claims it from A: the copy as it is, and B is the owner; A's writes are refused from then on
    const claimed = (await b.claim('tab-b', 'tab-a'))!
    expect([...claimed.items.keys()].sort()).toEqual([...vault.items.keys()].sort())
    expect(b.owner).toBe('tab-b')
    await expect(store.save(fromB, { as: 'tab-a' })).rejects.toBeInstanceOf(NotKeptOwner)
    await b.save(fromB, { as: 'tab-b' })
    // a second claim from A (two takers at once): the first won
    await expect(new KeptStore({ indexedDB: idb }).claim('tab-c', 'tab-a')).rejects.toBeInstanceOf(NotKeptOwner)
  })

  test('once removed, a late save from any tab creates nothing', async () => {
    const { vault, idb, store } = await kept()
    await store.save(vault, { as: 'tab-a', from: null })
    await store.remove('tab-a')
    expect(await names(idb)).toEqual([])
    await expect(store.save(vault, { as: 'tab-a' })).rejects.toBeInstanceOf(NotKeptOwner)
    await expect(new KeptStore({ indexedDB: idb }).save(vault, { as: 'tab-b', from: 'tab-a' })).rejects.toBeInstanceOf(NotKeptOwner)
    expect(await names(idb)).toEqual([])
    expect(await store.claim('tab-b', 'tab-a')).toBeNull()
    expect(await names(idb)).toEqual([])
  })

  test('nothing kept: load gives null and creates no database', async () => {
    const idb = new IDBFactory()
    expect(await new KeptStore({ indexedDB: idb }).load()).toBeNull()
    expect(await names(idb)).toEqual([])
  })

  test('remove deletes the database', async () => {
    const { vault, idb, store } = await kept()
    await store.save(vault, ME)
    await store.remove()
    expect(await names(idb)).toEqual([])
    expect(await store.load()).toBeNull()
    // and removing nothing is fine
    await store.remove()
    expect(await names(idb)).toEqual([])
  })
})
