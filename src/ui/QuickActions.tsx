// Quick actions (Ctrl/⌘+K, or the app bar's search button): one field that searches all notes, as the old app bar
// field did, and filters a short list of actions. Down and Up move, Return runs, Escape closes and clears the search.
// A modal <dialog>, so the page behind is inert. It lists note titles, so App closes it whenever the notes leave
// the screen (lock, sign-out, an account screen).
import { signal } from '@preact/signals'
import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import { displayTitle } from '../core/library/names.ts'
import type { AppModel } from '../model/app-model.ts'
import * as act from './actions.ts'
import { downloadOpenNote } from './download.ts'

/** In memory only, like every piece of UI state. */
export const quickActionsOpen = signal(false)

const NOTES_SHOWN = 6

/** Opens the note toolbar's Tags or Move menu, once quick actions have gone (the page behind a modal is inert). */
function openToolbarMenu(name: 'Tags' | 'Move') {
  setTimeout(() => document.querySelector<HTMLElement>(`[role="toolbar"][aria-label="Note"] [aria-label="${name}"]`)?.click(), 0)
}

type Section = 'This note' | 'Library' | 'Notes'
type Choice = { id: string; section: Section; label: string; hint?: string; run: () => void }

export function QuickActions({ model, newNote, openNote }: { model: AppModel; newNote: () => void; openNote: () => void }) {
  if (!quickActionsOpen.value) return null
  return <QuickActionsDialog model={model} newNote={newNote} openNote={openNote} />
}

function QuickActionsDialog({ model, newNote, openNote }: { model: AppModel; newNote: () => void; openNote: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const returnTo = useRef<Element | null>(document.activeElement)
  const [active, setActive] = useState(0)
  // "This note" is the note open when quick actions opened: typing searches, and the list's open note may change
  const note = useRef(model.openNote.peek()).current

  useLayoutEffect(() => {
    const d = ref.current!
    d.showModal()
    field.current?.focus()
    field.current?.select()
    return () => {
      if (d.open) d.close()
      // Back to what had focus, unless the action moved it on (a new note's title). After the redraw (a task, not a
      // microtask: WebKit redraws the list later): clearing the search redraws the list, and a note row redrawn is a
      // new element, found again by its note id.
      const back = returnTo.current as HTMLElement | null
      setTimeout(() => {
        const now = document.activeElement
        if (now && now !== document.body) return
        const id = back?.dataset?.id
        const target = back && !back.isConnected && id ? document.querySelector<HTMLElement>(`[role="option"][data-id="${CSS.escape(id)}"]`) : back
        target?.focus?.()
      }, 0)
    }
  }, [])

  const text = model.searchText.value
  const query = text.trim().toLowerCase()
  const actions: Choice[] = []
  if (note && note.trashedAt === null && !model.readOnly.value) {
    actions.push({ id: 'qa-pin', section: 'This note', label: note.pinned ? 'Unpin note' : 'Pin note', run: () => model.togglePin(note.id) })
    // the typed words searched too, and may have hidden the note: show it again, then open its toolbar's menu
    const toolbarMenu = (name: 'Tags' | 'Move') => () => {
      model.setSearch('')
      model.selectNote(note.id)
      openToolbarMenu(name)
    }
    actions.push({ id: 'qa-tag', section: 'This note', label: 'Add a tag', run: toolbarMenu('Tags') })
    actions.push({ id: 'qa-move', section: 'This note', label: 'Move to a notebook', run: toolbarMenu('Move') })
    // a body that hasn't arrived would be saved as an empty file
    if (!model.openNoteLoading.value) actions.push({ id: 'qa-download', section: 'This note', label: 'Download .md', run: () => downloadOpenNote(model) })
    actions.push({ id: 'qa-trash', section: 'This note', label: 'Move to Trash', run: () => model.trashWithUndo(note.id) })
  }
  actions.push(
    { id: 'qa-new-note', section: 'Library', label: 'New note', hint: 'Alt+N', run: newNote },
    { id: 'qa-new-notebook', section: 'Library', label: 'New notebook', run: () => act.newNotebook(model, null) },
    { id: 'qa-new-tag', section: 'Library', label: 'New tag', run: () => act.newTag(model) },
    { id: 'qa-recent', section: 'Library', label: 'Go to Recent', run: () => model.select({ kind: 'recent' }) },
  )
  const choices: Choice[] = actions.filter((a) => a.label.toLowerCase().includes(query))
  if (query !== '')
    for (const row of model.rows.value.slice(0, NOTES_SHOWN))
      choices.push({
        id: `qa-note-${row.note.id}`,
        section: 'Notes',
        label: displayTitle(row.note.title),
        run: () => {
          model.selectNote(row.note.id)
          openNote()
        },
      })
  const at = choices.length === 0 ? -1 : Math.min(active, choices.length - 1)

  const close = () => (quickActionsOpen.value = false)
  // close first, so a dialog the action opens (New notebook) isn't covered, then run
  const run = (c: Choice) => {
    close()
    c.run()
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // a search field would take Escape to clear itself; here it closes, and the search goes too
      model.setSearch('')
      close()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (choices.length) setActive((at + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length)
    } else if (e.key === 'Enter') {
      if (at >= 0) run(choices[at]!)
    } else if (e.key === 'Tab') {
      // the field is the dialog's one stop
    } else return
    e.preventDefault()
  }

  const sections: Section[] = ['This note', 'Library', 'Notes']
  return (
    <dialog
      ref={ref}
      class="quick-actions"
      aria-label="Quick actions"
      onCancel={(e) => {
        e.preventDefault()
        model.setSearch('')
        close()
      }}
    >
      <div class="qa-field">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" class="search-icon">
          <circle cx="7" cy="7" r="4.5" />
          <path d="m10.5 10.5 3 3" />
        </svg>
        <input
          ref={field}
          type="search"
          role="combobox"
          // Preact's types ask a combobox input for `list`; the popup is the listbox below, not a <datalist>
          list={undefined}
          aria-label="Search all notes"
          aria-expanded="true"
          aria-controls="qa-list"
          aria-autocomplete="list"
          aria-activedescendant={at >= 0 ? choices[at]!.id : undefined}
          placeholder="Search all notes or run an action"
          value={text}
          onInput={(e) => {
            model.searchAll(e.currentTarget.value)
            setActive(0)
          }}
          onKeyDown={onKey}
        />
        <button type="button" class="qa-esc" aria-label="Close (esc)" tabIndex={-1} onClick={() => {
          model.setSearch('')
          close()
        }}>
          esc
        </button>
      </div>
      <div id="qa-list" role="listbox" aria-label="Quick actions" class="qa-list">
        {sections.map((section) => {
          const inSection = choices.filter((c) => c.section === section)
          if (!inSection.length) return null
          const head = `qa-head-${section.replace(' ', '-').toLowerCase()}`
          return (
            <div role="group" aria-labelledby={head} key={section}>
              <div id={head} class="overline qa-head">
                {section}
              </div>
              {inSection.map((c) => (
                <div
                  key={c.id}
                  id={c.id}
                  role="option"
                  aria-label={c.label}
                  aria-keyshortcuts={c.hint}
                  aria-selected={choices[at] === c}
                  class="qa-option"
                  // a click must not take focus from the field
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => run(c)}
                >
                  <span class="qa-label">{c.label}</span>
                  {c.hint && <kbd class="qa-hint">{c.hint}</kbd>}
                </div>
              ))}
            </div>
          )
        })}
      </div>
      <p class="qa-foot">Type to search notes. Use the arrows and Return to run the highlighted one.</p>
    </dialog>
  )
}
