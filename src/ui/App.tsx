import { signal } from '@preact/signals'
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'
import { Logo } from './Logo.tsx'

const drawerOpen = signal(false)
const DESKTOP = '(min-width: 1000px)'

export function App() {
  const menu = useRef<HTMLButtonElement>(null)
  const library = useRef<HTMLElement>(null)
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

  // While the drawer is open, everything behind the scrim is out of reach for keyboard and screen reader.
  return (
    <div class="page">
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
      </header>

      <div class="columns">
        {open && <div class="scrim" aria-hidden="true" onClick={() => close(true)} />}
        <nav id="library" ref={library} tabIndex={-1} aria-label="Library" class="panel library" data-open={open}>
          <div class="library-top">
            <button type="button" class="new-note">
              New note
            </button>
          </div>
        </nav>
        <section aria-label="Notes" class="panel notes" inert={open} />
        <main class="panel editor" inert={open} />
      </div>

      <div class="bottombar" inert={open}>
        <button type="button" class="new-note-primary">
          New note
        </button>
      </div>
    </div>
  )
}
