// The log-in, create-account and recovery screens' models (Phase 20 Task 11), ported from AccountFlows.swift
// (OnboardingFlow, SignInFlow, PasswordStrength, AccountCopy). Against the in-memory Feather Cloud through a real
// session model, the real ApiClient and the worker's real key store (Argon2id replaced by a fast stand-in).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { encodeRecoveryKey } from '../../src/core/crypto/recovery.ts'
import { Library } from '../../src/core/library/library.ts'
import { seedSampleLibrary } from '../../src/core/library/sample.ts'
import { AccountService } from '../../src/core/sync/account.ts'
import {
  ACCOUNT_COPY,
  createOnboardingFlow,
  createSignInFlow,
  passwordStrength,
  strengthLabel,
} from '../../src/model/account-flows.ts'
import { createAppModel } from '../../src/model/app-model.ts'
import { createSession, type SessionModel } from '../../src/model/session.ts'
import { fakeClock } from './support/clock.ts'
import { FakeCloud } from './support/fake-cloud.ts'
import { keyringCrypto } from './support/keyring-crypto.ts'
import { fakeTimers } from './support/timers.ts'

vi.mock('../../src/core/crypto/argon2.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/crypto/argon2.ts')>()
  const { fastDeriveRoot } = await import('./support/fast-argon2.ts')
  return { ...real, deriveRoot: fastDeriveRoot(real) }
})

const EMAIL = 'ada@example.com'
const PASSWORD = 'correct horse battery'
const LIBRARY = '01JC8ZQ6V4N1XG2H3K5M7P9R0T'

beforeEach(() => void vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined))
afterEach(() => vi.restoreAllMocks())

const settle = async () => {
  for (let i = 0; i < 100; i++) await new Promise((r) => setImmediate(r))
}

/** A tab in the demo whose session starts only when a flow first needs it (as startSession does). */
function setup(cloud = new FakeCloud()) {
  const clock = fakeClock()
  const timers = fakeTimers(clock)
  const demo = () => {
    const lib = new Library(clock)
    seedSampleLibrary(lib, clock)
    return lib
  }
  const model = createAppModel(demo(), { clock, setTimer: timers })
  let session: SessionModel | null = null
  let started = 0
  const crypto = keyringCrypto()
  const start = async () => {
    started++
    return (session ??= createSession({
      model, cloudOrigin: 'https://cloud.test', fetch: cloud.fetch, clock, timers, random: () => 0.5, deviceName: 'Chrome on macOS',
      crypto: () => crypto.client, demoLibrary: demo,
    }))
  }
  return { cloud, model, crypto, start, session: () => session!, started: () => started, libraryId: () => LIBRARY }
}

/** An account made elsewhere (the Mac); returns its recovery key. */
async function existingAccount(cloud: FakeCloud) {
  const service = new AccountService({ base: cloud.base, fetch: cloud.fetch, crypto: keyringCrypto().client })
  const { recoveryText } = await service.startSignup(EMAIL, PASSWORD, LIBRARY)
  const signedIn = await service.verify(EMAIL, cloud.codes.get(EMAIL)!, 'Mac')
  return { recoveryText, token: signedIn.token }
}

