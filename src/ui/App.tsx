import { signal } from '@preact/signals'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'preact/hooks'
import type { Library } from '../core/library/library.ts'
import { newUlid } from '../core/ulid.ts'
import { systemClock } from '../core/clock.ts'
import { createOnboardingFlow, createSignInFlow } from '../model/account-flows.ts'
import type { AppModel } from '../model/app-model.ts'
import type { SessionModel } from '../model/session.ts'
import { currentSession, resuming, startSession } from '../model/session-host.ts'
import { AccountMenu } from './account/AccountMenu.tsx'
import { CreateAccount } from './account/CreateAccount.tsx'
import { LogIn } from './account/LogIn.tsx'
import { DemoNotesOffer } from './account/DemoNotesOffer.tsx'
import { closeSettings, SettingsSync } from './account/SettingsSync.tsx'
import { SyncLine } from './account/SyncLine.tsx'
import { Unlock } from './account/Unlock.tsx'
import { navigate, route } from './router.ts'
import { closeDialogsNotOn, DialogHost } from './Dialog.tsx'
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
/** Accounts are on in a build with VITE_FEATHER_CLOUD_URL; without it this is the plain demo. */
const accounts = Boolean(import.meta.env.VITE_FEATHER_CLOUD_URL)
const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

export function App({ model, demoLibrary }: { model: AppModel; demoLibrary: () => Library }) {
  const menu = useRef<HTMLButtonElement>(null)
  const library = useRef<HTMLElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const returnFocus = useRef(false)
  const open = drawerOpen.value
  const session = currentSession.value
  const account = session?.state.value ?? { kind: 'demo' as const }
  const where = route.value

  // The log-in and create-account screens' models, new each time their screen opens. They load the session (and with
  // it crypto and sync) only when first used.
  const start = () => startSession({ model, demoLibrary })
  const signIn = useMemo(() => (where === 'login' ? createSignInFlow({ session: start }) : null), [where])
  const onboarding = useMemo(() => (where === 'create' ? createOnboardingFlow({ session: start, libraryId: () => newUlid(systemClock) }) : null), [where])
  // a screen left (Cancel, Back, another route) drops what its flow held: an unfinished signup's or recovery's key in
  // the worker, and its session on the server
  useEffect(() => () => void signIn?.dispose(), [signIn])
  useEffect(() => () => void onboarding?.dispose(), [onboarding])
  const locked = session !== null && (account.kind === 'locked' || account.kind === 'unsupported')
  // the create-account screen stays up for its last step, after the account has opened
  const screen = locked
    ? 'unlock'
    : signIn && account.kind === 'demo'
      ? 'login'
      : onboarding && (account.kind === 'demo' || onboarding.step.value === 5)
        ? 'create'
        : 'app'
  /** The notes are on screen: only then may the app's shortcuts act. */
  const appShown = useRef(screen === 'app')
  appShown.current = screen === 'app'

  // Nothing readable after lock: a dialog, Settings or a menu opened over the notes goes when they do (locked by hand,
  // after idle time or a 401, or signed out), and doesn't come back after unlocking. The unlock screen's host never
  // shows an app dialog, even for the frame before this runs; menus and toasts leave with the notes' tree and the
  // model's library (setLibrary clears the error and Undo).
  useLayoutEffect(() => {
    closeDialogsNotOn(screen === 'app' ? 'app' : screen === 'unlock' ? 'unlock' : null)
    if (screen !== 'app') closeSettings()
  }, [screen])

  // Signed in (or out) from an account screen, or a screen opened that doesn't apply: back to the notes at "/".
  useLayoutEffect(() => {
    if (screen === 'app' && where !== 'app') navigate('/', { replace: true })
  }, [screen, where])
  const lastKind = useRef(account.kind)
  useLayoutEffect(() => {
    if (account.kind === 'demo' && lastKind.current !== 'demo' && where !== 'app') navigate('/', { replace: true })
    lastKind.current = account.kind
  }, [account.kind])

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
      // locked, a browser that can't unlock, or an account screen: the notes behind aren't there to act on
      if (!appShown.current) return
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

  // While signed in: activity holds off the idle lock, a hidden tab pushes at once, closing with unsynced changes
  // (Keep off) asks first, and a closed tab ends its session on the server.
  useLayoutEffect(() => {
    if (!session) return
    const active = () => session.noteActivity()
    const visibility = () => {
      if (document.visibilityState === 'hidden') session.pageHidden()
    }
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (!session.shouldWarnOnClose()) return
      e.preventDefault()
      e.returnValue = ''
    }
    const pageHide = (e: PageTransitionEvent) => session.pageClosing(e.persisted)
    // the connection came back (or went): sync now, so the status line and the offline banner say so at once
    const connection = () => session.syncNow()
    addEventListener('online', connection)
    addEventListener('offline', connection)
    const activity = ['keydown', 'pointerdown', 'touchstart', 'wheel'] as const
    for (const t of activity) document.addEventListener(t, active, { capture: true, passive: true })
    document.addEventListener('visibilitychange', visibility)
    addEventListener('beforeunload', beforeUnload)
    addEventListener('pagehide', pageHide)
    return () => {
      for (const t of activity) document.removeEventListener(t, active, { capture: true })
      document.removeEventListener('visibilitychange', visibility)
      removeEventListener('beforeunload', beforeUnload)
      removeEventListener('pagehide', pageHide)
      removeEventListener('online', connection)
      removeEventListener('offline', connection)
    }
  }, [session])

  const newNote = () => {
    model.newNote()
    phoneOpenId.value = model.openNote.value?.id ?? null
  }
  const phoneNote = phoneOpenId.value !== null && model.openNote.value?.id === phoneOpenId.value

  // Locked (or a browser that can't unlock): only the unlock screen; the notes, the editor and search are gone.
  if (screen === 'unlock') return <Unlock session={session!} />
  // still looking for a kept copy (a few milliseconds without one): neither the demo nor a log-in form yet
  if (resuming.value) return <div class="account-screen" aria-busy="true" />
  if (screen === 'login') return <LogIn flow={signIn!} />
  if (screen === 'create') return <CreateAccount flow={onboarding!} />

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
        {session && account.kind === 'unlocked' && <SyncLine session={session} />}
        {session && account.kind === 'unlocked' && <AccountMenu session={session} />}
      </header>

      {account.kind === 'demo' && (
        <div class="demo-line" inert={open}>
          <p>This is a demo. Notes here aren't saved.</p>
          {accounts ? (
            <span class="demo-actions">
              <button type="button" class="link-button" onClick={() => navigate('/login')}>
                Log in
              </button>
              <button type="button" class="link-button" onClick={() => navigate('/login?create')}>
                Create account
              </button>
            </span>
          ) : (
            <a class="demo-link" href="https://feathermark.com/download" target="_blank" rel="noopener noreferrer">
              Get FeatherMark
            </a>
          )}
        </div>
      )}

      {session && account.kind === 'unlocked' && session.tab.value === 'lost' && (
        <div class="tab-line" role="status" inert={open}>
          <p>FeatherMark is now open in another tab.</p>
          <button type="button" class="button button-primary" onClick={() => void session.takeOver().catch((e: unknown) => model.showError(session.message(e)))}>
            Use it here
          </button>
        </div>
      )}

      {session && account.kind === 'unlocked' && <OfflineBanner session={session} inert={open} />}

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
      {session && account.kind === 'unlocked' && session.tab.value === 'here' && <SettingsSync session={session} model={model} />}
      {session && account.kind === 'unlocked' && session.tab.value === 'here' && <DemoNotesOffer session={session} />}
      <DialogHost />
    </div>
  )
}

/** "Keep" off and offline: what is typed lives only in this tab (web design "The accepted limit of Keep off"). Its own
 *  component, so the sync status, which changes with every body that arrives, redraws only this, never the app. */
function OfflineBanner({ session, inert }: { session: SessionModel; inert: boolean }) {
  if (session.keep.value || session.status.value.kind !== 'offline') return null
  return (
    <div class="tab-line offline-line" role="status" inert={inert}>
      <p>You're offline. Changes are only in this tab until the connection is back.</p>
    </div>
  )
}
