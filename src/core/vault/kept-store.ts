// "Keep my notes on this browser" (web design "Logged in"): the vault, kept in the one IndexedDB database the app may
// write, "feathermark". It holds what the vault holds and nothing else: envelopes, the session token, the
// password-wrapped master key with its salt and Argon2id parameters, the email, the server cursor and the per-item
// sync bookkeeping (ids, versions, flags, hashes). No title, body, name or file name is ever written unencrypted.
//
// Layout (format 1): object store "vault" holds one record at key "vault" (the credentials, the cursor, the sealed
// sync-conflicts list and the item count); object store "items" holds one record per item, keyed by its id, exactly
// as the vault's SealedItem. A save replaces both in one transaction, so a reader sees the old copy or the new one.
// A load checks every record before building the vault: a damaged or missing record refuses the whole copy.
//
// Every write names the tab writing it and is refused (NotKeptOwner) unless the copy's `owner` is that tab, checked
// in the write's own transaction: a tab that lost the copy, however late it wakes, can neither overwrite the new
// owner's copy nor bring a removed one back. A tab becomes the owner by `claim` (after a handover) or by creating the
// copy (`from: null`).
//
// Saves are incremental: the store remembers what it last wrote or read (and the header's `stamp` from then). When
// the header still carries that stamp, no other tab has written since, and only the records whose envelopes or
// bookkeeping changed are put, and the ones gone deleted. Otherwise the copy is replaced whole.
import type { KdfParams } from '../crypto/argon2.ts'
import type { ItemType } from '../sync/codec.ts'
import { sameVersion, Vault, type SealedItem } from './vault.ts'

export const KEPT_DATABASE = 'feathermark'
const VERSION = 1
const FORMAT = 1
const HEADER = 'vault'
const ITEMS = 'items'
const TYPES: readonly ItemType[] = ['note', 'notebook', 'tag', 'attachment']

/** The kept copy is there but isn't what this code writes: refused whole, never half-loaded. */
export class KeptVaultDamaged extends Error {
  constructor(detail: string) {
    super(`the kept copy is damaged: ${detail}`)
    this.name = 'KeptVaultDamaged'
  }
}

