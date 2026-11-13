import { signal } from '@preact/signals'
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'
import type { AppModel } from '../model/app-model.ts'
import { DialogHost } from './Dialog.tsx'
import { EditorPane } from './EditorPane.tsx'
import { LibraryPanel } from './LibraryPanel.tsx'
import { Logo } from './Logo.tsx'
import { preventFileNavigation } from '../editor/attachments.ts'
import { NoteList } from './NoteList.tsx'
import { ErrorToast, UndoToast } from './Toasts.tsx'

const drawerOpen = signal(false)
/** Below 640 px: the list is the start screen; the note opened from it shows full width while it stays open.
 *  When it leaves (trashed, deleted, replaced), the list comes back rather than another note or an empty pane. */
const phoneOpenId = signal<string | null>(null)
const DESKTOP = '(min-width: 1000px)'
const accounts = Boolean(import.meta.env.VITE_FEATHER_ACCOUNTS)
const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

export function App({ model }: { model: AppModel }) {
  const menu = useRef<HTMLButtonElement>(null)
  const library = useRef<HTMLElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const returnFocus = useRef(false)
  const open = drawerOpen.value

  const close = (focusMenu: boolean) => {
    returnFocus.current = focusMenu
    drawerOpen.value = false
  }

  // Runs after the DOM is updated: focus moves only once `inert` is set or lifted.
  useLayoutEffect(() => {
    if (!open) {
      if (returnFocus.current) menu.current?.focus()
      returnFocus.current = false
      return
    }
    library.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // At desktop width the library is a column again, so a drawer left open would only leave a scrim and an
  // inert page behind (an iPad turning to landscape).
  useEffect(() => {
    const desktop = matchMedia(DESKTOP)
    const onChange = () => {
      if (desktop.matches) close(false)
    }
    desktop.addEventListener('change', onChange)
    return () => desktop.removeEventListener('change', onChange)
  }, [])

  // A file dropped outside the note would replace the demo in the tab.
  useLayoutEffect(() => preventFileNavigation(), [])

  // Alt+N new note (browsers keep Ctrl/⌘+N), Ctrl/⌘+K search. A layout effect, so the keys work from the first
  // paint: a plain effect can run after the page has loaded and miss the first key press.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyN') {
        e.preventDefault()
        newNote()
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k' && !e.defaultPrevented) {
        // the note body takes Ctrl/⌘+K for a link and marks the event handled
        e.preventDefault()
        search.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const newNote = () => {
    model.newNote()
    phoneOpenId.value = model.openNote.value?.id ?? null
  }
  const phoneNote = phoneOpenId.value !== null && model.openNote.value?.id === phoneOpenId.value

  // While the drawer is open, everything behind the scrim is out of reach for keyboard and screen reader.
  return (
    <div class="page" data-phone-note={phoneNote ? 'true' : 'false'}>
      <div class="glow glow-mint" aria-hidden="true" />
      <div class="glow glow-peach" aria-hidden="true" />

      <header class="appbar" inert={open}>
        <button
          ref={menu}
          type="button"
          class="menu-button"
          aria-label="Open library"
          aria-expanded={open}
          aria-controls="library"
          onClick={() => (open ? close(true) : (drawerOpen.value = true))}
        >
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <h1 class="brand">
          <Logo size={28} />
          FeatherMark
        </h1>
        <label class="search">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" class="search-icon">
            <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M21 21l-5-5" />
          </svg>
          <input
            ref={search}
            type="search"
            aria-label="Search all notes"
            placeholder="Search all notes"
            value={model.searchText.value}
            onInput={(e) => model.searchAll(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                model.setSearch('')
                e.currentTarget.blur()
              }
            }}
          />
          <kbd>{isMac ? '⌘ K' : 'Ctrl K'}</kbd>
        </label>
      </header>

      <div class="demo-line" inert={open}>
        <p>This is a demo. Notes here aren't saved.</p>
        {accounts ? (
          <span class="demo-actions">
            <button type="button" class="link-button">
              Log in
            </button>
            <button type="button" class="link-button">
              Create account
            </button>
          </span>
        ) : (
          <a class="demo-link" href="https://feathermark.com/download" target="_blank" rel="noopener noreferrer">
            Get FeatherMark
          </a>
        )}
      </div>

      <div class="columns">
        {open && <div class="scrim" aria-hidden="true" onClick={() => close(true)} />}
        <nav id="library" ref={library} tabIndex={-1} aria-label="Library" class="panel library" data-open={open}>
          <LibraryPanel
            model={model}
            onNavigate={() => {
              phoneOpenId.value = null
              if (!matchMedia(DESKTOP).matches) close(false)
            }}
          />
        </nav>
        <section aria-label="Notes" class="panel notes" inert={open}>
          <NoteList model={model} onOpen={() => (phoneOpenId.value = model.openNote.value?.id ?? null)} onEnter={() => document.getElementById('note-body')?.focus()} />
        </section>
        <main class="panel editor" inert={open}>
          <EditorPane model={model} onBack={() => (phoneOpenId.value = null)} />
        </main>
      </div>

      <div class="bottombar" inert={open}>
        <button type="button" class="new-note-primary" onClick={newNote}>
          New note
        </button>
      </div>

      <UndoToast model={model} />
      <ErrorToast model={model} />
      <DialogHost />
    </div>
  )
}
