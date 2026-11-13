// The in-memory library: the web counterpart of FeatherCore. Rules: data-model.md "Views and sort orders", "Trash".
import type { Clock } from '../clock.ts'
import type { Attachment } from './attachments.ts'
import { attachmentRefs } from './links.ts'
import { newUlid } from '../ulid.ts'
import { nameOrder, preview, tagKey } from './names.ts'
import { buildQuery, SearchIndex } from './search.ts'
import { SyncState, type RemoteApply, type RemoteAttachmentApply, type RemoteNoteApply, type SyncConflict, type SyncItem, type SyncKey } from './sync-state.ts'
import type { AttachmentMeta, ItemType } from '../sync/codec.ts'
import { LibraryError, type Counts, type Note, type Notebook, type NoteSummary, type Origin, type SearchHit, type Tag, type View } from './types.ts'

const DAY = 86_400_000

/** What a change touched: `body`, only that note's body (a download landed); `any`, anything at all. */
export type LibraryChange = { kind: 'any' } | { kind: 'body'; id: string }
const ANY_CHANGE: LibraryChange = { kind: 'any' }
export type RemoteWatch = { beforeWrite?(id: string): void; wantsBody?(id: string): boolean }
const RECENT_DAYS = 7
const RECENT_LIMIT = 50

/** Everything a library holds, as the vault gives it back (`Library.restore`). */
export type LibrarySnapshot = {
  notes: Note[]
  notebooks: Notebook[]
  tags: Tag[]
  attachments: Attachment[]
  sync: SyncItem[]
  conflicts: SyncConflict[]
  cursor: string | null
}

type NoteInput = {
  title?: string
  body?: string
  notebookId?: string | null
  tagIds?: string[]
  created?: number
  modified?: number
  origin?: Origin
}

export class Library {
  private notesById = new Map<string, Note>()
  private notebooksById = new Map<string, Notebook>()
  private tagsById = new Map<string, Tag>()
  private attachmentsById = new Map<string, Attachment>()
  private listeners = new Set<(change: LibraryChange) => void>()
  private index = new SearchIndex()
  private sync = new SyncState()
  private remoteWatch: RemoteWatch = {}
  version = 0
  /** The vault's seal cache (vault.ts): per item, the metadata plaintext last sealed and the envelope it gave. It
   *  lives here, not in the vault, so it goes with the library at lock (a locked tab keeps no plaintext). */
  readonly sealCache = new Map<string, { plain: Uint8Array; envelope: Uint8Array }>()

  /** The screen's say in remote writes (one watcher, the app model): `beforeWrite` runs before a remote write to a
   *  note (so typing not saved yet becomes a local change first, and the conflict rules keep both texts);
   *  `wantsBody` says which note's body the pull should download at once (the open note, never shown as loading). */
  watchRemote(w: RemoteWatch): () => void {
    this.remoteWatch = w
    return () => {
      if (this.remoteWatch === w) this.remoteWatch = {}
    }
  }

  wantsBody(id: string): boolean {
    return this.remoteWatch.wantsBody?.(id) ?? false
  }

  /** A local change: the item becomes dirty, unless it is one of the demo's samples (never synced). */
  private local(type: ItemType, item: { id: string; origin: Origin }, o?: { body?: boolean; deleted?: boolean }): void {
    if (item.origin !== 'sample') this.sync.localChange(item.id, type, o)
  }

  /** Keeps the search index current for a note that changed or went away. */
  private noteChanged(id: string): void {
    const n = this.notesById.get(id)
    if (n) this.index.upsert(n)
    else this.index.remove(id)
  }

  constructor(protected readonly clock: Clock) {}

