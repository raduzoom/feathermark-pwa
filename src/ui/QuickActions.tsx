// Quick actions (Ctrl/⌘+K, or the app bar's search button): one field that searches all notes, as the old app bar
// field did. Empty, it lists the tags to filter by; typed words also find the note and library actions. Down and Up
// move, Return runs, Escape closes and clears the search. Words also find tags and notebooks to go to. "#" then a tag's name offers it as a filter: picked (or completed with
// a space) it becomes a chip in the field, and the search keeps only notes with every chip's tag. Backspace in an
// empty field removes the last chip.
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

const PLACES_SHOWN = 4

type Section = 'Filter by tag' | 'This note' | 'Library' | 'Go to' | 'Notes'
/** `stay`: runs with quick actions still open (adding a filter), instead of closing them first. */
type Choice = { id: string; section: Section; label: string; hint?: string; stay?: boolean; run: () => void }

/** The "#name" being typed at the end of the field, if any: what it says so far, and the text before it. */
function typedTag(input: string): { name: string; before: string } | null {
  const m = /(^|\s)#(\S*)$/.exec(input)
  return m ? { name: m[2]!, before: input.slice(0, m.index + m[1]!.length) } : null
}

export function QuickActions({ model, newNote, openNote }: { model: AppModel; newNote: () => void; openNote: () => void }) {
  if (!quickActionsOpen.value) return null
  return <QuickActionsDialog model={model} newNote={newNote} openNote={openNote} />
}

function QuickActionsDialog({ model, newNote, openNote }: { model: AppModel; newNote: () => void; openNote: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const returnTo = useRef<Element | null>(document.activeElement)
  const [active, setActive] = useState(0)
  // the field's text and the tag chips; the words (without a "#name" still being typed) are what the model searches
  const [input, setInput] = useState(() => model.searchText.peek())
  const [chips, setChips] = useState<string[]>(() => (model.searchText.peek().trim() ? model.searchTagIds.peek() : []))
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

  const tags = model.tags.value
  const typing = typedTag(input)
  const words = typing ? typing.before : input
  const query = words.trim().toLowerCase()

  const update = (text: string, tagIds: string[]) => {
    // a finished "#name " that names a tag becomes a chip
    const found = [...tagIds]
    const rest = text.replace(/(^|\s)#(\S+)\s/g, (all, space: string, name: string) => {
      const tag = tags.find((t) => t.name.toLowerCase() === name.toLowerCase())
      if (!tag) return all
      if (!found.includes(tag.id)) found.push(tag.id)
      return space
    })
    setInput(rest)
    setChips(found)
    setActive(0)
    model.searchAll(typedTag(rest)?.before ?? rest, found)
  }
  const chipTags = chips.map((id) => tags.find((t) => t.id === id)).filter((t) => t !== undefined)

  // the actions show only for typed words: an empty field offers the tags, and filtering by tag they'd be in the way
  const offerActions = !typing && !chips.length && query !== ''
  const filterBy = (t: { id: string; name: string }, before: string): Choice => ({
    id: `qa-filter-${t.id}`,
    section: 'Filter by tag',
    label: `#${t.name}`,
    stay: true,
    run: () => update(before, [...chips, t.id]),
  })
  const actions: Choice[] = []
  if (!offerActions) {
    // no actions
  } else if (note && note.trashedAt === null && !model.readOnly.value) {
    actions.push({ id: 'qa-pin', section: 'This note', label: note.pinned ? 'Unpin note' : 'Pin note', run: () => model.togglePin(note.id) })
    actions.push({ id: 'qa-tag', section: 'This note', label: 'Add a tag', run: () => openToolbarMenu('Tags') })
    actions.push({ id: 'qa-move', section: 'This note', label: 'Move to a notebook', run: () => openToolbarMenu('Move') })
    // a body that hasn't arrived would be saved as an empty file
    if (!model.openNoteLoading.value) actions.push({ id: 'qa-download', section: 'This note', label: 'Download .md', run: () => downloadOpenNote(model) })
    actions.push({ id: 'qa-trash', section: 'This note', label: 'Move to Trash', run: () => model.trashWithUndo(note.id) })
  }
  if (offerActions) actions.push(
    { id: 'qa-new-note', section: 'Library', label: 'New note', hint: 'Alt+N', run: newNote },
    { id: 'qa-new-notebook', section: 'Library', label: 'New notebook', run: () => act.newNotebook(model, null) },
    { id: 'qa-new-tag', section: 'Library', label: 'New tag', run: () => act.newTag(model) },
    { id: 'qa-recent', section: 'Library', label: 'Go to Recent', run: () => model.select({ kind: 'recent' }) },
  )
  const choices: Choice[] = actions.filter((a) => a.label.toLowerCase().includes(query))
  if (typing) {
    const name = typing.name.toLowerCase()
    const filters = tags.filter((t) => !chips.includes(t.id) && t.name.toLowerCase().includes(name))
    choices.unshift(...filters.map((t) => filterBy(t, typing.before)))
  } else if (!chips.length && query === '') {
    choices.push(...tags.map((t) => filterBy(t, '')))
  } else if (chips.length === 1 && query === '') {
    const t = chipTags[0]!
    choices.push({ id: `qa-go-${t.id}`, section: 'Go to', label: `#${t.name}`, run: () => model.select({ kind: 'tag', id: t.id }) })
  } else if (!chips.length && query !== '') {
    const bare = query.replace(/^#/, '')
    const places: Choice[] = [
      ...tags.filter((t) => t.name.toLowerCase().includes(bare)).map((t): Choice => ({ id: `qa-go-${t.id}`, section: 'Go to', label: `#${t.name}`, run: () => model.select({ kind: 'tag', id: t.id }) })),
      ...model.notebooks.value.filter((n) => n.name.toLowerCase().includes(bare)).map((n): Choice => ({ id: `qa-go-${n.id}`, section: 'Go to', label: n.name, run: () => model.select({ kind: 'notebook', id: n.id }) })),
    ]
    choices.push(...places.slice(0, PLACES_SHOWN))
  }
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
    if (c.stay) return c.run()
    close()
    // an action's words named it rather than searched: drop the search, which may have hidden the note it acts on
    if (c.section === 'This note' || c.section === 'Library') {
      model.setSearch('')
      if (c.section === 'This note' && note) model.selectNote(note.id)
    }
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
    } else if (e.key === 'Backspace' && chips.length && e.currentTarget instanceof HTMLInputElement && e.currentTarget.selectionEnd === 0) {
      update(input, chips.slice(0, -1))
    } else return
    e.preventDefault()
  }

  const sections: Section[] = ['Filter by tag', 'This note', 'Library', 'Go to', 'Notes']
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
        {chipTags.map((t) => (
          <button
            type="button"
            key={t.id}
            class="qa-chip"
            aria-label={`Remove filter #${t.name}`}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => update(input, chips.filter((id) => id !== t.id))}
          >
            #{t.name}
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
              <path d="m3.5 3.5 5 5m0-5-5 5" />
            </svg>
          </button>
        ))}
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
          placeholder={chips.length ? 'Search these notes' : 'Search notes, #tags or actions'}
          value={input}
          onInput={(e) => update(e.currentTarget.value, chips)}
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
          const head = `qa-head-${section.replaceAll(' ', '-').toLowerCase()}`
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
      <p class="qa-foot">Pick a tag to filter, or type to search notes and actions. Use the arrows and Return to run the highlighted one.</p>
    </dialog>
  )
}
