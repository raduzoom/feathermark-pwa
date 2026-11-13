// Feather Cloud sync bookkeeping for the in-memory library (sync-protocol.md "Client sync algorithm"; Swift:
// Library+Sync.swift). The Mac keeps a change log and collects it into sync_items; the web marks an item dirty inside
// the mutation itself, so `changeSeq` plays the change log's seq. Remote writes never mark anything dirty.
import type { Extra, ItemType } from '../sync/codec.ts'

export type SyncItem = {
  id: string
  type: ItemType
  /** The server version last seen; 0 for an item the server has never seen. */
  serverVersion: number
  /** The `changeSeq` of the latest local change not yet pushed; null when clean. */
  dirtySeq: number | null
  /** The body (notes) or content (attachments) changed and needs a new blob. */
  bodyDirty: boolean
  /** Deleted here for good: push a tombstone. */
  deleted: boolean
  /** SHA-256 of the encrypted blob last uploaded or downloaded. */
  blobSha: string | null
  /** Metadata fields this client doesn't know, written back unchanged. */
  extra: Extra
  /** The metadata `v`; above 1 the item is read-only here. */
  metaVersion: number
  /** False while a note's body (an attachment's content) hasn't arrived from the server. */
  bodyLoaded: boolean
}

/** A notebook or tag rename that lost to the server's (Settings › Sync conflicts). */
export type SyncConflict = { id: number; itemId: string; type: ItemType; lostName: string; device: string; at: number }

export type SyncKey = 'pull_cursor'

/** What a remote apply records. `ifDirtySeq` is the dirty state the engine saw (null or left out = clean). */
export type RemoteApply = { version: number; extra: Extra; metaVersion: number; ifDirtySeq?: number | null }
export type RemoteNoteApply = RemoteApply & { blobSha: string | null; bodyLoaded: boolean }
export type RemoteAttachmentApply = RemoteApply & { blobSha: string | null }

export class SyncState {
  /** Bumped by every local change; the dirty items' order. */
  changeSeq = 0
  private items = new Map<string, SyncItem>()
  private values = new Map<SyncKey, string>()
  private conflicts: SyncConflict[] = []
  private conflictSeq = 0

  /** A local change to `id`: dirty with a new seq; `body` stays set until pushed. */
  localChange(id: string, type: ItemType, o: { body?: boolean; deleted?: boolean } = {}): void {
    const it = this.items.get(id) ?? fresh(id, type)
    it.dirtySeq = ++this.changeSeq
    it.bodyDirty ||= o.body ?? false
    it.deleted = o.deleted ?? false
    // the body here is now what this device wrote
    if (o.body) it.bodyLoaded = true
    this.items.set(id, it)
  }

  item(id: string): SyncItem | null {
    const it = this.items.get(id)
    return it ? { ...it } : null
  }

  /** Every record, clean and dirty, tombstones included (the vault seals them all). */
  all(): SyncItem[] {
    return [...this.items.values()].map((s) => ({ ...s }))
  }

  /** Puts back what `all()`, `conflictList()` and `value()` gave (opening the vault). The next local change gets a seq
   *  after every restored one. */
  restore(items: SyncItem[], conflicts: SyncConflict[], values: Partial<Record<SyncKey, string>>): void {
    this.items = new Map(items.map((s) => [s.id, { ...s }]))
    this.conflicts = conflicts.map((c) => ({ ...c }))
    this.values = new Map(Object.entries(values) as Array<[SyncKey, string]>)
    this.changeSeq = Math.max(this.changeSeq, ...items.map((s) => s.dirtySeq ?? 0))
    this.conflictSeq = Math.max(this.conflictSeq, ...conflicts.map((c) => c.id))
  }

  dirty(): SyncItem[] {
    return [...this.items.values()].filter((s) => s.dirtySeq !== null).sort((a, b) => a.dirtySeq! - b.dirtySeq!).map((s) => ({ ...s }))
  }

