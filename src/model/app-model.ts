// The web counterpart of FeatherAppModel's AppModel: selection, the open note, saving, Undo after Trash, search,
// empty states and errors. The views only read these signals and call these actions.
import { batch, computed, signal, type ReadonlySignal } from '@preact/signals'
import { systemClock, type Clock } from '../core/clock.ts'
import type { Library } from '../core/library/library.ts'
import { LibraryError, type Counts, type Note, type Notebook, type NoteSummary, type Tag, type View } from '../core/library/types.ts'
import { errorMessage } from './format.ts'

export type Row = { note: NoteSummary; snippet: string | null; matches: Array<[number, number]> }
export type EmptyState =
  | { kind: 'firstLaunch' }
  | { kind: 'emptyView' }
  | { kind: 'emptyTrash' }
  | { kind: 'noSearchResults'; query: string; limitedTo: string | null }
  | { kind: 'noNoteSelected' }
export type TimerFns = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
export type Draft = { title: string; body: string }

export type AppModel = {
  selection: ReadonlySignal<View>
  title: ReadonlySignal<string>
  rows: ReadonlySignal<Row[]>
  counts: ReadonlySignal<Counts>
  notebooks: ReadonlySignal<Notebook[]>
  tags: ReadonlySignal<Tag[]>
  openNote: ReadonlySignal<Note | null>
  draft: ReadonlySignal<Draft | null>
  searchText: ReadonlySignal<string>
  searchNotebookId: ReadonlySignal<string | null>
  searchTagIds: ReadonlySignal<string[]>
  emptyState: ReadonlySignal<EmptyState | null>
  undo: ReadonlySignal<{ noteId: string; title: string } | null>
  error: ReadonlySignal<string | null>
  titleWantsFocus: ReadonlySignal<boolean>
  now: () => number
  select(v: View): void
  selectNote(id: string | null): void
  newNote(): void
  editTitle(t: string): void
  editBody(b: string): void
  flush(): void
  togglePin(id: string): void
  move(id: string, notebookId: string | null): void
  toggleTag(noteId: string, tagId: string): void
  trashWithUndo(id: string): void
  undoLastTrash(): void
  dismissUndo(): void
  restore(id: string): void
  deletePermanently(id: string): void
  emptyTrash(): void
  createNotebook(name: string, parentId: string | null): Notebook | null
  renameNotebook(id: string, name: string): void
  moveNotebook(id: string, parentId: string | null): void
  deleteNotebook(id: string): void
  createTag(name: string): Tag | null
  renameTag(id: string, name: string): void
  deleteTag(id: string): void
  setSearch(text: string): void
  searchAll(text: string): void
  setSearchNotebook(id: string | null): void
  toggleSearchTag(id: string): void
  focusTitleDone(): void
  clearError(): void
  dispose(): void
}

const defaultTimers: TimerFns = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }

