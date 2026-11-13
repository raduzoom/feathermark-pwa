// Signing in with the recovery key, then choosing a new password (SignInSheet.swift's recovery and new-password
// steps). Setting it ends every other session on the account; the recovery key stays the same.
import { useLayoutEffect, useRef } from 'preact/hooks'
import { ACCOUNT_COPY, strengthLabel, passwordStrength, type SignInFlow } from '../../model/account-flows.ts'
import { navigate } from '../router.ts'
import { AccountFrame, ErrorLine, Field, WorkingButton } from './Frame.tsx'

export function Recovery({ flow }: { flow: SignInFlow }) {
  const mode = flow.mode.value
  const first = useRef<HTMLInputElement | null>(null)
  useLayoutEffect(() => first.current?.focus(), [mode])
  const email = flow.email.value.trim()

  if (mode === 'newPassword') {
    const label = strengthLabel[passwordStrength(flow.newPassword.value)]
    return (
      <AccountFrame
        title="Choose a new password"
        onSubmit={() => void flow.setNewPassword()}
        buttons={
          <>
            <button type="button" class="button" onClick={() => navigate('/')}>
              Cancel
            </button>
            <WorkingButton title="Set password and sign in" workingTitle="Signing in…" working={flow.working.value} enabled={flow.newPasswordReady.value} />
          </>
        }
      >
        <p class="account-accepted">Recovery key accepted</p>
        <Field label="New password" type="password" autoComplete="new-password" value={flow.newPassword.value} onInput={(v) => (flow.newPassword.value = v)} inputRef={(el) => { first.current = el }} />
        {label && <p class="account-strength">{label}</p>}
        <Field label="Confirm new password" type="password" autoComplete="new-password" value={flow.confirmPassword.value} onInput={(v) => (flow.confirmPassword.value = v)} />
        <p class="account-meta">Your recovery key stays the same. Your other devices will ask for the new password the next time they sync.</p>
        <ErrorLine text={flow.error.value} />
      </AccountFrame>
    )
  }

  return (
    <AccountFrame
      title="Enter your recovery key"
      onSubmit={() => void flow.submitRecoveryKey()}
      buttons={
        <>
          <button type="button" class="button" disabled={flow.working.value} onClick={() => flow.back()}>
            Back
          </button>
          <WorkingButton title="Continue" workingTitle="Checking…" working={flow.working.value} enabled={flow.canSubmitRecoveryKey.value} />
        </>
      }
    >
      <p class="account-text">
        It's the 28-character key you saved when you set up Feather Cloud{email === '' ? '' : ` for ${email}`}. You can paste it all at once.
      </p>
      <Field label="Email" type="email" autoComplete="username" value={flow.email.value} onInput={(v) => (flow.email.value = v)} inputRef={(el) => { if (email === '') first.current = el }} />
      <Field
        label="Recovery key, 7 groups of 4"
        mono
        autoComplete="off"
        placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
        value={flow.recoveryText.value}
        onInput={(v) => (flow.recoveryText.value = v)}
        inputRef={(el) => { if (email !== '') first.current = el }}
      />
      <ErrorLine text={flow.error.value} />
      <p class="account-meta">{ACCOUNT_COPY.lostBoth}</p>
    </AccountFrame>
  )
}
