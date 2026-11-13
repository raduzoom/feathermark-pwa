// The models behind the log-in, create-account and recovery screens, ported from AccountFlows.swift (OnboardingFlow,
// SignInFlow) with its fixed copy (AccountCopy; ui-copy.md "Security and recovery", in the web's sentence case). The
// screens only read these signals and call these actions.
//
// The session (and with it the crypto worker, the account service and the sync engine) loads only when a flow first
// needs it: `session()` is startSession, which import()s it. This module imports none of it at run time, so it sits
// in the demo's first load without any crypto or sync code (scripts/bundle-size.ts --check).
import { batch, computed, signal, type ReadonlySignal, type Signal } from '@preact/signals'
import { passwordStrength, type PasswordStrength } from '../core/sync/password.ts'
import type { RecoveryHandle, SignedIn } from '../core/sync/account.ts'
import type { SessionModel } from './session.ts'

export { passwordStrength, strengthLabel, type PasswordStrength } from '../core/sync/password.ts'

/** Fixed account copy, word for word (AccountCopy). */
export const ACCOUNT_COPY = {
  lostBoth: "Without your password or your recovery key, your notes can't be decrypted by anyone, including us.",
  encryption: "Your notes are encrypted on this device before they're uploaded. Only your devices can read them.",
  passwordNote: "We never see this password, so we can't reset it for you. In step 4 you'll get a recovery key as your backup.",
  passwordHint: 'Use 12 or more characters. A few random words work well.',
  recoveryTitle: 'Save your recovery key',
  recoveryBody:
    "This key is the only way back into your notes if you forget your password. Feather Cloud never sees your password or your notes, so we can't reset it for you. Print it or save it somewhere safe, away from this device.",
  recoveryConfirm: "I've saved my recovery key somewhere safe",
  verifySent: (email: string) => `We sent a 6-digit code to ${email}. It expires in 15 minutes.`,
} as const

/** The house fallback, for a failure before the session could even load. */
const FALLBACK = 'Something went wrong. Try again.'

type Deps = { session: () => Promise<SessionModel> }

/** Runs a flow's actions: `body` with `working` set, putting its failure's message in `error`. A call while one runs
 *  does nothing. `session()` is the session once an action has loaded it. */
function runner(working: Signal<boolean>, error: Signal<string | null>, deps: Deps) {
  let current: SessionModel | null = null
  const run = async (body: (s: SessionModel) => Promise<void>): Promise<void> => {
    if (working.value) return
    batch(() => {
      working.value = true
      error.value = null
    })
    try {
      current ??= await deps.session()
      await body(current)
    } catch (e) {
      error.value = current ? current.message(e) : FALLBACK
    } finally {
      working.value = false
    }
  }
  return { run, session: () => current }
}

const emailLooksValid = (email: string): boolean => {
  const parts = email.trim().split('@')
  return parts.length === 2 && parts[0] !== '' && parts[1]!.includes('.')
}

// ---- create account: five steps

export type OnboardingStep = 1 | 2 | 3 | 4 | 5

export type OnboardingFlow = {
  step: ReadonlySignal<OnboardingStep>
  email: Signal<string>
  password: Signal<string>
  code: Signal<string>
  savedConfirmed: Signal<boolean>
  /** Shown on step 4 only, then forgotten; never stored. */
  recoveryText: ReadonlySignal<string | null>
  working: ReadonlySignal<boolean>
  error: ReadonlySignal<string | null>
  strength: ReadonlySignal<PasswordStrength>
  canContinue: ReadonlySignal<boolean>
  /** Back stops at step 4: once the code is verified the account exists, and the code is spent. */
  canGoBack: ReadonlySignal<boolean>
  /** Step 1's promises; a server without billing makes no trial or payment promise. */
  introBullets: ReadonlySignal<string[]>
  /** Asks the server whether it bills (the intro's bullets). */
  loadServer(): Promise<void>
  next(): Promise<void>
  back(): void
  resend(): Promise<void>
  /** The screen is gone (left, cancelled or replaced): a signup not finished here drops its master key in the worker
   *  and, once verified, its session on the server. A finished one (step 5) is left alone. */
  dispose(): Promise<void>
}

