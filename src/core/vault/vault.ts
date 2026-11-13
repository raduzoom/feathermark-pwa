// What a locked tab keeps (web design "Logged in": "A locked tab holds only encrypted copies"): every item as its
// envelope, unsynced edits included, its sync bookkeeping, the session token and the password-wrapped master key.
// It lives in memory; Task 10 keeps it in IndexedDB when "Keep my notes on this browser" is on.
//
// Each item is sealed as the server would hold it: metadata (with unknown fields, as `extra` round-trips through the
// metadata JSON) under part metadata, a note's body or an attachment's content under its own part, each with the
// item's key. The bookkeeping beside the envelopes holds ids, versions, flags and hashes, never a name or text.
// The sync-conflicts list (names that lost a rename) is sealed as one metadata envelope with the library id's key.
import type { KdfParams } from '../crypto/argon2.ts'
import { CryptoError } from '../crypto/errors.ts'
import type { Part } from '../crypto/envelope.ts'
import { systemClock, type Clock } from '../clock.ts'
import type { Attachment } from '../library/attachments.ts'
import { Library } from '../library/library.ts'
import type { SyncConflict, SyncItem } from '../library/sync-state.ts'
import type { Note, Notebook, Tag } from '../library/types.ts'
import { metaJson, readMeta, type ItemType } from '../sync/codec.ts'
import type { CryptoClient } from '../../worker/crypto-client.ts'

/** One item, sealed. `meta` is null for a deletion not yet pushed (nothing left to seal); `blob` is null for a
 *  notebook or tag, and for a body or content that hasn't arrived from the server. */
export type SealedItem = {
  id: string
  type: ItemType
  meta: Uint8Array | null
  blob: Uint8Array | null
  sync: Omit<SyncItem, 'extra'> & { extra: null }
}

/** What the vault keeps besides the items: who is signed in, where, and what unlocks without the server. */
export type VaultCredentials = {
  email: string
  serverOrigin: string
  token: string
  deviceId: string
  libraryId: string
  wrappedMasterPassword: Uint8Array
  /** The salt and Argon2id parameters the password-wrapped key was made with, so unlocking needs no request. */
  salt: Uint8Array
  kdf: KdfParams
}

const BLOB_PART: Partial<Record<ItemType, Part>> = { note: 'noteBody', attachment: 'attachment' }
const utf8 = new TextEncoder()

export class Vault {
  email: string
  serverOrigin: string
  token: string
  deviceId: string
  libraryId: string
  wrappedMasterPassword: Uint8Array
  salt: Uint8Array
  kdf: KdfParams
  cursor: string | null
  items: Map<string, SealedItem>
  /** The sync-conflicts list as JSON, sealed as part metadata with itemKey(master, libraryId). */
  conflicts: Uint8Array

  constructor(o: VaultCredentials & { cursor: string | null; items: Map<string, SealedItem>; conflicts: Uint8Array }) {
    this.email = o.email
    this.serverOrigin = o.serverOrigin
    this.token = o.token
    this.deviceId = o.deviceId
    this.libraryId = o.libraryId
    this.wrappedMasterPassword = o.wrappedMasterPassword
    this.salt = o.salt
    this.kdf = o.kdf
    this.cursor = o.cursor
    this.items = o.items
    this.conflicts = o.conflicts
  }

  /** Seals every item, dirty ones included, in one call to the worker. Sample items never go in. */
  static async seal(library: Library, crypto: CryptoClient, session: number): Promise<Map<string, SealedItem>> {
    return (await sealAll(library, crypto, session, null)).items
  }

  /** The vault for `library`: its items, its sync-conflicts list and its cursor, sealed. With `previous` (an earlier
   *  vault of the same library), an item keeps its envelopes when its bookkeeping is unchanged and its metadata is the
   *  plaintext that envelope was sealed from (the library's `sealCache`): a body changes only with the bookkeeping
   *  (dirtySeq, serverVersion, bodyLoaded), but metadata also changes without it, when a tag or notebook a note names
   *  is deleted here or on another device. Only what changed is sealed again. */
  static async create(library: Library, crypto: CryptoClient, session: number, creds: VaultCredentials, previous: Vault | null = null): Promise<Vault> {
    const reuse = previous && previous.libraryId === creds.libraryId ? previous.items : null
    const { items, conflicts, cursor } = await sealAll(library, crypto, session, creds.libraryId, reuse)
    return new Vault({ ...creds, cursor, items, conflicts: conflicts! })
  }