  subscribe(listener: (change: LibraryChange) => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  private changed(change: LibraryChange = ANY_CHANGE): void {
    this.version++
    for (const l of [...this.listeners]) l(change)
  }

  // Attachments (data-model.md "Attachment"). Kept in memory with their bytes; the caller hashes them first.

  /** `id` and `created`: an attachment carried over from another library (the demo's), keeping its links. */
  addAttachment(o: { bytes: Uint8Array; filename: string; mime: string; sha256: string; origin?: Origin; id?: string; created?: number }): Attachment {
    const created = o.created ?? this.clock()
    const a: Attachment = {
      id: o.id ?? newUlid(() => created),
      filename: o.filename,
      mime: o.mime,
      size: o.bytes.length,
      sha256: o.sha256,
      created,
      origin: o.origin ?? 'user',
      bytes: o.bytes,
    }
    this.attachmentsById.set(a.id, a)
    this.local('attachment', a, { body: true })
    this.changed()
    return a
  }

  /** Every attachment, with its bytes. */
  attachments(): Attachment[] {
    return [...this.attachmentsById.values()].map((a) => ({ ...a }))
  }

  attachment(id: string): Attachment | null {
    return this.attachmentsById.get(id) ?? null
  }

  /** The attachments `body` references outside code, in order, each once; unknown ids are left out. */
  attachmentsOf(body: string): Attachment[] {
    const out: Attachment[] = []
    for (const r of attachmentRefs(body)) {
      const a = this.attachmentsById.get(r.id)
      if (a && !out.includes(a)) out.push(a)
    }
    return out
  }

  /** Whether any note, live or in the Trash, references the attachment. */
  attachmentInUse(id: string): boolean {
    for (const n of this.notesById.values()) if (attachmentRefs(n.body).some((r) => r.id === id)) return true
    return false
  }

  // Notes

  createNote(o: NoteInput = {}): Note {
    if (o.notebookId) this.requireNotebook(o.notebookId)
    const tagIds = this.checkedTags(o.tagIds ?? [])
    const now = this.clock()
    const created = o.created ?? now
    const note: Note = {
      id: newUlid(() => created),
      title: o.title ?? '',
      body: o.body ?? '',
      notebookId: o.notebookId ?? null,
      tagIds,
      pinned: false,
      created,
      modified: o.modified ?? created,
      trashedAt: null,
      origin: o.origin ?? 'user',
    }
    this.notesById.set(note.id, note)
    this.noteChanged(note.id)
    this.local('note', note, { body: true })
    this.changed()
    return { ...note, tagIds: [...tagIds] }
  }

  note(id: string): Note | undefined {
    const n = this.notesById.get(id)
    return n && { ...n, tagIds: [...n.tagIds] }
  }

  /** `modified` moves only when the title or body actually changes. */
  updateNote(id: string, o: { title?: string; body?: string }): Note {
    const n = this.requireNote(id)
    const title = o.title ?? n.title
    const body = o.body ?? n.body
    if (title !== n.title || body !== n.body) {
      this.local('note', n, { body: body !== n.body })
      n.title = title
      n.body = body
      n.modified = this.clock()
      this.noteChanged(id)
      this.changed()
    }
    return this.note(id)!
  }

  setPinned(id: string, pinned: boolean): void {
    this.changeNote(id, (n) => n.pinned !== pinned && ((n.pinned = pinned), true))
  }

  moveNote(id: string, notebookId: string | null): void {
    if (notebookId) this.requireNotebook(notebookId)
    this.changeNote(id, (n) => n.notebookId !== notebookId && ((n.notebookId = notebookId), true))
  }

  setTags(id: string, tagIds: string[]): void {
    const tags = this.checkedTags(tagIds)
    this.changeNote(id, (n) => n.tagIds.join() !== tags.join() && ((n.tagIds = tags), true))
  }

  trashNote(id: string): void {
    this.changeNote(id, (n) => n.trashedAt === null && ((n.trashedAt = this.clock()), true))
  }

  restoreNote(id: string): void {
    this.changeNote(id, (n) => n.trashedAt !== null && ((n.trashedAt = null), true))
  }

  deleteNotePermanently(id: string): void {
    this.local('note', this.requireNote(id), { deleted: true })
    this.notesById.delete(id)
    this.noteChanged(id)
    this.changed()
  }

  emptyTrash(): number {
    return this.deleteWhere((n) => n.trashedAt !== null)
  }

  purgeExpiredTrash(retentionDays = 30): number {
    const cutoff = this.clock() - retentionDays * DAY
    return this.deleteWhere((n) => n.trashedAt !== null && n.trashedAt <= cutoff)
  }

  notes(view: View): NoteSummary[] {
    const all = [...this.notesById.values()]
    const live = all.filter((n) => n.trashedAt === null)
    const byModified = (a: Note, b: Note) => b.modified - a.modified || cmpIdDesc(a, b)
    const listOrder = (a: Note, b: Note) => Number(b.pinned) - Number(a.pinned) || byModified(a, b)
    let out: Note[]
    switch (view.kind) {
      case 'all':
        out = live.sort(listOrder)
        break
      case 'recent': {
        const since = this.clock() - RECENT_DAYS * DAY
        out = live.filter((n) => n.modified >= since).sort(byModified).slice(0, RECENT_LIMIT)
        break
      }
      case 'pinned':
        out = live.filter((n) => n.pinned).sort(byModified)
        break
      case 'trash':
        out = all.filter((n) => n.trashedAt !== null).sort((a, b) => b.trashedAt! - a.trashedAt! || cmpIdDesc(a, b))
        break
      case 'notebook': {
        if (!this.notebooksById.has(view.id)) return []
        const tree = new Set(this.descendants(view.id))
        out = live.filter((n) => n.notebookId !== null && tree.has(n.notebookId)).sort(listOrder)
        break
      }
      case 'tag':
        out = live.filter((n) => n.tagIds.includes(view.id)).sort(listOrder)
        break
    }
    return out.map(summary)
  }

  counts(): Counts {
    let all = 0
    let pinned = 0
    let trash = 0
    const direct = new Map<string, number>()
    for (const n of this.notesById.values()) {
      if (n.trashedAt !== null) {
        trash++
        continue
      }
      all++
      if (n.pinned) pinned++
      if (n.notebookId) direct.set(n.notebookId, (direct.get(n.notebookId) ?? 0) + 1)
    }
    const children = this.childrenMap()
    const notebooks = new Map<string, number>()
    const total = (id: string): number => {
      const known = notebooks.get(id)
      if (known !== undefined) return known
      const sum = (direct.get(id) ?? 0) + (children.get(id) ?? []).reduce((s, c) => s + total(c), 0)
      notebooks.set(id, sum)
      return sum
    }
    for (const id of this.notebooksById.keys()) total(id)
    return { all, pinned, trash, notebooks }
  }

  // Notebooks

  createNotebook(name: string, parentId: string | null, origin: Origin = 'user'): Notebook {
    if (parentId) this.requireNotebook(parentId)
    const now = this.clock()
    const nb: Notebook = { id: newUlid(this.clock), name, parentId, created: now, modified: now, origin }
    this.notebooksById.set(nb.id, nb)
    this.local('notebook', nb)
    this.changed()
    return { ...nb }
  }

  renameNotebook(id: string, name: string): void {
    const nb = this.requireNotebook(id)
    nb.name = name
    nb.modified = this.clock()
    this.local('notebook', nb)
    this.changed()
  }

  moveNotebook(id: string, parentId: string | null): void {
    const nb = this.requireNotebook(id)
    if (parentId) {
      this.requireNotebook(parentId)
      if (this.descendants(id).includes(parentId)) throw new LibraryError('notebookCycle')
    }
    nb.parentId = parentId
    nb.modified = this.clock()
    this.local('notebook', nb)
    this.changed()
  }

  /** Deletes the notebook and its sub-notebooks. Their notes go to the Trash, at the root. */
  deleteNotebook(id: string): void {
    this.requireNotebook(id)
    const tree = new Set(this.descendants(id))
    const now = this.clock()
    for (const n of this.notesById.values()) {
      if (n.notebookId !== null && tree.has(n.notebookId)) {
        n.notebookId = null
        n.trashedAt ??= now
        this.noteChanged(n.id)
        this.local('note', n)
      }
    }
    for (const nb of tree) {
      this.local('notebook', this.notebooksById.get(nb)!, { deleted: true })
      this.notebooksById.delete(nb)
    }
    this.changed()
  }

  notebooks(): Notebook[] {
    return [...this.notebooksById.values()].sort(byCreation).sort((a, b) => nameOrder(a.name, b.name)).map((nb) => ({ ...nb }))
  }

  /** `id` and every notebook below it, parents before children. */
  descendants(id: string): string[] {
    if (!this.notebooksById.has(id)) return []
    const children = this.childrenMap()
    const out = [id]
    for (let i = 0; i < out.length; i++) out.push(...(children.get(out[i]!) ?? []))
    return out
  }

  // Tags

  createTag(name: string, origin: Origin = 'user'): Tag {
    this.requireFreeTagName(name, null)
    const now = this.clock()
    const tag: Tag = { id: newUlid(this.clock), name, created: now, modified: now, origin }
    this.tagsById.set(tag.id, tag)
    this.local('tag', tag)
    this.changed()
    return { ...tag }
  }

  renameTag(id: string, name: string): void {
    const tag = this.requireTag(id)
    this.requireFreeTagName(name, id)
    tag.name = name
    tag.modified = this.clock()
    this.local('tag', tag)
    this.changed()
  }

  /** Notes lose the tag; their `modified` stays and they aren't changes to sync (data-model.md "Trash"). */
  deleteTag(id: string): void {
    this.local('tag', this.requireTag(id), { deleted: true })
    this.tagsById.delete(id)
    for (const n of this.notesById.values()) {
      if (n.tagIds.includes(id)) n.tagIds = n.tagIds.filter((t) => t !== id)
    }
    this.changed()
  }

  tags(): Tag[] {
    return [...this.tagsById.values()].sort(byCreation).sort((a, b) => nameOrder(a.name, b.name)).map((t) => ({ ...t }))
  }

  // Search (data-model.md "Search")

  search(query: string, o: { notebookId?: string | null; tagIds?: string[]; inTrash?: boolean; limit?: number } = {}): SearchHit[] {
    const words = buildQuery(query)
    if (!words) return []
    const tree = o.notebookId ? new Set(this.descendants(o.notebookId)) : null
    if (tree && tree.size === 0) return []
    const tags = o.tagIds ?? []
    const inTrash = o.inTrash ?? false
    const allowed = (id: string) => {
      const n = this.notesById.get(id)
      if (!n || (n.trashedAt !== null) !== inTrash) return false
      if (tree && (n.notebookId === null || !tree.has(n.notebookId))) return false
      return tags.every((t) => n.tagIds.includes(t))
    }
    return this.index.search(words, allowed, o.limit ?? 200).map(({ id }) => {
      const n = this.notesById.get(id)!
      const s = summary(n)
      const snip = this.index.snippet(n.body, words)
      return snip ? { note: s, ...snip } : { note: s, snippet: s.preview, matches: [] }
    })
  }

  // Sync bookkeeping (sync-protocol.md "Client sync algorithm", "Conflict resolution"; Library+Sync.swift). Every
  // mutation above marks its item dirty; the remote writes below never do.

  /** Items with local changes to push, in the order they changed. Never a sample item. */
  dirtyItems(): SyncItem[] {
    return this.sync.dirty()
  }

  syncItem(id: string): SyncItem | null {
    return this.sync.item(id)
  }

  /** Every sync record, clean and dirty, pending tombstones included. */
  syncItems(): SyncItem[] {
    return this.sync.all()
  }

  /** Bumped by every local change (never by a remote write): the session syncs 2 s after it moves. */
  get localChangeSeq(): number {
    return this.sync.changeSeq
  }

  /** Fills an empty library with a snapshot (opening the vault): items and bookkeeping exactly as they were, nothing
   *  marked dirty that wasn't. */
  restore(s: LibrarySnapshot): void {
    if (this.notesById.size || this.notebooksById.size || this.tagsById.size || this.attachmentsById.size) throw new Error('restore needs an empty library')
    for (const nb of s.notebooks) this.notebooksById.set(nb.id, { ...nb })
    for (const t of s.tags) this.tagsById.set(t.id, { ...t })
    for (const a of s.attachments) this.attachmentsById.set(a.id, { ...a })
    for (const n of s.notes) {
      // a tag or notebook that is gone is dropped, as from the server (applyRemoteNote): a copy sealed by an older
      // build may still name it, and a dangling tag id would make setTags fail for good
      const notebookId = n.notebookId !== null && this.notebooksById.has(n.notebookId) ? n.notebookId : null
      this.notesById.set(n.id, { ...n, notebookId, tagIds: n.tagIds.filter((t) => this.tagsById.has(t)) })
      this.noteChanged(n.id)
    }
    this.sync.restore(s.sync, s.conflicts, s.cursor === null ? {} : { pull_cursor: s.cursor })
    this.changed()
  }

  /** Records an accepted push. The item becomes clean only if nothing changed since the snapshot `ifDirtySeq`. */
  markPushed(id: string, version: number, blobSha: string | null, ifDirtySeq: number): void {
    this.sync.markPushed(id, version, blobSha, ifDirtySeq)
  }

  /** Moves a dirty item onto a newer server version without clearing it (a local edit against a server tombstone). */
  rebase(id: string, version: number): void {
    this.sync.rebase(id, version)
  }

  /** The body or content must be uploaded again (the server answered blob_missing). Keeps the item dirty. */
  markBodyDirty(id: string): void {
    this.sync.markBodyDirty(id)
  }

  /** Whether a note's notebook and tags all exist here. */
  referencesResolve(notebookId: string | null, tagIds: string[]): boolean {
    if (notebookId !== null && !this.notebooksById.has(notebookId)) return false
    return tagIds.every((t) => this.tagsById.has(t))
  }

  syncValue(key: SyncKey): string | null {
    return this.sync.value(key)
  }

  setSyncValue(key: SyncKey, value: string | null): void {
    this.sync.setValue(key, value)
  }

  /** Forgets all sync bookkeeping (sign-out). With `markAllDirty`, every item but the samples is new to the server. */
  resetSync(markAllDirty: boolean): void {
    const dirty: Array<{ id: string; type: ItemType; body: boolean }> = []
    if (markAllDirty) {
      const add = (type: ItemType, body: boolean, items: Iterable<{ id: string; origin: Origin }>) => {
        for (const i of items) if (i.origin !== 'sample') dirty.push({ id: i.id, type, body })
      }
      add('notebook', false, this.notebooksById.values())
      add('tag', false, this.tagsById.values())
      add('attachment', true, this.attachmentsById.values())
      add('note', true, this.notesById.values())
    }
    this.sync.reset(dirty)
  }

  /** Stores a note from the server. A notebook that doesn't exist here puts it at the root; unknown tag ids are
   *  dropped (data-model.md "Trash"). `bodyLoaded: false` stores the metadata before the body arrives. */
  applyRemoteNote(note: Note, o: RemoteNoteApply): boolean {
    this.remoteWatch.beforeWrite?.(note.id)
    if (!this.sync.unchangedHere(note.id, o.ifDirtySeq)) return false
    const notebookId = note.notebookId !== null && this.notebooksById.has(note.notebookId) ? note.notebookId : null
    const tagIds = [...new Set(note.tagIds.filter((t) => this.tagsById.has(t)))].sort()
    this.notesById.set(note.id, { ...note, notebookId, tagIds, origin: 'user' })
    this.noteChanged(note.id)
    this.sync.remember(note.id, 'note', o)
    this.changed()
    return true
  }

  /** Stores a notebook from the server. A parent that doesn't exist here, or that would make a cycle, makes it
   *  top-level. */
  applyRemoteNotebook(nb: Notebook, o: RemoteApply): boolean {
    if (!this.sync.unchangedHere(nb.id, o.ifDirtySeq)) return false
    const p = nb.parentId
    const parentId = p !== null && this.notebooksById.has(p) && !this.descendants(nb.id).includes(p) && p !== nb.id ? p : null
    this.notebooksById.set(nb.id, { ...nb, parentId, origin: 'user' })
    this.sync.remember(nb.id, 'notebook', { ...o, blobSha: null, bodyLoaded: true })
    this.changed()
    return true
  }

  /** Stores a tag from the server. Another device may have made a tag with the same name: both are kept. */
  applyRemoteTag(tag: Tag, o: RemoteApply): boolean {
    if (!this.sync.unchangedHere(tag.id, o.ifDirtySeq)) return false
    this.tagsById.set(tag.id, { ...tag, origin: 'user' })
    this.sync.remember(tag.id, 'tag', { ...o, blobSha: null, bodyLoaded: true })
    this.changed()
    return true
  }

  /** Stores an attachment and its content from the server. Without `content` (not downloaded yet) it keeps the
   *  bytes it had, if any, and its content counts as not loaded. */
  applyRemoteAttachment(a: AttachmentMeta, content: Uint8Array | null, o: RemoteAttachmentApply): boolean {
    if (!this.sync.unchangedHere(a.id, o.ifDirtySeq)) return false
    const old = this.attachmentsById.get(a.id)
    const hadContent = old !== undefined && (this.sync.item(a.id)?.bodyLoaded ?? true)
    const bytes = content ?? old?.bytes ?? new Uint8Array(0)
    this.attachmentsById.set(a.id, { ...a, size: content ? content.length : a.size, origin: 'user', bytes })
    this.sync.remember(a.id, 'attachment', { ...o, bodyLoaded: content !== null || hadContent })
    this.changed()
    return true
  }

  /** Removes an item the server deleted for good (a tombstone), and its bookkeeping. As on the Mac, a notebook takes
   *  its sub-notebooks with it and leaves their notes at the root; a tag leaves its notes. */
  applyRemoteDelete(id: string, type: ItemType, _version: number, ifDirtySeq: number | null = null): boolean {
    if (type === 'note') this.remoteWatch.beforeWrite?.(id)
    if (!this.sync.unchangedHere(id, ifDirtySeq)) return false
    switch (type) {
      case 'note':
        this.notesById.delete(id)
        this.noteChanged(id)
        break
      case 'notebook': {
        const tree = new Set(this.descendants(id))
        for (const n of this.notesById.values()) {
          if (n.notebookId !== null && tree.has(n.notebookId)) {
            n.notebookId = null
            this.noteChanged(n.id)
          }
        }
        for (const nb of tree) this.notebooksById.delete(nb)
        break
      }
      case 'tag':
        this.tagsById.delete(id)
        for (const n of this.notesById.values()) if (n.tagIds.includes(id)) n.tagIds = n.tagIds.filter((t) => t !== id)
        break
      case 'attachment':
        this.attachmentsById.delete(id)
        break
    }
    this.sync.forget(id)
    this.changed()
    return true
  }

  /** A note's body downloaded in the background. Refused (false) if the note is gone, its body changed here, it is
   *  already loaded, or `blobSha` isn't the blob last applied (a stale download). */
  setRemoteBody(id: string, body: string, blobSha: string): boolean {
    const n = this.notesById.get(id)
    if (!n || !this.sync.bodyArrived(id, blobSha)) return false
    n.body = body
    this.noteChanged(id)
    // only the body: no title, date, notebook, tag or count moved, so the list needn't be drawn again
    this.changed({ kind: 'body', id })
    return true
  }

  /** The local side of a note conflict, saved as a new note (sync-protocol.md "Conflict resolution"). References
   *  gone here are dropped. */
  createConflictCopy(of: Note, title: string): Note {
    const copy = this.createNote({
      title,
      body: of.body,
      notebookId: of.notebookId !== null && this.notebooksById.has(of.notebookId) ? of.notebookId : null,
      tagIds: of.tagIds.filter((t) => this.tagsById.has(t)),
      created: of.created,
      modified: of.modified,
    })
    if (!of.pinned) return copy
    this.setPinned(copy.id, true)
    return this.note(copy.id)!
  }

  recordSyncConflict(c: { itemId: string; type: ItemType; lostName: string; device: string; at: number }): void {
    this.sync.recordConflict(c)
    this.changed()
  }

  /** Newest first. */
  syncConflicts(): SyncConflict[] {
    return this.sync.conflictList()
  }

  // Internals

  private changeNote(id: string, change: (n: Note) => boolean): void {
    const n = this.requireNote(id)
    if (change(n)) {
      this.noteChanged(id)
      this.local('note', n)
      this.changed()
    }
  }

  private deleteWhere(test: (n: Note) => boolean): number {
    const ids = [...this.notesById.values()].filter(test).map((n) => n.id)
    for (const id of ids) {
      this.local('note', this.notesById.get(id)!, { deleted: true })
      this.notesById.delete(id)
      this.noteChanged(id)
    }
    if (ids.length) this.changed()
    return ids.length
  }

  private childrenMap(): Map<string, string[]> {
    const children = new Map<string, string[]>()
    for (const nb of [...this.notebooksById.values()].sort(byCreation)) {
      if (nb.parentId) children.set(nb.parentId, [...(children.get(nb.parentId) ?? []), nb.id])
    }
    return children
  }

  private checkedTags(ids: string[]): string[] {
    for (const id of ids) this.requireTag(id)
    return [...new Set(ids)].sort()
  }

  private requireNote(id: string): Note {
    const n = this.notesById.get(id)
    if (!n) throw new LibraryError('notFound', id)
    return n
  }

  private requireNotebook(id: string): Notebook {
    const nb = this.notebooksById.get(id)
    if (!nb) throw new LibraryError('notFound', id)
    return nb
  }

  private requireTag(id: string): Tag {
    const t = this.tagsById.get(id)
    if (!t) throw new LibraryError('notFound', id)
    return t
  }

  private requireFreeTagName(name: string, except: string | null): void {
    if (name.trim() === '') throw new LibraryError('invalidName')
    const key = tagKey(name)
    for (const t of this.tagsById.values()) {
      if (t.id !== except && tagKey(t.name) === key) throw new LibraryError('duplicateTagName', name)
    }
  }
}

const cmpIdDesc = (a: { id: string }, b: { id: string }) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
const byCreation = (a: { created: number; id: string }, b: { created: number; id: string }) =>
  a.created - b.created || (a.id < b.id ? -1 : 1)

function summary(n: Note): NoteSummary {
  const { body, tagIds: _tags, ...rest } = n
  return { ...rest, preview: preview(body) }
}
