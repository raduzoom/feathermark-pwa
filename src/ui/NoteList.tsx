// The note list: heading, the in-view search field, the scope chip, and a listbox of rows (or an empty state).
import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { AppModel, Row } from '../model/app-model.ts'
import { noteMeta, rowLabel, trashMeta } from '../model/format.ts'
import * as act from './actions.ts'
import { firstItem, MenuList, type MenuItem } from './Menu.tsx'

const TINTS = 4
function tint(id: string): number {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.codePointAt(0)!) % 1_000_003
  return h % TINTS
}
function letter(title: string): string {
  const first = [...title.trim()][0]
  return first ? first.toUpperCase() : '·'
}

function Snippet({ row }: { row: Row }) {
  if (row.snippet === null) return null
  const parts: ComponentChildren[] = []
  let at = 0
  row.matches.forEach(([s, e], i) => {
    parts.push(row.snippet!.slice(at, s), <mark key={i}>{row.snippet!.slice(s, e)}</mark>)
    at = e
  })
  parts.push(row.snippet.slice(at))
  return <span class="row-snippet">{parts}</span>
}

export function NoteList({ model, onOpen, onEnter }: { model: AppModel; onOpen: () => void; onEnter: () => void }) {
  const list = useRef<HTMLDivElement>(null)
  const rows = model.rows.value
  const openId = model.openNote.value?.id ?? null
  const empty = model.emptyState.value
  const searching = model.searchText.value.trim() !== ''
  const now = model.now()
  const notebookName = (id: string | null) => (id ? (model.notebooks.value.find((n) => n.id === id)?.name ?? null) : null)
  const scopeName = notebookName(model.searchNotebookId.value)

  // Focus moves at once: the row already exists, and waiting a frame let fast key presses land on the old row.
  const focusRow = (id: string) => list.current?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.focus()
  const choose = (id: string, focus: boolean) => {
    model.selectNote(id)
    onOpen()
    if (focus) focusRow(id)
  }

  // The row menu: right-click, Shift+F10 or the Menu key. Escape returns to the row.
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const menu = useRef<HTMLDivElement>(null)
  const closeMenu = (refocus: boolean) => {
    const id = menuFor
    setMenuFor(null)
    if (refocus && id) focusRow(id)
  }
  useLayoutEffect(() => {
    if (menuFor) firstItem(menu.current)?.focus()
  }, [menuFor])
  useEffect(() => {
    if (!menuFor) return
    const outside = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) setMenuFor(null)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [menuFor])
  const menuNote = rows.find((r) => r.note.id === menuFor)?.note ?? null
  const rowMenu = (): MenuItem[] => {
    const n = menuNote!
    if (n.trashedAt !== null)
      return [
        { label: 'Restore note', onSelect: () => model.restore(n.id) },
        { label: 'Delete permanently…', danger: true, onSelect: () => act.deletePermanently(model, n.id, n.title) },
      ]
    return [
      { label: n.pinned ? 'Unpin' : 'Pin', onSelect: () => model.togglePin(n.id) },
      { label: 'Move to Trash', onSelect: () => model.trashWithUndo(n.id) },
    ]
  }

  const onKey = (e: KeyboardEvent, row: Row, index: number) => {
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      setMenuFor(row.note.id)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = rows[index + (e.key === 'ArrowDown' ? 1 : -1)]
      if (next) choose(next.note.id, true)
    } else if (e.key === 'Enter') {
      onEnter()
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && row.note.trashedAt === null) {
      model.trashWithUndo(row.note.id)
      const id = model.openNote.value?.id
      if (id) focusRow(id)
    } else return
    e.preventDefault()
  }

  return (
    <div class="list-body">
      <div class="list-head">
        <h2 class="list-title">{searching ? 'Search' : model.title.value}</h2>
        <input
          type="search"
          class="list-search"
          aria-label="Search in this view"
          placeholder="Search in this view"
          value={model.searchText.value}
          onInput={(e) => model.setSearch(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') model.setSearch('')
          }}
        />
        {searching && scopeName && rows.length > 0 && (
          <p class="scope-chip">
            Only in {scopeName} ·{' '}
            <button type="button" class="link-button" onClick={() => model.setSearchNotebook(null)}>
              Search all notebooks
            </button>
          </p>
        )}
      </div>
      {empty && empty.kind !== 'noNoteSelected' ? (
        <EmptyList model={model} />
      ) : (
        <div ref={list} role="listbox" aria-label="Notes" class="rows">
          {rows.map((row, i) => {
            const n = row.note
            const nb = notebookName(n.notebookId)
            const selected = n.id === openId
            return (
              <div
                key={n.id}
                role="option"
                data-id={n.id}
                aria-selected={selected}
                aria-label={rowLabel(n, nb, now)}
                tabIndex={selected || (i === 0 && !rows.some((r) => r.note.id === openId)) ? 0 : -1}
                class={n.id === menuFor ? 'row row-menu-open' : 'row'}
                onClick={() => choose(n.id, false)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenuFor(n.id)
                }}
                onKeyDown={(e) => onKey(e, row, i)}
              >
                <span class="row-tile" data-tint={tint(n.id)} data-letter={letter(n.title)} aria-hidden="true" />
                <span class="row-text">
                  <span class="row-title">{n.title.trim() === '' ? 'Untitled' : n.title}</span>
                  <span class="row-meta">{n.trashedAt !== null ? trashMeta(n.trashedAt, 30, now) : noteMeta(n, nb, now)}</span>
                  <Snippet row={row} />
                </span>
              </div>
            )
          })}
        </div>
      )}
      {menuNote && (
        <MenuList
          menuRef={menu}
          label={`More for ${menuNote.title.trim() === '' ? 'Untitled' : menuNote.title}`}
          items={rowMenu()}
          onClose={closeMenu}
          class="menu row-menu"
        />
      )}
    </div>
  )
}

function EmptyList({ model }: { model: AppModel }) {
  const e = model.emptyState.value!
  switch (e.kind) {
    case 'firstLaunch':
      return (
        <div class="empty">
          <h3 class="empty-title">A quiet place to write.</h3>
          <p>This demo keeps notes only until you close the tab.</p>
          <button type="button" class="button button-primary" onClick={() => model.newNote()}>
            Write your first note
          </button>
        </div>
      )
    case 'emptyTrash':
      return (
        <div class="empty">
          <h3 class="empty-title">Trash is empty</h3>
          <p>Notes you delete wait here for 30 days before they're removed for good.</p>
        </div>
      )
    case 'noSearchResults':
      return (
        <div class="empty">
          <h3 class="empty-title">No notes match “{e.query}”</h3>
          {e.limitedTo && (
            <>
              <p>You're searching in {e.limitedTo} only. Try all notebooks, or fewer words.</p>
              <button type="button" class="button" onClick={() => model.setSearchNotebook(null)}>
                Search all notebooks
              </button>
            </>
          )}
        </div>
      )
    default:
      return (
        <div class="empty">
          <h3 class="empty-title">No notes here</h3>
        </div>
      )
  }
}