type Header = {
  format: number
  email: string
  serverOrigin: string
  token: string
  deviceId: string
  libraryId: string
  wrappedMasterPassword: Uint8Array
  salt: Uint8Array
  kdf: KdfParams
  cursor: string | null
  conflicts: Uint8Array
  count: number
  /** Changes with every save: tells a store whether another writer came between. */
  stamp?: string
  /** The id of the tab that may write the copy (compare-and-set: every write checks it in its own transaction). */
  owner?: string
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((ok, fail) => {
    tx.oncomplete = () => ok()
    tx.onabort = () => fail(tx.error ?? new Error('transaction aborted'))
    tx.onerror = () => undefined
  })

const result = <T>(r: IDBRequest<T>) =>
  new Promise<T>((ok, fail) => {
    r.onsuccess = () => ok(r.result)
    r.onerror = () => fail(r.error)
  })

/** A write refused: the kept copy belongs to another tab (or to none: it is gone). Nothing was written. */
export class NotKeptOwner extends Error {
  constructor() {
    super('another tab owns the kept copy')
    this.name = 'NotKeptOwner'
  }
}

/** Who may write: `as` this tab's id. `from`, when given, is the owner the write expects to replace (null: no copy
 *  yet, so the database may be created); otherwise the copy must already be this tab's. `force` (a damaged copy,
 *  which says no owner) skips the check. */
export type WriteAs = { as: string; from?: string | null; force?: boolean }

export class KeptStore {
  private readonly idb: IDBFactory
  private readonly name: string
  /** What the database holds, as this store last wrote or read it, and the stamp it carried; null when unknown. */
  private known: { items: Map<string, SealedItem>; stamp: string } | null = null
  /** The owner the copy named when this store last read or wrote it (null: none, or no copy). */
  owner: string | null = null

  constructor(o: { indexedDB?: IDBFactory; name?: string } = {}) {
    this.idb = o.indexedDB ?? globalThis.indexedDB
    this.name = o.name ?? KEPT_DATABASE
  }

  /** Opens the database. `create` false: when there is none, gives null and leaves none behind. */
  private open(create: boolean): Promise<IDBDatabase | null> {
    return new Promise((ok, fail) => {
      const r = this.idb.open(this.name, VERSION)
      let absent = false
      r.onupgradeneeded = (e) => {
        if (!create && e.oldVersion === 0) {
          // there was no database: aborting the upgrade deletes the one this open just made
          absent = true
          r.transaction!.abort()
          return
        }
        const db = r.result
        if (!db.objectStoreNames.contains(HEADER)) db.createObjectStore(HEADER)
        if (!db.objectStoreNames.contains(ITEMS)) db.createObjectStore(ITEMS, { keyPath: 'id' })
      }
      r.onsuccess = () => {
        const db = r.result
        // another tab removing the copy must not wait for this connection
        db.onversionchange = () => db.close()
        ok(db)
      }
      r.onerror = (e) => {
        if (absent) {
          e.preventDefault()
          ok(null)
        } else fail(r.error)
      }
      r.onblocked = () => undefined
    })
  }

  /** Builds the vault from a header and its records, checking each: a damaged copy is refused whole. */
  private build(header: unknown, records: unknown[]): { vault: Vault; header: Header } {
    const h = checkHeader(header)
    if (records.length !== h.count) throw new KeptVaultDamaged(`expected ${h.count} items, found ${records.length}`)
    const items = new Map<string, SealedItem>()
    for (const r of records) {
      const it = checkItem(r)
      items.set(it.id, it)
    }
    const vault = new Vault({
      email: h.email, serverOrigin: h.serverOrigin, token: h.token, deviceId: h.deviceId, libraryId: h.libraryId,
      wrappedMasterPassword: h.wrappedMasterPassword, salt: h.salt, kdf: { alg: h.kdf.alg, t: h.kdf.t, m_kib: h.kdf.m_kib, p: h.kdf.p },
      cursor: h.cursor, items, conflicts: h.conflicts,
    })
    return { vault, header: h }
  }

  /** The kept vault, or null when nothing is kept; `owner` says whose it is. Throws KeptVaultDamaged when any record
   *  isn't what save wrote. Writes nothing. */
  async load(): Promise<Vault | null> {
    // set again below once the copy has checked out: after a refused load the next save rewrites it whole
    this.known = null
    this.owner = null
    const db = await this.open(false)
    if (!db) return null
    try {
      if (!db.objectStoreNames.contains(HEADER) || !db.objectStoreNames.contains(ITEMS)) throw new KeptVaultDamaged('stores missing')
      const tx = db.transaction([HEADER, ITEMS], 'readonly')
      const [header, records] = await Promise.all([result(tx.objectStore(HEADER).get(HEADER)), result(tx.objectStore(ITEMS).getAll())])
      await done(tx)
      if (header === undefined && records.length === 0) return null
      const { vault, header: h } = this.build(header, records)
      this.owner = h.owner ?? null
      this.known = h.stamp ? { items: new Map(vault.items), stamp: h.stamp } : null
      return vault
    } finally {
      db.close()
    }
  }

  /** Makes this tab the copy's owner, if its owner is still `from`, and gives the copy as it is at that moment: the
   *  check, the read and the change of owner are one transaction. Null when nothing is kept. Throws NotKeptOwner when
   *  another tab became the owner first, KeptVaultDamaged when the copy is damaged (nothing changes then). */
  async claim(as: string, from: string | null): Promise<Vault | null> {
    this.known = null
    const db = await this.open(false)
    if (!db) return null
    try {
      if (!db.objectStoreNames.contains(HEADER) || !db.objectStoreNames.contains(ITEMS)) throw new KeptVaultDamaged('stores missing')
      const stamp = newStamp()
      const tx = db.transaction([HEADER, ITEMS], 'readwrite')
      const headers = tx.objectStore(HEADER)
      let out: { vault: Vault; header: Header } | null = null
      let refusal: Error | null = null
      const [header, records] = await Promise.all([result(headers.get(HEADER)), result(tx.objectStore(ITEMS).getAll())])
      try {
        if (header === undefined && records.length === 0) {
          tx.abort()
        } else {
          out = this.build(header, records)
          if ((out.header.owner ?? null) !== from) throw new NotKeptOwner()
          headers.put({ ...out.header, owner: as, stamp }, HEADER)
        }
      } catch (e) {
        refusal = e as Error
        tx.abort()
      }
      await done(tx).catch((e: unknown) => {
        if (!refusal && out) throw e
      })
      if (refusal) throw refusal
      if (!out) return null
      this.owner = as
      this.known = { items: new Map(out.vault.items), stamp }
      return out.vault
    } finally {
      db.close()
    }
  }

  /** Replaces the kept copy with `v`, in one transaction, if this tab may write it (WriteAs); only what changed, when
   *  nothing else wrote since. Throws NotKeptOwner, writing nothing and never creating the database, otherwise. */
  async save(v: Vault, w: WriteAs): Promise<void> {
    const known = this.known
    this.known = null
    const stamp = newStamp()
    const create = w.force === true || w.from === null
    const db = await this.open(create)
    if (!db) throw new NotKeptOwner()
    try {
      const tx = db.transaction([HEADER, ITEMS], 'readwrite')
      const items = tx.objectStore(ITEMS)
      const headers = tx.objectStore(HEADER)
      const record = (it: SealedItem): SealedItem => ({ id: it.id, type: it.type, meta: it.meta, blob: it.blob, sync: { ...it.sync, extra: null } })
      const header: Header = {
        format: FORMAT, email: v.email, serverOrigin: v.serverOrigin, token: v.token, deviceId: v.deviceId, libraryId: v.libraryId,
        wrappedMasterPassword: v.wrappedMasterPassword, salt: v.salt, kdf: { ...v.kdf }, cursor: v.cursor, conflicts: v.conflicts,
        count: v.items.size, stamp, owner: w.as,
      }
      let refused = false
      const read = headers.get(HEADER)
      read.onsuccess = () => {
        const current = read.result as { stamp?: unknown; owner?: unknown } | undefined
        const owner = current === undefined ? null : typeof current.owner === 'string' ? current.owner : null
        const expected = w.from === undefined ? w.as : w.from
        if (!w.force && owner !== expected) {
          refused = true
          tx.abort()
          return
        }
        if (known && current?.stamp === known.stamp) {
          for (const it of v.items.values()) {
            const was = known.items.get(it.id)
            if (!was || was.meta !== it.meta || was.blob !== it.blob || was.type !== it.type || !sameVersion(was.sync, it.sync)) items.put(record(it))
          }
          for (const id of known.items.keys()) if (!v.items.has(id)) items.delete(id)
        } else {
          items.clear()
          for (const it of v.items.values()) items.put(record(it))
        }
        headers.put(header, HEADER)
      }
      try {
        await done(tx)
      } catch (e) {
        if (refused) throw new NotKeptOwner()
        throw e
      }
      this.owner = w.as
      this.known = { items: new Map(v.items), stamp }
    } finally {
      db.close()
    }
  }

  /** Deletes the copy if it is `as`'s (or whatever it holds, without `as`): its records go in one checked
   *  transaction, then the database. Nothing kept is fine. Throws NotKeptOwner when another tab owns it. */
  async remove(as?: string): Promise<void> {
    this.known = null
    const db = await this.open(false)
    if (db) {
      try {
        if (as !== undefined && db.objectStoreNames.contains(HEADER) && db.objectStoreNames.contains(ITEMS)) {
          const tx = db.transaction([HEADER, ITEMS], 'readwrite')
          let refused = false
          const headers = tx.objectStore(HEADER)
          const read = headers.get(HEADER)
          read.onsuccess = () => {
            const current = read.result as { owner?: unknown } | undefined
            // this tab's copy, or one that names no owner (written before owners): removed; another tab's: refused
            if (current !== undefined && typeof current.owner === 'string' && current.owner !== as) {
              refused = true
              tx.abort()
              return
            }
            headers.clear()
            tx.objectStore(ITEMS).clear()
          }
          try {
            await done(tx)
          } catch (e) {
            if (refused) throw new NotKeptOwner()
            throw e
          }
        }
      } finally {
        db.close()
      }
    }
    this.owner = null
    await new Promise<void>((ok, fail) => {
      const r = this.idb.deleteDatabase(this.name)
      r.onsuccess = () => ok()
      r.onerror = () => fail(r.error)
      // open connections in other tabs close on versionchange; the delete then goes through
      r.onblocked = () => undefined
    })
  }
}

const newStamp = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isBytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)