export function createAppModel(
  library: Library,
  opts: { clock?: Clock; saveDelayMs?: number; undoWindowMs?: number; setTimer?: TimerFns; trashRetentionDays?: number } = {},
): AppModel {
  const clock = opts.clock ?? systemClock
  const timers = opts.setTimer ?? defaultTimers
  const saveDelay = opts.saveDelayMs ?? 500
  const undoWindow = opts.undoWindowMs ?? 5000

  const version = signal(library.version)
  const unsubscribe = library.subscribe(() => (version.value = library.version))

  const selection = signal<View>({ kind: 'all' })
  const openId = signal<string | null>(null)
  const pending = signal<(Draft & { id: string }) | null>(null)
  const searchText = signal('')
  const searchNotebookId = signal<string | null>(null)
  const searchTagIds = signal<string[]>([])
  const undo = signal<{ noteId: string; title: string } | null>(null)
  const error = signal<string | null>(null)
  const titleWantsFocus = signal(false)
  let saveTimer: unknown = null
  let undoTimer: unknown = null

  const notebooks = computed(() => (version.value, library.notebooks()))
  const tags = computed(() => (version.value, library.tags()))
  const counts = computed(() => (version.value, library.counts()))
  const searching = computed(() => searchText.value.trim() !== '')
  const rows = computed<Row[]>(() => {
    version.value
    const view = selection.value
    if (searching.value) {
      return library
        .search(searchText.value, { notebookId: searchNotebookId.value, tagIds: searchTagIds.value, inTrash: view.kind === 'trash' })
        .map((h) => ({ note: h.note, snippet: h.snippet, matches: h.matches }))
    }
    return library.notes(view).map((note) => ({ note, snippet: null, matches: [] }))
  })
  const openNote = computed(() => {
    version.value
    return openId.value ? (library.note(openId.value) ?? null) : null
  })
  const draft = computed<Draft | null>(() => {
    const p = pending.value
    return p && p.id === openId.value ? { title: p.title, body: p.body } : null
  })
  const notebookName = (id: string | null) => (id ? (notebooks.value.find((n) => n.id === id)?.name ?? null) : null)
  const title = computed(() => {
    const v = selection.value
    switch (v.kind) {
      case 'all':
        return 'All notes'
      case 'recent':
        return 'Recent'
      case 'pinned':
        return 'Pinned'
      case 'trash':
        return 'Trash'
      case 'notebook':
        return notebookName(v.id) ?? 'Notebook'
      case 'tag': {
        const t = tags.value.find((x) => x.id === v.id)
        return t ? `#${t.name}` : 'Tag'
      }
    }
  })
  const emptyState = computed<EmptyState | null>(() => {
    const list = rows.value
    if (searching.value && list.length === 0) {
      return { kind: 'noSearchResults', query: searchText.value, limitedTo: notebookName(searchNotebookId.value) }
    }
    if (list.length === 0) {
      const c = counts.value
      if (c.all === 0 && c.trash === 0 && selection.value.kind !== 'trash') return { kind: 'firstLaunch' }
      return selection.value.kind === 'trash' ? { kind: 'emptyTrash' } : { kind: 'emptyView' }
    }
    return openId.value === null ? { kind: 'noNoteSelected' } : null
  })

  const visibleIds = () => rows.value.map((r) => r.note.id)

  /** When the open note left the list, open the one now at its place, or the last, or none. */
  function keepOpenNoteVisible(previous: string[]): void {
    const id = openId.value
    if (id === null) return
    const visible = visibleIds()
    if (visible.includes(id)) return
    const index = previous.indexOf(id)
    // Not in the list before this change either (a search hit edited until it no longer matched): leave it open.
    if (index < 0) return
    openId.value = visible.length ? visible[Math.min(index, visible.length - 1)]! : null
  }

  function save(): void {
    const p = pending.value
    if (!p) return
    pending.value = null
    if (library.note(p.id)) library.updateNote(p.id, { title: p.title, body: p.body })
  }

  function flush(): void {
    if (saveTimer !== null) timers.clear(saveTimer)
    saveTimer = null
    save()
  }

  function edit(change: Partial<Draft>): void {
    const n = openNote.value
    if (!n || n.trashedAt !== null) return
    const current = draft.value ?? { title: n.title, body: n.body }
    const next = { ...current, ...change }
    if (next.title === current.title && next.body === current.body) return
    pending.value = { id: n.id, ...next }
    if (saveTimer !== null) timers.clear(saveTimer)
    saveTimer = timers.set(() => {
      saveTimer = null
      save()
    }, saveDelay)
  }

  /** Saves pending typing, runs a change, keeps the open note sensible, and turns a library error into a message. */
  function change<T>(body: () => T, tagName?: string): T | null {
    flush()
    const before = visibleIds()
    try {
      let out!: T
      batch(() => {
        out = body()
      })
      keepOpenNoteVisible(before)
      return out
    } catch (e) {
      if (!(e instanceof LibraryError)) throw e
      error.value = errorMessage(e, tagName)
      return null
    }
  }

  function clearSearch(): void {
    searchText.value = ''
    searchNotebookId.value = null
    searchTagIds.value = []
  }

  function dismissUndo(): void {
    if (undoTimer !== null) timers.clear(undoTimer)
    undoTimer = null
    undo.value = null
  }

  const model: AppModel = {
    selection,
    title,
    rows,
    counts,
    notebooks,
    tags,
    openNote,
    draft,
    searchText,
    searchNotebookId,
    searchTagIds,
    emptyState,
    undo,
    error,
    titleWantsFocus,
    now: clock,
    select(v) {
      change(() => {
        selection.value = v
        clearSearch()
      })
    },
    selectNote(id) {
      flush()
      openId.value = id
    },
    newNote() {
      const n = change(() => {
        const v = selection.value
        if (v.kind === 'trash' || v.kind === 'pinned') selection.value = { kind: 'all' }
        clearSearch()
        return library.createNote({
          notebookId: v.kind === 'notebook' ? v.id : null,
          tagIds: v.kind === 'tag' ? [v.id] : [],
        })
      })
      if (n) {
        openId.value = n.id
        titleWantsFocus.value = true
      }
    },
    editTitle: (t) => edit({ title: t }),
    editBody: (b) => edit({ body: b }),
    flush,
    togglePin(id) {
      change(() => library.setPinned(id, !library.note(id)?.pinned))
    },
    move(id, notebookId) {
      change(() => library.moveNote(id, notebookId))
    },
    toggleTag(noteId, tagId) {
      change(() => {
        const tags = library.note(noteId)?.tagIds ?? []
        library.setTags(noteId, tags.includes(tagId) ? tags.filter((t) => t !== tagId) : [...tags, tagId])
      })
    },
    trashWithUndo(id) {
      flush()
      const t = library.note(id)?.title ?? ''
      const done = change(() => (library.trashNote(id), true))
      if (!done) return
      dismissUndo()
      const offer = { noteId: id, title: t }
      undo.value = offer
      undoTimer = timers.set(() => {
        undoTimer = null
        if (undo.value === offer) undo.value = null
      }, undoWindow)
    },
    undoLastTrash() {
      const offer = undo.value
      if (!offer) return
      dismissUndo()
      change(() => library.restoreNote(offer.noteId))
    },
    dismissUndo,
    restore(id) {
      change(() => library.restoreNote(id))
    },
    deletePermanently(id) {
      change(() => library.deleteNotePermanently(id))
    },
    emptyTrash() {
      change(() => library.emptyTrash())
    },
    createNotebook: (name, parentId) => change(() => (name.trim() === '' ? invalid() : library.createNotebook(name, parentId))),
    renameNotebook(id, name) {
      change(() => (name.trim() === '' ? invalid() : library.renameNotebook(id, name)))
    },
    moveNotebook(id, parentId) {
      change(() => library.moveNotebook(id, parentId))
    },
    deleteNotebook(id) {
      change(() => {
        const v = selection.value
        if (v.kind === 'notebook' && library.descendants(id).includes(v.id)) selection.value = { kind: 'all' }
        library.deleteNotebook(id)
      })
    },
    createTag: (name) => change(() => library.createTag(name), name),
    renameTag(id, name) {
      change(() => library.renameTag(id, name), name)
    },
    deleteTag(id) {
      change(() => {
        const v = selection.value
        if (v.kind === 'tag' && v.id === id) selection.value = { kind: 'all' }
        searchTagIds.value = searchTagIds.value.filter((t) => t !== id)
        library.deleteTag(id)
      })
    },
    setSearch(text) {
      change(() => {
        if (text.trim() === '') {
          clearSearch()
          return
        }
        if (!searching.value) {
          const v = selection.value
          if (v.kind === 'notebook') searchNotebookId.value = v.id
          if (v.kind === 'tag') searchTagIds.value = [v.id]
        }
        searchText.value = text
      })
    },
    searchAll(text) {
      if (selection.value.kind !== 'all') model.select({ kind: 'all' })
      model.setSearch(text)
    },
    setSearchNotebook(id) {
      change(() => (searchNotebookId.value = id))
    },
    toggleSearchTag(id) {
      change(() => {
        const t = searchTagIds.value
        searchTagIds.value = t.includes(id) ? t.filter((x) => x !== id) : [...t, id]
      })
    },
    focusTitleDone() {
      titleWantsFocus.value = false
    },
    clearError() {
      error.value = null
    },
    dispose() {
      flush()
      dismissUndo()
      unsubscribe()
    },
  }

  library.purgeExpiredTrash(opts.trashRetentionDays ?? 30)
  openId.value = rows.value[0]?.note.id ?? null
  return model
}

function invalid(): never {
  throw new LibraryError('invalidName')
}