export function createOnboardingFlow(deps: Deps & { libraryId: () => string }): OnboardingFlow {
  const step = signal<OnboardingStep>(1)
  const email = signal('')
  const password = signal('')
  const code = signal('')
  const savedConfirmed = signal(false)
  const recoveryText = signal<string | null>(null)
  const working = signal(false)
  const error = signal<string | null>(null)
  const billing = signal(false)
  const { run, session } = runner(working, error, deps)
  let pendingKey: string | null = null
  let signedIn: SignedIn | null = null
  let disposed = false

  const strength = computed(() => passwordStrength(password.value))
  const canContinue = computed(() => {
    if (working.value) return false
    switch (step.value) {
      case 2:
        return emailLooksValid(email.value) && strength.value !== 'tooShort'
      case 3:
        return /^[0-9]{6}$/.test(code.value)
      case 4:
        return savedConfirmed.value
      default:
        return true
    }
  })
  const trimmed = () => email.value.trim()

  return {
    step,
    email,
    password,
    code,
    savedConfirmed,
    recoveryText,
    working,
    error,
    strength,
    canContinue,
    canGoBack: computed(() => step.value > 1 && step.value < 4 && !working.value),
    introBullets: computed(() =>
      billing.value
        ? ['Mac, iPhone, iPad, Windows and Android', '14 days free, no card. 1 GB during the trial.', 'If you ever stop paying, nothing is deleted.']
        : ['Mac, iPhone, iPad, Windows and Android', 'Free during the first release.'],
    ),
    async loadServer() {
      try {
        billing.value = (await (await deps.session()).serverInfo()).billingEnabled
      } catch {
        // no answer: the plain bullets stay
      }
    },
    async next() {
      if (!canContinue.value) return
      error.value = null
      switch (step.value) {
        case 1:
          step.value = 2
          return
        case 2:
          return run(async (s) => {
            const started = await s.account().startSignup(trimmed(), password.value, deps.libraryId())
            if (disposed) return void (await s.account().discardPending())
            pendingKey = started.recoveryText
            step.value = 3
          })
        case 3:
          return run(async (s) => {
            const verified = await s.account().verify(trimmed(), code.value, s.deviceName())
            if (disposed) return void (await s.account().discard(verified))
            signedIn = verified
            batch(() => {
              password.value = ''
              recoveryText.value = pendingKey
              savedConfirmed.value = false
              step.value = 4
            })
            pendingKey = null
          })
        case 4:
          return run(async (s) => {
            // step 5 first: the screen stays up for it once the account opens behind it
            // and the account is no longer this flow's to drop: it's the session's from here
            const verified = signedIn
            signedIn = null
            step.value = 5
            try {
              if (verified) await s.begin(verified)
            } catch (e) {
              signedIn = verified
              step.value = 4
              throw e
            }
            recoveryText.value = null
          })
      }
    },
    back() {
      if (!(step.value > 1 && step.value < 4) || working.value) return
      error.value = null
      step.value = (step.value - 1) as OnboardingStep
    },
    resend() {
      return run(async (s) => s.account().resend(trimmed()))
    },
    async dispose() {
      if (disposed) return
      disposed = true
      pendingKey = null
      recoveryText.value = null
      const s = session()
      if (!s) return
      const verified = signedIn
      signedIn = null
      if (verified) await s.account().discard(verified)
      else if (step.value < 5) await s.account().discardPending()
    },
  }
}

// ---- log in, or the recovery key and a new password

export type SignInMode = 'password' | 'recoveryKey' | 'newPassword'

export type SignInFlow = {
  mode: ReadonlySignal<SignInMode>
  email: Signal<string>
  password: Signal<string>
  recoveryText: Signal<string>
  newPassword: Signal<string>
  confirmPassword: Signal<string>
  working: ReadonlySignal<boolean>
  error: ReadonlySignal<string | null>
  /** Signed in: the screen goes to the notes. */
  done: ReadonlySignal<boolean>
  canSignIn: ReadonlySignal<boolean>
  canSubmitRecoveryKey: ReadonlySignal<boolean>
  newPasswordReady: ReadonlySignal<boolean>
  signIn(): Promise<void>
  useRecoveryKey(): void
  /** From the recovery key back to the password. */
  back(): void
  submitRecoveryKey(): Promise<void>
  setNewPassword(): Promise<void>
  /** The screen is gone: a recovery not finished here drops its master key in the worker and logs its
   *  recovery-scope token out. */
  dispose(): Promise<void>
}

export function createSignInFlow(deps: Deps): SignInFlow {
  const mode = signal<SignInMode>('password')
  const email = signal('')
  const password = signal('')
  const recoveryText = signal('')
  const newPassword = signal('')
  const confirmPassword = signal('')
  const working = signal(false)
  const error = signal<string | null>(null)
  const done = signal(false)
  const { run, session } = runner(working, error, deps)
  let recovery: RecoveryHandle | null = null
  let disposed = false
  const trimmed = () => email.value.trim()

  const canSignIn = computed(() => !working.value && trimmed() !== '' && password.value !== '')
  const canSubmitRecoveryKey = computed(() => !working.value && trimmed() !== '' && recoveryText.value.trim() !== '')
  const newPasswordReady = computed(
    () => !working.value && passwordStrength(newPassword.value) !== 'tooShort' && newPassword.value === confirmPassword.value,
  )

  return {
    mode,
    email,
    password,
    recoveryText,
    newPassword,
    confirmPassword,
    working,
    error,
    done,
    canSignIn,
    canSubmitRecoveryKey,
    newPasswordReady,
    signIn() {
      if (!canSignIn.value) return Promise.resolve()
      return run(async (s) => {
        await s.logIn(trimmed(), password.value)
        batch(() => {
          password.value = ''
          done.value = true
        })
      })
    },
    useRecoveryKey() {
      batch(() => {
        error.value = null
        password.value = ''
        mode.value = 'recoveryKey'
      })
    },
    back() {
      if (working.value || mode.value !== 'recoveryKey') return
      batch(() => {
        error.value = null
        mode.value = 'password'
      })
    },
    submitRecoveryKey() {
      if (!canSubmitRecoveryKey.value) return Promise.resolve()
      return run(async (s) => {
        const handle = await s.account().recover(trimmed(), recoveryText.value, s.deviceName())
        if (disposed) return void (await s.account().discard(handle))
        recovery = handle
        batch(() => {
          recoveryText.value = ''
          mode.value = 'newPassword'
        })
      })
    },
    setNewPassword() {
      const handle = recovery
      if (!handle || !newPasswordReady.value) return Promise.resolve()
      return run(async (s) => {
        const signedIn = await s.account().finishRecovery(handle, newPassword.value)
        recovery = null
        if (disposed) return void (await s.account().discard(signedIn))
        await s.begin(signedIn)
        batch(() => {
          newPassword.value = ''
          confirmPassword.value = ''
          done.value = true
        })
      })
    },
    async dispose() {
      if (disposed) return
      disposed = true
      batch(() => {
        recoveryText.value = ''
        password.value = ''
        newPassword.value = ''
        confirmPassword.value = ''
      })
      const handle = recovery
      recovery = null
      if (handle) await session()?.account().discard(handle)
    },
  }
}