  /** The library again, from memory: no request. Any envelope that fails to open fails the whole open (CryptoError),
   *  so a damaged vault is never half-loaded. */
  async open(crypto: CryptoClient, session: number, clock: Clock = systemClock): Promise<Library> {
    const list = [...this.items.values()]
    const requests: Array<{ envelope: Uint8Array; part: Part; id: string }> = [{ envelope: this.conflicts, part: 'metadata', id: this.libraryId }]
    const where: Array<{ meta: number | null; blob: number | null }> = []
    for (const it of list) {
      const meta = it.meta ? requests.push({ envelope: it.meta, part: 'metadata', id: it.id }) - 1 : null
      const part = BLOB_PART[it.type]
      const blob = it.blob && part ? requests.push({ envelope: it.blob, part, id: it.id }) - 1 : null
      where.push({ meta, blob })
    }
    const opened = await crypto.open(session, requests)
    const plain = (i: number): Uint8Array => {
      const r = opened[i]
      if (r instanceof Uint8Array) return r
      throw new CryptoError(r && 'error' in r ? r.error : 'malformed')
    }
    const conflicts = JSON.parse(new TextDecoder().decode(plain(0))) as SyncConflict[]
    const notes: Note[] = []
    const notebooks: Notebook[] = []
    const tags: Tag[] = []
    const attachments: Attachment[] = []
    const sync: SyncItem[] = []
    list.forEach((it, i) => {
      const w = where[i]!
      let extra: SyncItem['extra'] = null
      if (w.meta !== null) {
        const m = readMeta(it.type, it.id, plain(w.meta), { limit: false })
        extra = m.extra
        const blob = w.blob === null ? null : plain(w.blob)
        switch (m.type) {
          case 'note':
            notes.push({ ...m.note, body: blob ? new TextDecoder().decode(blob) : '' })
            break
          case 'notebook':
            notebooks.push(m.notebook)
            break
          case 'tag':
            tags.push(m.tag)
            break
          case 'attachment':
            attachments.push({ ...m.attachment, origin: 'user', bytes: blob ?? new Uint8Array(0) })
            break
        }
      }
      // the metadata JSON always says v 1; the item's own version (read-only above 1) is in the bookkeeping
      sync.push({ ...it.sync, extra })
    })
    const library = new Library(clock)
    library.restore({ notes, notebooks, tags, attachments, sync, conflicts, cursor: this.cursor })
    // what each envelope holds, for the next incremental seal; an item restore changed (a dangling reference
    // dropped) differs from it, so it is sealed again
    list.forEach((it, i) => {
      const w = where[i]!
      if (it.meta && w.meta !== null) library.sealCache.set(it.id, { plain: plain(w.meta), envelope: it.meta })
    })
    return library
  }
}

/** Takes the snapshot (items, bookkeeping, conflicts and the cursor) in one synchronous step, then seals it: whatever
 *  lands in the library during the seal's await is in none of them, so the cursor never runs ahead of the items. */
/** Whether two bookkeeping records describe the same version of an item (`extra` aside: it changes only with a
 *  remote version, which changes serverVersion). */
export function sameVersion(a: Omit<SyncItem, 'extra'>, b: Omit<SyncItem, 'extra'>): boolean {
  return (
    a.id === b.id && a.type === b.type && a.serverVersion === b.serverVersion && a.dirtySeq === b.dirtySeq && a.bodyDirty === b.bodyDirty &&
    a.deleted === b.deleted && a.blobSha === b.blobSha && a.metaVersion === b.metaVersion && a.bodyLoaded === b.bodyLoaded
  )
}

