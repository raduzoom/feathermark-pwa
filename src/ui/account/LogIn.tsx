// The log-in screen at /login (SignInSheet.swift's password step, in the web's sentence case). "Use recovery key
// instead" goes on to the recovery screens. Signed in, the app shows the account's notes (App.tsx).
import { useLayoutEffect, useRef } from 'preact/hooks'
import type { SignInFlow } from '../../model/account-flows.ts'
import { navigate } from '../router.ts'
import { AccountFrame, ErrorLine, Field, WorkingButton } from './Frame.tsx'
import { Recovery } from './Recovery.tsx'

export function LogIn({ flow }: { flow: SignInFlow }) {
  const mode = flow.mode.value
  const first = useRef<HTMLInputElement | null>(null)
  useLayoutEffect(() => first.current?.focus(), [mode])
  if (mode !== 'password') return <Recovery flow={flow} />
  return (
    <AccountFrame
      title="Log in"
      onSubmit={() => void flow.signIn()}
      buttons={
        <>
          <button type="button" class="link-button account-aside" onClick={() => flow.useRecoveryKey()}>
            Use recovery key instead
          </button>
          <button type="button" class="button" onClick={() => navigate('/')}>
            Cancel
          </button>
          <WorkingButton title="Log in" workingTitle="Logging in…" working={flow.working.value} enabled={flow.canSignIn.value} />
        </>
      }
    >
      <p class="account-text">Your notes will download and decrypt on this browser.</p>
      <Field label="Email" type="email" autoComplete="username" placeholder="you@example.com" value={flow.email.value} onInput={(v) => (flow.email.value = v)} inputRef={(el) => { first.current = el }} />
      <Field label="Password" type="password" autoComplete="current-password" value={flow.password.value} onInput={(v) => (flow.password.value = v)} />
      <ErrorLine text={flow.error.value} />
    </AccountFrame>
  )
}
