// The web counterpart of FeatherAppModel's AppModel: selection, the open note, saving, Undo after Trash, search,
// empty states and errors. The views only read these signals and call these actions.
import { batch, computed, signal, type ReadonlySignal } from '@preact/signals'
import { systemClock, type Clock } from '../core/clock.ts'
import { attachmentId, attachmentSnippet, MAX_ATTACHMENT_BYTES, sha256Hex, type Attachment } from '../core/library/attachments.ts'
import type { Library, LibraryChange } from '../core/library/library.ts'
import { LibraryError, type Counts, type Note, type Notebook, type NoteSummary, type Tag, type View } from '../core/library/types.ts'
import { errorMessage, searchScopeName, tooLargeMessage, unreadableMessage } from './format.ts'

export type ResolvedAttachment = { objectUrl: string; filename: string; mime: string; image: boolean }
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
  /** The open note's body hasn't arrived from the server yet ("Loading this note…"): it can't be edited until it does,
   *  and stays so if its download failed. */
  openNoteLoading: ReadonlySignal<boolean>
  /** Bumped when an attachment's content arrives, so an editor showing it draws it again. */
  attachmentsVersion: ReadonlySignal<number>
  draft: ReadonlySignal<Draft | null>
  searchText: ReadonlySignal<string>
  searchNotebookId: ReadonlySignal<string | null>
  searchTagIds: ReadonlySignal<string[]>
  /** What a search is limited to ("Personal", "#hardware", "Personal, #hardware"), or null for every note. */
  searchScope: ReadonlySignal<string | null>
  emptyState: ReadonlySignal<EmptyState | null>
  undo: ReadonlySignal<{ noteId: string; title: string } | null>
  error: ReadonlySignal<string | null>
  titleWantsFocus: ReadonlySignal<boolean>
  /** "Markdown" pressed: the editor shows the raw text (the Mac's editor mode; it stays as notes change). */
  editorRaw: ReadonlySignal<boolean>
  /** Another tab owns the kept library ("FeatherMark is now open in another tab."): nothing here may change it. */
  readOnly: ReadonlySignal<boolean>
  setReadOnly(on: boolean): void
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
  /** Searches every note from "All notes"; quick actions pass the tags chosen with "#" to keep only notes with all of them. */
  searchAll(text: string, tagIds?: string[]): void
  setSearchNotebook(id: string | null): void
  /** Drops the notebook and tags a search is limited to, keeping its words. */
  searchEverywhere(): void
  toggleSearchTag(id: string): void
  focusTitleDone(): void
  toggleRaw(): void
  /** Adds dropped, pasted or picked files as attachments; returns the Markdown for each one added. Files over the
   *  demo's limit are refused with a message. */
  addFiles(files: File[]): Promise<string[]>
  /** The file behind a `feather://attachment/<id>` URL, with an object URL made once; null if unknown. */
  attachmentUrl(url: string): ResolvedAttachment | null
  /** The attachments a body references, for downloads. */
  attachmentsOf(body: string): Attachment[]
  clearError(): void
  /** Shows a message in the error toast (a failure outside the library, such as a lock that couldn't seal). */
  showError(message: string): void
  /** Puts another library in place (locking, unlocking, signing in or out). The old one's open note, unsaved typing,
   *  search, Undo and error go, and every attachment object URL is revoked. Unsaved typing is dropped: call flush()
   *  first to keep it. */
  setLibrary(library: Library, o?: LibraryOptions): void
  /** Text typed in the editor that another device's version replaced before it could be saved (an IME composition
   *  held the replacement back): kept as a conflict copy of the note, as the sync conflict rules would; the draft
   *  typed over the other device's text is dropped, never saved over it. */
  keepAsCopy(noteId: string, body: string): void
  /** The library on screen (the demo's, when the session offers to carry its notes into an account). */
  currentLibrary(): Library
  dispose(): void
}

/** `loadAttachment`: downloads an attachment's content the first time it is shown (BodyLoader.loadAttachment). */
/** `conflictTitle`: the title of a conflict copy made here (`<title> (conflict, <device>, <d MMM HH:mm>)`). */
export type LibraryOptions = { loadAttachment?: (id: string) => Promise<Uint8Array | null>; conflictTitle?: (title: string) => string }