function checkHeader(v: unknown): Header {
  const bad = (what: string): never => {
    throw new KeptVaultDamaged(`header: ${what}`)
  }
  if (!isObject(v)) return bad('missing')
  if (v.format !== FORMAT) bad('format')
  for (const k of ['email', 'serverOrigin', 'token', 'deviceId', 'libraryId'] as const) if (typeof v[k] !== 'string') bad(k)
  for (const k of ['wrappedMasterPassword', 'salt', 'conflicts'] as const) if (!isBytes(v[k])) bad(k)
  const kdf = v.kdf
  if (!isObject(kdf) || typeof kdf.alg !== 'string' || !isInt(kdf.t) || !isInt(kdf.m_kib) || !isInt(kdf.p)) bad('kdf')
  if (v.cursor !== null && typeof v.cursor !== 'string') bad('cursor')
  if (!isInt(v.count) || v.count < 0) bad('count')
  if (v.stamp !== undefined && typeof v.stamp !== 'string') bad('stamp')
  if (v.owner !== undefined && typeof v.owner !== 'string') bad('owner')
  return v as unknown as Header
}

function checkItem(v: unknown): SealedItem {
  const id = isObject(v) && typeof v.id === 'string' ? v.id : '?'
  const bad = (what: string): never => {
    throw new KeptVaultDamaged(`item ${id}: ${what}`)
  }
  if (!isObject(v)) return bad('missing')
  if (!TYPES.includes(v.type as ItemType)) bad('type')
  if (v.meta !== null && !isBytes(v.meta)) bad('meta')
  if (v.blob !== null && !isBytes(v.blob)) bad('blob')
  const s = v.sync
  if (!isObject(s)) return bad('sync')
  if (s.id !== v.id || s.type !== v.type) bad('sync id')
  if (!isInt(s.serverVersion) || (s.dirtySeq !== null && !isInt(s.dirtySeq)) || !isInt(s.metaVersion)) bad('sync numbers')
  if (typeof s.bodyDirty !== 'boolean' || typeof s.deleted !== 'boolean' || typeof s.bodyLoaded !== 'boolean') bad('sync flags')
  if (s.blobSha !== null && typeof s.blobSha !== 'string') bad('sync blobSha')
  if (s.extra !== null) bad('sync extra')
  // only a deletion not yet pushed has no metadata
  if (v.meta === null && !s.deleted) bad('meta missing')
  return {
    id: v.id as string, type: v.type as ItemType, meta: v.meta as Uint8Array | null, blob: v.blob as Uint8Array | null,
    sync: {
      id: s.id as string, type: s.type as ItemType, serverVersion: s.serverVersion as number, dirtySeq: s.dirtySeq as number | null,
      bodyDirty: s.bodyDirty as boolean, deleted: s.deleted as boolean, blobSha: s.blobSha as string | null, extra: null,
      metaVersion: s.metaVersion as number, bodyLoaded: s.bodyLoaded as boolean,
    },
  }
}