describe('password strength (PasswordStrength)', () => {
  test('code points after NFC: under 10 too short, then fair, good from 12, strong from 16', () => {
    expect(passwordStrength('a'.repeat(9))).toBe('tooShort')
    expect(passwordStrength('a'.repeat(10))).toBe('fair')
    expect(passwordStrength('a'.repeat(12))).toBe('good')
    expect(passwordStrength('a'.repeat(16))).toBe('strong')
    // "é" as e + combining accent is one code point after NFC
    expect(passwordStrength('é'.repeat(9))).toBe('tooShort')
    expect(passwordStrength('😀'.repeat(10))).toBe('fair')
    expect([strengthLabel.tooShort, strengthLabel.fair, strengthLabel.good, strengthLabel.strong]).toEqual([null, 'Fair', 'Good', 'Strong'])
  })

  test('fixed copy, word for word (ui-copy.md "Security and recovery", AccountCopy)', () => {
    expect(ACCOUNT_COPY.recoveryTitle).toBe('Save your recovery key')
    expect(ACCOUNT_COPY.recoveryBody).toBe(
      "This key is the only way back into your notes if you forget your password. Feather Cloud never sees your password or your notes, so we can't reset it for you. Print it or save it somewhere safe, away from this device.",
    )
    expect(ACCOUNT_COPY.recoveryConfirm).toBe("I've saved my recovery key somewhere safe")
    expect(ACCOUNT_COPY.lostBoth).toBe("Without your password or your recovery key, your notes can't be decrypted by anyone, including us.")
    expect(ACCOUNT_COPY.encryption).toBe("Your notes are encrypted on this device before they're uploaded. Only your devices can read them.")
    expect(ACCOUNT_COPY.passwordNote).toBe("We never see this password, so we can't reset it for you. In step 4 you'll get a recovery key as your backup.")
    expect(ACCOUNT_COPY.passwordHint).toBe('Use 12 or more characters. A few random words work well.')
    expect(ACCOUNT_COPY.verifySent(EMAIL)).toBe(`We sent a 6-digit code to ${EMAIL}. It expires in 15 minutes.`)
  })
})

