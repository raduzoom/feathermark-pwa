// The locked tab (ui-copy.md "Web app" › "Accounts (Phase 20)"): the password unlocks from memory; after the server
// signed this browser out it asks to sign in again. Also the screen for a browser that can't run Argon2id.
import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import { lockedTitle } from '../../model/format.ts'
import type { SessionModel } from '../../model/session.ts'
import { DialogHost } from '../Dialog.tsx'
import { Logo } from '../Logo.tsx'
import { signOutAsking } from './AccountMenu.tsx'

/** The build's commit (VITE_FEATHER_BUILD_ID), or "dev" locally. */
const BUILD_ID = import.meta.env.VITE_FEATHER_BUILD_ID || 'dev'

export function Unlock({ session }: { session: SessionModel }) {
  const state = session.state.value
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => field.current?.focus(), [])

  const tryDemo = (
    <p class="account-footer">
      No account?{' '}
      <button type="button" class="link-button" onClick={() => signOutAsking(session, 'unlock')}>
        Try the demo.
      </button>
    </p>
  )
  const build = <p class="account-build">Build {BUILD_ID}</p>

  if (state.kind === 'unsupported') {
    return (
      <div class="account-screen">
        <div class="glow glow-mint" aria-hidden="true" />
        <div class="glow glow-peach" aria-hidden="true" />
        <main class="account-card">
          <p class="brand">
            <Logo size={28} />
            FeatherMark
          </p>
          <p role="alert" class="account-note">
            {session.message('deviceTooWeak')}
          </p>
          {tryDemo}
          {build}
        </main>
        <DialogHost screen="unlock" />
      </div>
    )
  }
  if (state.kind !== 'locked') return null

  // another tab owns the kept library: nothing to unlock here until "Use it here" takes it (no sign-out from here,
  // which would end the other tab's session and remove its copy)
  if (state.reason === 'otherTab') {
    return (
      <div class="account-screen">
        <div class="glow glow-mint" aria-hidden="true" />
        <div class="glow glow-peach" aria-hidden="true" />
        <main class="account-card">
          <p class="brand">
            <Logo size={28} />
            FeatherMark
          </p>
          <h1 class="account-title">{lockedTitle(state.email, state.reason)}</h1>
          <button
            type="button"
            class="button button-primary"
            disabled={working}
            onClick={async () => {
              setWorking(true)
              try {
                await session.takeOver()
              } catch (x) {
                setError(session.message(x))
              } finally {
                setWorking(false)
              }
            }}
          >
            Use it here
          </button>
          {error && (
            <p role="alert" class="account-error">
              {error}
            </p>
          )}
          {build}
        </main>
      </div>
    )
  }

  const submit = async (e: Event) => {
    e.preventDefault()
    if (password === '' || working) return
    setWorking(true)
    setError(null)
    try {
      await session.unlock(password)
    } catch (x) {
      setError(session.message(x))
      setWorking(false)
      field.current?.focus()
    }
  }

  return (
    <div class="account-screen">
      <div class="glow glow-mint" aria-hidden="true" />
      <div class="glow glow-peach" aria-hidden="true" />
      <main class="account-card">
        <p class="brand">
          <Logo size={28} />
          FeatherMark
        </p>
        <h1 class="account-title">{lockedTitle(state.email, state.reason)}</h1>
        {state.reason === 'signedOut' && <p class="account-note">Your changes in this tab are kept and will sync after you sign in.</p>}
        <form class="account-form" onSubmit={submit}>
          <label class="field">
            <span class="field-label">Password</span>
            <input
              ref={field}
              class="field-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onInput={(e) => {
                setPassword(e.currentTarget.value)
                setError(null)
              }}
            />
          </label>
          {error && (
            <p role="alert" class="account-error">
              {error}
            </p>
          )}
          <button type="submit" class="button button-primary" disabled={password === '' || working}>
            Unlock
          </button>
        </form>
        <p class="account-signed-in">
          Signed in as {state.email} ·{' '}
          <button type="button" class="link-button" onClick={() => signOutAsking(session, 'unlock')}>
            Sign out
          </button>
        </p>
        {tryDemo}
        {build}
      </main>
      <DialogHost screen="unlock" />
    </div>
  )
}