  /** Whether the item is still in the dirty state the engine saw (Library+Sync.swift unchangedHere). */
  unchangedHere(id: string, expecting: number | null | undefined): boolean {
    return (this.items.get(id)?.dirtySeq ?? null) === (expecting ?? null)
  }

  /** Records an item stored from the server: clean, at `version`. */
  remember(id: string, type: ItemType, o: RemoteApply & { blobSha: string | null; bodyLoaded: boolean }): void {
    const old = this.items.get(id)
    this.items.set(id, {
      id,
      type,
      serverVersion: o.version,
      dirtySeq: null,
      bodyDirty: false,
      deleted: false,
      blobSha: o.blobSha ?? old?.blobSha ?? null,
      extra: o.extra,
      metaVersion: o.metaVersion,
      bodyLoaded: o.bodyLoaded,
    })
  }

  forget(id: string): void {
    this.items.delete(id)
  }

  /** A body download lands only where it is still the body awaited: the note's current blob, not loaded yet, and
   *  its body not changed here. A metadata-only change (a pin, a move) doesn't stop it: no local text is lost, and
   *  the item stays dirty for its metadata push. */
  bodyArrived(id: string, blobSha: string): boolean {
    const it = this.items.get(id)
    if (!it || it.bodyDirty || it.deleted || it.bodyLoaded || it.blobSha !== blobSha) return false
    it.bodyLoaded = true
    return true
  }

  markPushed(id: string, version: number, blobSha: string | null, ifDirtySeq: number): void {
    const it = this.items.get(id)
    if (!it) return
    it.serverVersion = version
    it.blobSha = blobSha ?? it.blobSha
    if (it.dirtySeq === ifDirtySeq) {
      it.dirtySeq = null
      it.bodyDirty = false
    }
    // a pushed tombstone is done: forget the item
    if (it.deleted && it.dirtySeq === null) this.items.delete(id)
  }

  rebase(id: string, version: number): void {
    const it = this.items.get(id)
    if (!it) return
    it.serverVersion = version
    it.deleted = false
    // the server may have dropped the blob with the tombstone: upload the body again
    it.bodyDirty = true
  }

  markBodyDirty(id: string): void {
    const it = this.items.get(id)
    if (!it) return
    it.bodyDirty = true
    it.dirtySeq ??= ++this.changeSeq
  }

  value(key: SyncKey): string | null {
    return this.values.get(key) ?? null
  }

  setValue(key: SyncKey, value: string | null): void {
    if (value === null) this.values.delete(key)
    else this.values.set(key, value)
  }

  /** Forgets everything; then each of `dirty` is new to the server, all at the same seq (Library+Sync.swift resetSync).
   *  A body or content that hasn't arrived stays not loaded and is never marked for upload: its placeholder isn't the
   *  text. The engine skips such an item's push (no blob to name) and the pull resolves it against the server's copy. */
  reset(dirty: Array<{ id: string; type: ItemType; body: boolean }>): void {
    const loaded = new Map([...this.items.values()].map((it) => [it.id, it.bodyLoaded]))
    this.items.clear()
    this.values.clear()
    this.conflicts = []
    if (dirty.length === 0) return
    const seq = ++this.changeSeq
    for (const d of dirty) {
      const bodyLoaded = loaded.get(d.id) ?? true
      this.items.set(d.id, { ...fresh(d.id, d.type), dirtySeq: seq, bodyDirty: d.body && bodyLoaded, bodyLoaded })
    }
  }

  recordConflict(c: Omit<SyncConflict, 'id'>): void {
    this.conflicts.push({ id: ++this.conflictSeq, ...c })
  }

  conflictList(): SyncConflict[] {
    return [...this.conflicts].sort((a, b) => b.at - a.at || b.id - a.id).map((c) => ({ ...c }))
  }
}

function fresh(id: string, type: ItemType): SyncItem {
  return { id, type, serverVersion: 0, dirtySeq: null, bodyDirty: false, deleted: false, blobSha: null, extra: null, metaVersion: 1, bodyLoaded: true }
}