describe('create account (OnboardingFlow)', () => {
  test('five steps: intro, email and password, the code, the recovery key, done; then the account is open', async () => {
    const s = setup()
    const flow = createOnboardingFlow({ session: s.start, libraryId: s.libraryId })
    expect(flow.step.value).toBe(1)
    // nothing is asked of the server before the intro's button
    expect(s.cloud.calls).toEqual([])
    await flow.next()
    expect(flow.step.value).toBe(2)

    // email and password
    expect(flow.canContinue.value).toBe(false)
    flow.email.value = ' ada@example.com '
    flow.password.value = 'short'
    expect(flow.strength.value).toBe('tooShort')
    expect(flow.canContinue.value).toBe(false)
    flow.password.value = PASSWORD
    expect(flow.strength.value).toBe('strong')
    expect(flow.canContinue.value).toBe(true)
    flow.email.value = 'not an email'
    expect(flow.canContinue.value).toBe(false)
    flow.email.value = ' ada@example.com '
    await flow.next()
    expect(flow.error.value).toBeNull()
    expect(flow.step.value).toBe(3)
    expect(s.cloud.calls.map((c) => c.path)).toContain('/auth/signup')
    expect(JSON.parse(s.cloud.calls.find((c) => c.path === '/auth/signup')!.body!).email).toBe(EMAIL)
    expect(flow.canGoBack.value).toBe(true)

    // the code
    flow.code.value = '12345'
    expect(flow.canContinue.value).toBe(false)
    flow.code.value = '000000'
    await flow.next()
    expect(flow.error.value).toBe("That code doesn't match. Check the email and try again.")
    expect(flow.step.value).toBe(3)
    flow.code.value = s.cloud.codes.get(EMAIL)!
    await flow.next()
    expect(flow.step.value).toBe(4)
    // the password isn't kept once the account exists
    expect(flow.password.value).toBe('')

    // the recovery key: shown once; Back stops here; Continue waits for the box
    expect(flow.recoveryText.value).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){6}$/)
    expect(flow.canGoBack.value).toBe(false)
    flow.back()
    expect(flow.step.value).toBe(4)
    expect(flow.canContinue.value).toBe(false)
    flow.savedConfirmed.value = true
    expect(flow.canContinue.value).toBe(true)
    expect(s.session().state.value.kind).toBe('demo')
    await flow.next()

    // done: the key is forgotten, the account is open in this tab
    expect(flow.step.value).toBe(5)
    expect(flow.recoveryText.value).toBeNull()
    expect(s.session().state.value).toEqual({ kind: 'unlocked', email: EMAIL })
    expect(flow.canGoBack.value).toBe(false)
  })

  test('Back from steps 2 and 3, never from 1', async () => {
    const s = setup()
    const flow = createOnboardingFlow({ session: s.start, libraryId: s.libraryId })
    expect(flow.canGoBack.value).toBe(false)
    await flow.next()
    flow.back()
    expect(flow.step.value).toBe(1)
  })

  test('a second Continue while the first is running sends nothing more', async () => {
    const s = setup()
    const flow = createOnboardingFlow({ session: s.start, libraryId: s.libraryId })
    await flow.next()
    flow.email.value = EMAIL
    flow.password.value = PASSWORD
    const first = flow.next()
    expect(flow.working.value).toBe(true)
    expect(flow.canContinue.value).toBe(false)
    const second = flow.next()
    await Promise.all([first, second])
    expect(s.cloud.calls.filter((c) => c.path === '/auth/signup')).toHaveLength(1)
    expect(flow.step.value).toBe(3)
    expect(flow.working.value).toBe(false)
  })

  test('a password under 10 code points never reaches the server', async () => {
    const s = setup()
    const flow = createOnboardingFlow({ session: s.start, libraryId: s.libraryId })
    await flow.next()
    flow.email.value = EMAIL
    flow.password.value = 'é'.repeat(9)
    await flow.next()
    expect(flow.step.value).toBe(2)
    expect(s.cloud.calls).toEqual([])
  })

  test('Resend code asks the server again; a failure shows its message', async () => {
    const s = setup()
    const flow = createOnboardingFlow({ session: s.start, libraryId: s.libraryId })
    await flow.next()
    flow.email.value = EMAIL
    flow.password.value = PASSWORD
    await flow.next()
    await flow.resend()
    expect(s.cloud.calls.filter((c) => c.path === '/auth/resend')).toHaveLength(1)
    s.cloud.fail((c) => c.path === '/auth/resend', { status: 429, code: 'rate_limited', retryAfter: 60 })
    await flow.resend()
    expect(flow.error.value).toBe('Too many attempts. Wait a minute and try again.')
  })

  test('the intro promises a trial only when the server bills', async () => {
    const plain = setup()
    const flow = createOnboardingFlow({ session: plain.start, libraryId: plain.libraryId })
    expect(flow.introBullets.value).toEqual(['Mac, iPhone, iPad, Windows and Android', 'Free during the first release.'])
    const billed = new FakeCloud()
    billed.billingEnabled = true
    const b = setup(billed)
    const flow2 = createOnboardingFlow({ session: b.start, libraryId: b.libraryId })
    await flow2.loadServer()
    expect(flow2.introBullets.value).toEqual([
      'Mac, iPhone, iPad, Windows and Android',
      '14 days free, no card. 1 GB during the trial.',
      'If you ever stop paying, nothing is deleted.',
    ])
    // a server that doesn't answer leaves the plain bullets
    const down = new FakeCloud()
    down.fail(() => true, 'network', 10)
    const d = setup(down)
    const flow3 = createOnboardingFlow({ session: d.start, libraryId: d.libraryId })
    await flow3.loadServer()
    expect(flow3.introBullets.value).toEqual(['Mac, iPhone, iPad, Windows and Android', 'Free during the first release.'])
  })
})