const defaultTimers: TimerFns = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }

export function createAppModel(
  library: Library,
  opts: { clock?: Clock; saveDelayMs?: number; undoWindowMs?: number; setTimer?: TimerFns; trashRetentionDays?: number } = {},
): AppModel {
  const clock = opts.clock ?? systemClock
  const timers = opts.setTimer ?? defaultTimers
  const saveDelay = opts.saveDelayMs ?? 500
  const undoWindow = opts.undoWindowMs ?? 5000

  // Bumped on every change of the library, and when another library takes its place.
  const version = signal(0)
  // Bumped when a body arrives that something on screen shows: the open note's, or any while searching. Any other
  // body arriving redraws nothing (a library of 1,000 notes loading in the background would redraw the list each time).
  const bodyVersion = signal(0)
  const onChange = (c: LibraryChange) => {
    if (c.kind === 'body') {
      if (c.id === openId.peek() || searchText.peek().trim() !== '') bodyVersion.value++
      return
    }
    version.value++
  }
  // typing not saved yet goes in as a local change before another device's version of that note lands, so the
  // engine's conflict rules keep both; and the open note's body is downloaded with its metadata
  const watch = (lib: Library) =>
    lib.watchRemote({
      beforeWrite: (id) => {
        if (pending.peek()?.id === id) flush()
      },
      wantsBody: (id) => id === openId.peek(),
    })
  let unwatch = watch(library)
  let unsubscribe = library.subscribe(onChange)
  let loadAttachment: LibraryOptions['loadAttachment'] = undefined
  let conflictTitle: LibraryOptions['conflictTitle'] = undefined
  /** Attachments asked for (once per library), and the content of those that arrived but couldn't be stored. */
  const asked = new Set<string>()
  const fetched = new Map<string, Uint8Array>()
  const attachmentsVersion = signal(0)

  const selection = signal<View>({ kind: 'all' })
  const openId = signal<string | null>(null)
  /** Typing not saved yet. `bodyEdited`: the body was typed into; a title-only edit never writes the body, so a body
   *  that arrives from the server meanwhile isn't overwritten by the text the title was typed over. */
  const pending = signal<(Draft & { id: string; bodyEdited: boolean }) | null>(null)
  const searchText = signal('')
  const searchNotebookId = signal<string | null>(null)
  const searchTagIds = signal<string[]>([])
  const undo = signal<{ noteId: string; title: string } | null>(null)
  const error = signal<string | null>(null)
  const titleWantsFocus = signal(false)
  const editorRaw = signal(false)
  const readOnly = signal(false)
  // Object URLs for attachments, made on first use and kept while a note uses them.
  const objectUrls = new Map<string, string>()
  const releaseAllUrls = () => {
    for (const u of objectUrls.values()) URL.revokeObjectURL(u)
    objectUrls.clear()
  }
  const releaseUnusedUrls = () => {
    for (const [id, u] of objectUrls)
      if (!library.attachmentInUse(id)) {
        URL.revokeObjectURL(u)
        objectUrls.delete(id)
      }
  }
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
      bodyVersion.value
      return library
        .search(searchText.value, { notebookId: searchNotebookId.value, tagIds: searchTagIds.value, inTrash: view.kind === 'trash' })
        .map((h) => ({ note: h.note, snippet: h.snippet, matches: h.matches }))
    }
    return library.notes(view).map((note) => ({ note, snippet: null, matches: [] }))
  })
  const openNote = computed(() => {
    version.value
    bodyVersion.value
    return openId.value ? (library.note(openId.value) ?? null) : null
  })
  const openNoteLoading = computed(() => {
    version.value
    bodyVersion.value
    const id = openId.value
    return id !== null && library.syncItem(id)?.bodyLoaded === false
  })
  const draft = computed<Draft | null>(() => {
    const p = pending.value
    if (!p || p.id !== openId.value) return null
    return { title: p.title, body: p.bodyEdited ? p.body : (openNote.value?.body ?? p.body) }
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
  const searchScope = computed(() => {
    if (!searching.value) return null
    const names = tags.value.filter((t) => searchTagIds.value.includes(t.id)).map((t) => t.name)
    return searchScopeName(notebookName(searchNotebookId.value), names)
  })
  const emptyState = computed<EmptyState | null>(() => {
    const list = rows.value
    if (searching.value && list.length === 0) {
      return { kind: 'noSearchResults', query: searchText.value, limitedTo: searchScope.value }
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
    if (readOnly.value) return
    if (library.note(p.id)) library.updateNote(p.id, p.bodyEdited ? { title: p.title, body: p.body } : { title: p.title })
  }

  function flush(): void {
    if (saveTimer !== null) timers.clear(saveTimer)
    saveTimer = null
    save()
  }

  function edit(change: Partial<Draft>): void {
    const n = openNote.value
    if (!n || n.trashedAt !== null || readOnly.value) return
    // a body that hasn't arrived is a placeholder: never typed over (its title can still change)
    if (change.body !== undefined && openNoteLoading.peek()) return
    const current = draft.value ?? { title: n.title, body: n.body }
    const next = { ...current, ...change }
    if (next.title === current.title && next.body === current.body) return
    const bodyEdited = (pending.peek()?.id === n.id && pending.peek()!.bodyEdited) || next.body !== current.body
    pending.value = { id: n.id, ...next, bodyEdited }
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

  /** A change to the library: refused while another tab owns it. */
  function write<T>(body: () => T, tagName?: string): T | null {
    if (readOnly.value) return null
    return change(body, tagName)
  }

  /** Downloads an attachment once per library; a failure isn't retried on every redraw (the next library tries again). */
  function askFor(id: string): void {
    if (!loadAttachment || asked.has(id)) return
    asked.add(id)
    const lib = library
    loadAttachment(id).then(
      (bytes) => {
        if (library !== lib) return
        if (bytes && lib.syncItem(id)?.bodyLoaded === false) fetched.set(id, bytes)
        attachmentsVersion.value++
      },
      () => undefined,
    )
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
    openNoteLoading,
    attachmentsVersion,
    draft,
    searchText,
    searchNotebookId,
    searchTagIds,
    searchScope,
    emptyState,
    undo,
    error,
    titleWantsFocus,
    editorRaw,
    readOnly,
    setReadOnly(on) {
      if (on) flush()
      readOnly.value = on
    },
    toggleRaw() {
      editorRaw.value = !editorRaw.value
    },
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
      const n = write(() => {
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
      write(() => library.setPinned(id, !library.note(id)?.pinned))
    },
    move(id, notebookId) {
      write(() => library.moveNote(id, notebookId))
    },
    toggleTag(noteId, tagId) {
      write(() => {
        const tags = library.note(noteId)?.tagIds ?? []
        library.setTags(noteId, tags.includes(tagId) ? tags.filter((t) => t !== tagId) : [...tags, tagId])
      })
    },
    trashWithUndo(id) {
      flush()
      const t = library.note(id)?.title ?? ''
      const done = write(() => (library.trashNote(id), true))
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
      write(() => library.restoreNote(offer.noteId))
    },
    dismissUndo,
    restore(id) {
      write(() => library.restoreNote(id))
    },
    deletePermanently(id) {
      write(() => library.deleteNotePermanently(id))
      releaseUnusedUrls()
    },
    emptyTrash() {
      write(() => library.emptyTrash())
      releaseUnusedUrls()
    },
    async addFiles(files) {
      const snippets: string[] = []
      if (readOnly.value) return snippets
      // the library these files are for: if another takes its place meanwhile (a lock), they are dropped
      const lib = library
      for (const f of files) {
        if (f.size > MAX_ATTACHMENT_BYTES) {
          error.value = tooLargeMessage(f.name)
          continue
        }
        let bytes: Uint8Array
        try {
          bytes = new Uint8Array(await f.arrayBuffer())
        } catch {
          // a dropped folder, or a file the browser can't read: skip it, keep the rest
          error.value = unreadableMessage(f.name)
          continue
        }
        if (readOnly.value || library !== lib) return []
        const sha256 = await sha256Hex(bytes)
        if (readOnly.value || library !== lib) return []
        const a = lib.addAttachment({ bytes, filename: f.name, mime: f.type || 'application/octet-stream', sha256 })
        snippets.push(attachmentSnippet(a))
      }
      return snippets
    },
    attachmentsOf: (body) => library.attachmentsOf(body),
    attachmentUrl(url) {
      const id = attachmentId(url)
      const a = id ? library.attachment(id) : null
      if (!a) return null
      let bytes = a.bytes
      if (library.syncItem(a.id)?.bodyLoaded === false) {
        // from another device, not downloaded yet: it downloads now, and the editor draws it when it arrives
        const got = fetched.get(a.id)
        if (!got) {
          askFor(a.id)
          return null
        }
        bytes = got
      }
      let objectUrl = objectUrls.get(a.id)
      if (!objectUrl) {
        objectUrl = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: a.mime }))
        objectUrls.set(a.id, objectUrl)
      }
      return { objectUrl, filename: a.filename, mime: a.mime, image: a.mime.toLowerCase().startsWith('image/') }
    },
    createNotebook: (name, parentId) => write(() => (name.trim() === '' ? invalid() : library.createNotebook(name, parentId))),
    renameNotebook(id, name) {
      write(() => (name.trim() === '' ? invalid() : library.renameNotebook(id, name)))
    },
    moveNotebook(id, parentId) {
      write(() => library.moveNotebook(id, parentId))
    },
    deleteNotebook(id) {
      write(() => {
        const v = selection.value
        if (v.kind === 'notebook' && library.descendants(id).includes(v.id)) selection.value = { kind: 'all' }
        library.deleteNotebook(id)
      })
    },
    createTag: (name) => write(() => library.createTag(name), name),
    renameTag(id, name) {
      write(() => library.renameTag(id, name), name)
    },
    deleteTag(id) {
      write(() => {
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
    searchAll(text, tagIds = []) {
      if (selection.value.kind !== 'all') model.select({ kind: 'all' })
      model.setSearch(text)
      if (searching.value) change(() => (searchTagIds.value = tagIds.filter((id) => tags.value.some((t) => t.id === id))))
    },
    setSearchNotebook(id) {
      change(() => (searchNotebookId.value = id))
    },
    searchEverywhere() {
      change(() => {
        searchNotebookId.value = null
        searchTagIds.value = []
      })
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
    showError(message) {
      error.value = message
    },
    currentLibrary: () => library,
    keepAsCopy(noteId, body) {
      // the draft (typed over the other device's text) is in `body`: drop it rather than save it over theirs
      if (pending.peek()?.id === noteId) {
        if (saveTimer !== null) timers.clear(saveTimer)
        saveTimer = null
        pending.value = null
      }
      write(() => {
        const n = library.note(noteId)
        if (!n || n.body === body) return
        library.createConflictCopy({ ...n, body }, conflictTitle?.(n.title) ?? `${n.title} (conflict)`)
      })
    },
    setLibrary(next, o = {}) {
      if (saveTimer !== null) timers.clear(saveTimer)
      saveTimer = null
      dismissUndo()
      unsubscribe()
      releaseAllUrls()
      unwatch()
      library = next
      unwatch = watch(library)
      loadAttachment = o.loadAttachment
      conflictTitle = o.conflictTitle
      asked.clear()
      fetched.clear()
      unsubscribe = library.subscribe(onChange)
      batch(() => {
        pending.value = null
        error.value = null
        titleWantsFocus.value = false
        clearSearch()
        selection.value = { kind: 'all' }
        version.value++
        openId.value = rows.value[0]?.note.id ?? null
      })
    },
    dispose() {
      flush()
      dismissUndo()
      unsubscribe()
      unwatch()
      releaseAllUrls()
    },
  }

  library.purgeExpiredTrash(opts.trashRetentionDays ?? 30)
  openId.value = rows.value[0]?.note.id ?? null
  return model
}

function invalid(): never {
  throw new LibraryError('invalidName')
}