async function sealAll(library: Library, crypto: CryptoClient, session: number, libraryId: string | null, reuse: Map<string, SealedItem> | null = null) {
  const cursor = library.syncValue('pull_cursor')
  type Entity = { item: Note | Notebook | Tag | Omit<Attachment, 'bytes' | 'origin'>; blob: Uint8Array | null }
  const entities = new Map<string, Entity>()
  const notes = [...library.notes({ kind: 'all' }), ...library.notes({ kind: 'trash' })]
  for (const s of notes) {
    if (s.origin === 'sample') continue
    const n = library.note(s.id)!
    entities.set(n.id, { item: n, blob: utf8.encode(n.body) })
  }
  for (const nb of library.notebooks()) if (nb.origin !== 'sample') entities.set(nb.id, { item: nb, blob: null })
  for (const t of library.tags()) if (t.origin !== 'sample') entities.set(t.id, { item: t, blob: null })
  for (const a of library.attachments()) {
    if (a.origin === 'sample') continue
    const { bytes, origin: _origin, ...meta } = a
    entities.set(a.id, { item: meta, blob: bytes })
  }

  const records = new Map(library.syncItems().map((s) => [s.id, s]))
  // every user item has a record; one without would be a change the server hasn't seen, so it is kept as one
  let seq = library.localChangeSeq
  const typeOf = (id: string): ItemType => (library.note(id) ? 'note' : library.attachment(id) ? 'attachment' : library.tags().some((t) => t.id === id) ? 'tag' : 'notebook')
  for (const id of entities.keys()) {
    if (!records.has(id)) {
      const type = typeOf(id)
      records.set(id, { id, type, serverVersion: 0, dirtySeq: ++seq, bodyDirty: type === 'note' || type === 'attachment', deleted: false, blobSha: null, extra: null, metaVersion: 1, bodyLoaded: true })
    }
  }

  const requests: Array<{ plain: Uint8Array; part: Part; id: string }> = []
  const where = new Map<string, { meta: number | null; blob: number | null; plain: Uint8Array | null }>()
  const kept = new Map<string, SealedItem>()
  const cache = library.sealCache
  for (const r of records.values()) {
    const e = entities.get(r.id)
    // a record without its item is a deletion not yet pushed; anything else gone has nothing to keep
    if (!e && !r.deleted) continue
    const plain = e ? metaJson(e.item as Note, r.type, r.extra, { limit: false }) : null
    const before = reuse?.get(r.id)
    const sealedFrom = before?.meta ? cache.get(r.id) : undefined
    const sameMeta = plain === null ? before?.meta === null : sealedFrom !== undefined && sealedFrom.envelope === before!.meta && equalBytes(sealedFrom.plain, plain)
    if (before && sameVersion(before.sync, r) && sameMeta) {
      kept.set(r.id, { ...before, sync: { ...r, extra: null } })
      continue
    }
    const meta = plain ? requests.push({ plain, part: 'metadata', id: r.id }) - 1 : null
    const part = BLOB_PART[r.type]
    const blob = e && e.blob && part && r.bodyLoaded ? requests.push({ plain: e.blob, part, id: r.id }) - 1 : null
    where.set(r.id, { meta, blob, plain })
  }
  const conflictsAt = libraryId === null ? null : requests.push({ plain: utf8.encode(JSON.stringify(library.syncConflicts())), part: 'metadata', id: libraryId }) - 1
  const sealed = requests.length ? await crypto.seal(session, requests) : []
  const items = new Map<string, SealedItem>(kept)
  for (const [id, w] of where) {
    const r = records.get(id)!
    const meta = w.meta === null ? null : sealed[w.meta]!
    items.set(id, { id, type: r.type, meta, blob: w.blob === null ? null : sealed[w.blob]!, sync: { ...r, extra: null } })
    if (meta && w.plain) cache.set(id, { plain: w.plain, envelope: meta })
    else cache.delete(id)
  }
  for (const id of cache.keys()) if (!items.has(id)) cache.delete(id)
  return { items, conflicts: conflictsAt === null ? null : sealed[conflictsAt]!, cursor }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