describe('log in and recovery (SignInFlow)', () => {
  test('wrong password, then the right one: the message word for word, then the account is open', async () => {
    const s = setup()
    await existingAccount(s.cloud)
    const flow = createSignInFlow({ session: s.start })
    expect(flow.canSignIn.value).toBe(false)
    flow.email.value = ` ${EMAIL} `
    flow.password.value = 'not the password'
    expect(flow.canSignIn.value).toBe(true)
    await flow.signIn()
    expect(flow.error.value).toBe("That password doesn't match. Forgot it? Sign in with your recovery key instead.")
    expect(flow.done.value).toBe(false)
    flow.password.value = PASSWORD
    await flow.signIn()
    expect(flow.error.value).toBeNull()
    expect(flow.done.value).toBe(true)
    expect(flow.password.value).toBe('')
    expect(s.session().state.value).toEqual({ kind: 'unlocked', email: EMAIL })
  })

  test('a second Log in while the first is running sends nothing more', async () => {
    const s = setup()
    await existingAccount(s.cloud)
    const before = s.cloud.calls.length
    const flow = createSignInFlow({ session: s.start })
    flow.email.value = EMAIL
    flow.password.value = PASSWORD
    const first = flow.signIn()
    expect(flow.working.value).toBe(true)
    expect(flow.canSignIn.value).toBe(false)
    await Promise.all([first, flow.signIn()])
    expect(s.cloud.calls.slice(before).filter((c) => c.path === '/auth/prelogin')).toHaveLength(1)
    expect(flow.error.value).toBeNull()
    expect(flow.done.value).toBe(true)
  })

  test('recovery: a typo is caught before any request, a wrong key says so, the right one sets a new password', async () => {
    const s = setup()
    const { recoveryText, token: macToken } = await existingAccount(s.cloud)
    const flow = createSignInFlow({ session: s.start })
    flow.email.value = EMAIL
    flow.password.value = 'not the password'
    await flow.signIn()
    flow.useRecoveryKey()
    expect(flow.mode.value).toBe('recoveryKey')
    expect(flow.error.value).toBeNull()

    const before = s.cloud.calls.length
    flow.recoveryText.value = recoveryText.slice(0, -1) + (recoveryText.endsWith('A') ? 'B' : 'A')
    await flow.submitRecoveryKey()
    expect(flow.error.value).toBe('That recovery key has a typo. Check each group and try again.')
    expect(s.cloud.calls.length).toBe(before)

    flow.recoveryText.value = encodeRecoveryKey(new Uint8Array(16).fill(9))
    await flow.submitRecoveryKey()
    expect(flow.error.value).toBe("That recovery key doesn't match this account.")
    expect(flow.mode.value).toBe('recoveryKey')

    flow.recoveryText.value = recoveryText.toLowerCase()
    await flow.submitRecoveryKey()
    expect(flow.error.value).toBeNull()
    expect(flow.mode.value).toBe('newPassword')
    expect(flow.recoveryText.value).toBe('')

    // the new password: 10 or more code points, typed twice the same
    flow.newPassword.value = 'too short'
    flow.confirmPassword.value = 'too short'
    expect(flow.newPasswordReady.value).toBe(false)
    flow.newPassword.value = 'a brand new password'
    flow.confirmPassword.value = 'a brand new passwor'
    expect(flow.newPasswordReady.value).toBe(false)
    flow.confirmPassword.value = 'a brand new password'
    expect(flow.newPasswordReady.value).toBe(true)
    await flow.setNewPassword()
    expect(flow.error.value).toBeNull()
    expect(flow.done.value).toBe(true)
    expect(flow.newPassword.value).toBe('')
    expect(flow.confirmPassword.value).toBe('')
    expect(s.session().state.value).toEqual({ kind: 'unlocked', email: EMAIL })
    // the Mac was signed out by the new password
    expect(s.cloud.tokens.has(macToken)).toBe(false)
    await settle()
  })

  test('Back from the recovery key returns to the password', async () => {
    const s = setup()
    const flow = createSignInFlow({ session: s.start })
    flow.useRecoveryKey()
    flow.back()
    expect(flow.mode.value).toBe('password')
    expect(s.started()).toBe(0)
  })
})

