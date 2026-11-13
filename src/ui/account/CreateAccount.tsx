// Create account at /login?create: the five onboarding steps (OnboardingSheet.swift, in the web's sentence case),
// with the recovery key screen's fixed copy (ui-copy.md "Security and recovery"). Back stops at step 4: the account
// exists once the code is verified. The recovery key is shown on step 4 only, then forgotten.
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'
import { ACCOUNT_COPY, strengthLabel, type OnboardingFlow } from '../../model/account-flows.ts'
import { navigate } from '../router.ts'
import { AccountFrame, ErrorLine, Field, WorkingButton } from './Frame.tsx'

const TITLES = ['Your notes, on every device', 'Create your account', 'Check your email', ACCOUNT_COPY.recoveryTitle, "You're all set"]

export function CreateAccount({ flow }: { flow: OnboardingFlow }) {
  const step = flow.step.value
  const first = useRef<HTMLInputElement | null>(null)
  const setFirst = (el: HTMLInputElement | null) => {
    first.current = el
  }
  useLayoutEffect(() => first.current?.focus(), [step])
  useEffect(() => void flow.loadServer(), [flow])
  const working = flow.working.value
  const next = () => void flow.next()
  const email = flow.email.value.trim()

  let content
  let buttons
  switch (step) {
    case 1:
      content = (
        <>
          <p class="account-text">{ACCOUNT_COPY.encryption}</p>
          <ul class="account-bullets">
            {flow.introBullets.value.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <p class="account-meta">Takes about 2 minutes</p>
        </>
      )
      buttons = (
        <>
          <button type="button" class="button" onClick={() => navigate('/login')}>
            Log in…
          </button>
          <WorkingButton title="Create account" workingTitle="Create account" working={false} enabled />
        </>
      )
      break
    case 2: {
      const label = strengthLabel[flow.strength.value]
      content = (
        <>
          <Field label="Email" type="email" autoComplete="username" placeholder="you@example.com" value={flow.email.value} onInput={(v) => (flow.email.value = v)} inputRef={setFirst} />
          <Field label="Password" type="password" autoComplete="new-password" value={flow.password.value} onInput={(v) => (flow.password.value = v)} />
          <p class="account-hint">
            <span>{ACCOUNT_COPY.passwordHint}</span>
            {label && <strong class="account-strength">{label}</strong>}
          </p>
          <p class="account-meta">{ACCOUNT_COPY.passwordNote}</p>
          <ErrorLine text={flow.error.value} />
        </>
      )
      buttons = (
        <>
          <button type="button" class="button" disabled={working} onClick={() => navigate('/')}>
            Cancel
          </button>
          <WorkingButton title="Continue" workingTitle="Creating account…" working={working} enabled={flow.canContinue.value} />
        </>
      )
      break
    }
    case 3:
      content = (
        <>
          <p class="account-text">{ACCOUNT_COPY.verifySent(email)}</p>
          <Field label="Verification code" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={flow.code.value} onInput={(v) => (flow.code.value = v.trim())} inputRef={setFirst} />
          <p class="account-meta">
            Didn't get it? Check spam, or{' '}
            <button type="button" class="link-button" disabled={working} onClick={() => void flow.resend()}>
              Resend code
            </button>
          </p>
          <ErrorLine text={flow.error.value} />
        </>
      )
      buttons = (
        <>
          {flow.canGoBack.value && (
            <button type="button" class="button" onClick={() => flow.back()}>
              Back
            </button>
          )}
          <WorkingButton title="Verify email" workingTitle="Verifying…" working={working} enabled={flow.canContinue.value} />
        </>
      )
      break
    case 4:
      content = <RecoveryKeyStep flow={flow} />
      buttons = <WorkingButton title="Continue" workingTitle="Continue" working={working} enabled={flow.canContinue.value} />
      break
    default:
      content = (
        <>
          <p class="account-text">Your notes are being encrypted and uploaded now. You can keep writing while this runs.</p>
          <p class="account-subtitle">Next: add your other devices</p>
          <p class="account-text">Install FeatherMark on your Mac, iPhone, iPad, Windows PC or Android phone and sign in with {email}.</p>
        </>
      )
      buttons = <WorkingButton title="Start writing" workingTitle="Start writing" working={false} enabled submit={false} onClick={() => navigate('/', { replace: true })} />
  }

  return (
    <AccountFrame step={`Step ${step} of 5`} title={TITLES[step - 1]!} onSubmit={step === 5 ? undefined : next} buttons={buttons}>
      {content}
    </AccountFrame>
  )
}

/** The key, "Copy" and "Print…", and the box that lets Continue through. Printing shows only the key and its warning. */
function RecoveryKeyStep({ flow }: { flow: OnboardingFlow }) {
  const text = flow.recoveryText.value ?? ''
  return (
    <>
      <div class="recovery-sheet">
        <p class="recovery-print-title">FeatherMark recovery key</p>
        <p class="account-text">{ACCOUNT_COPY.recoveryBody}</p>
        <p class="recovery-key" aria-label={`Recovery key: ${text.split('-').join(', ')}`}>
          {text}
        </p>
      </div>
      <div class="account-actions">
        <button
          type="button"
          class="button"
          onClick={() => {
            void navigator.clipboard?.writeText(text).catch(() => undefined)
          }}
        >
          Copy
        </button>
        <button type="button" class="button" onClick={() => print()}>
          Print…
        </button>
      </div>
      <label class="account-check">
        <input type="checkbox" checked={flow.savedConfirmed.value} onChange={(e) => (flow.savedConfirmed.value = e.currentTarget.checked)} />
        <span>{ACCOUNT_COPY.recoveryConfirm}</span>
      </label>
      <ErrorLine text={flow.error.value} />
    </>
  )
}
