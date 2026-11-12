// The in-memory library: the web counterpart of FeatherCore. Rules: data-model.md "Views and sort orders", "Trash".
import type { Clock } from '../clock.ts'
import { newUlid } from '../ulid.ts'
import { nameOrder, preview, tagKey } from './names.ts'
import { buildQuery, SearchIndex } from './search.ts'
import { LibraryError, type Counts, type Note, type Notebook, type NoteSummary, type Origin, type SearchHit, type Tag, type View } from './types.ts'

const DAY = 86_400_000
const RECENT_DAYS = 7
const RECENT_LIMIT = 50

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
  private listeners = new Set<() => void>()
  private index = new SearchIndex()
  version = 0

  /** Keeps the search index current for a note that changed or went away. */
  private noteChanged(id: string): void {
    const n = this.notesById.get(id)
    if (n) this.index.upsert(n)
    else this.index.remove(id)
  }

  constructor(protected readonly clock: Clock) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  private changed(): void {
    this.version++
    for (const l of [...this.listeners]) l()
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
    this.requireNote(id)
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
    this.changed()
    return { ...nb }
  }

  renameNotebook(id: string, name: string): void {
    const nb = this.requireNotebook(id)
    nb.name = name
    nb.modified = this.clock()
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
      }
    }
    for (const nb of tree) this.notebooksById.delete(nb)
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
    this.changed()
    return { ...tag }
  }

  renameTag(id: string, name: string): void {
    const tag = this.requireTag(id)
    this.requireFreeTagName(name, id)
    tag.name = name
    tag.modified = this.clock()
    this.changed()
  }

  /** Notes lose the tag; their `modified` stays (data-model.md "Trash"). */
  deleteTag(id: string): void {
    this.requireTag(id)
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

  // Internals

  private changeNote(id: string, change: (n: Note) => boolean): void {
    const n = this.requireNote(id)
    if (change(n)) {
      this.noteChanged(id)
      this.changed()
    }
  }

  private deleteWhere(test: (n: Note) => boolean): number {
    const ids = [...this.notesById.values()].filter(test).map((n) => n.id)
    for (const id of ids) {
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