describe('an abandoned flow leaves no key in the worker and no session on the server', () => {
  const nothingHeld = { sessions: 0, keks: 0 }
  const loggedOut = (s: ReturnType<typeof setup>, token: string) =>
    expect(s.cloud.calls.some((c) => c.path === '/auth/logout' && c.token === token)).toBe(true)

  /** Create account up to `step` (3: the code was sent; 4: the code was verified). */
  async function onboardingAt(step: 3 | 4) {
    const s = setup()
    const flow = createOnboardingFlow({ session: s.start, libraryId: s.libraryId })
    await flow.next()
    flow.email.value = EMAIL
    flow.password.value = PASSWORD
    await flow.next()
    if (step === 4) {
      flow.code.value = s.cloud.codes.get(EMAIL)!
      await flow.next()
    }
    expect(flow.step.value).toBe(step)
    expect(s.crypto.held().sessions).toBe(1)
    return { s, flow }
  }

  test('create account left at step 3 (the code sent): dispose forgets the new master key', async () => {
    const { s, flow } = await onboardingAt(3)
    await flow.dispose()
    expect(s.crypto.held()).toEqual(nothingHeld)
  })

  test('create account left at step 4 (the code verified): dispose forgets the key and ends the new session', async () => {
    const { s, flow } = await onboardingAt(4)
    const token = [...s.cloud.tokens][0]!
    await flow.dispose()
    expect(s.crypto.held()).toEqual(nothingHeld)
    loggedOut(s, token)
    expect(s.cloud.tokens.size).toBe(0)
    expect(s.session().state.value.kind).toBe('demo')
  })

  test('a code verified after the screen was left is thrown away as it arrives', async () => {
    const s = setup()
    const flow = createOnboardingFlow({ session: s.start, libraryId: s.libraryId })
    await flow.next()
    flow.email.value = EMAIL
    flow.password.value = PASSWORD
    await flow.next()
    flow.code.value = s.cloud.codes.get(EMAIL)!
    const verifying = flow.next()
    const disposed = flow.dispose()
    await Promise.all([verifying, disposed])
    await settle()
    expect(s.crypto.held()).toEqual(nothingHeld)
    expect(s.cloud.tokens.size).toBe(0)
    expect(flow.recoveryText.value).toBeNull()
  })

  test('a finished create account keeps its account open after dispose', async () => {
    const { s, flow } = await onboardingAt(4)
    flow.savedConfirmed.value = true
    await flow.next()
    expect(flow.step.value).toBe(5)
    await flow.dispose()
    expect(s.session().state.value.kind).toBe('unlocked')
    expect(s.crypto.held().sessions).toBe(1)
    expect(s.cloud.tokens.size).toBe(1)
  })

  /** Log in, then the recovery key accepted: a recovery-scope session waits for its new password. */
  async function recoveryAccepted() {
    const s = setup()
    const { recoveryText, token: macToken } = await existingAccount(s.cloud)
    const flow = createSignInFlow({ session: s.start })
    flow.email.value = EMAIL
    flow.useRecoveryKey()
    flow.recoveryText.value = recoveryText
    await flow.submitRecoveryKey()
    expect(flow.mode.value).toBe('newPassword')
    expect(s.crypto.held().sessions).toBe(1)
    expect(s.cloud.recoveryTokens.size).toBe(1)
    return { s, flow, macToken }
  }

  test('Cancel on "Choose a new password": dispose forgets the key and logs the recovery token out', async () => {
    const { s, flow, macToken } = await recoveryAccepted()
    const token = [...s.cloud.recoveryTokens][0]!
    await flow.dispose()
    expect(s.crypto.held()).toEqual(nothingHeld)
    loggedOut(s, token)
    expect(s.cloud.recoveryTokens.size).toBe(0)
    // the Mac's own session is untouched
    expect(s.cloud.tokens.has(macToken)).toBe(true)
  })

  test('offline, dispose still forgets the key', async () => {
    const { s, flow } = await recoveryAccepted()
    s.cloud.fail(() => true, 'network', 10)
    await flow.dispose()
    expect(s.crypto.held()).toEqual(nothingHeld)
  })

  test('a flow that was never disposed: logging in and locking forgets its key and ends its token', async () => {
    const { s, flow } = await recoveryAccepted()
    const token = [...s.cloud.recoveryTokens][0]!
    void flow
    await s.session().logIn(EMAIL, PASSWORD)
    await settle()
    await s.session().lock('manual')
    await settle()
    expect(s.crypto.held()).toEqual(nothingHeld)
    loggedOut(s, token)
  })

  test('a flow that was never disposed: signing out forgets its key and ends its token', async () => {
    const { s } = await onboardingAt(4)
    const token = [...s.cloud.tokens][0]!
    await s.session().signOut()
    await settle()
    expect(s.crypto.held()).toEqual(nothingHeld)
    loggedOut(s, token)
  })
})
