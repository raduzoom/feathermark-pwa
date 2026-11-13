// AccountService against the in-memory Feather Cloud, through the real ApiClient and the worker's real key store
// (Argon2id replaced by a fast stand-in; the real one is proved by argon2.test.ts). Ported from AccountService.swift
// and AccountFlows.swift (AccountCopy); Phase 20 Task 11's unit list.
import { describe, expect, test, vi } from 'vitest'
import { ARGON2_V1 } from '../../src/core/crypto/argon2.ts'
import { encodeRecoveryKey } from '../../src/core/crypto/recovery.ts'
import { WRAPPED_LENGTH } from '../../src/core/crypto/wrap.ts'
import { AccountError, AccountService, accountMessage } from '../../src/core/sync/account.ts'
import { createCryptoClient, type WorkerLike } from '../../src/worker/crypto-client.ts'
import type { CryptoRequest, CryptoResponse } from '../../src/worker/crypto-protocol.ts'
import { FakeCloud } from './support/fake-cloud.ts'
import { keyringCrypto } from './support/keyring-crypto.ts'

vi.mock('../../src/core/crypto/argon2.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/crypto/argon2.ts')>()
  const { fastDeriveRoot } = await import('./support/fast-argon2.ts')
  return { ...real, deriveRoot: fastDeriveRoot(real) }
})

const EMAIL = 'ada@example.com'
const PASSWORD = 'correct horse battery'
const LIBRARY = '01JC8ZQ6V4N1XG2H3K5M7P9R0T'
const DEVICE = 'Chrome on macOS'

function setup() {
  const cloud = new FakeCloud()
  const crypto = keyringCrypto()
  const service = new AccountService({ base: cloud.base, fetch: cloud.fetch, crypto: crypto.client })
  return { cloud, crypto, service }
}

/** Signs up and verifies an account; returns the recovery key text shown once. */
async function account(s: ReturnType<typeof setup>, password = PASSWORD) {
  const { recoveryText } = await s.service.startSignup(EMAIL, password, LIBRARY)
  const signedIn = await s.service.verify(EMAIL, s.cloud.codes.get(EMAIL)!, DEVICE)
  return { recoveryText, signedIn }
}

async function failure(p: Promise<unknown>): Promise<AccountError> {
  try {
    await p
  } catch (e) {
    if (e instanceof AccountError) return e
    throw e
  }
  throw new Error('expected an AccountError')
}

const b64len = (v: unknown) => Buffer.from(String(v), 'base64').length

test('signup sends what crypto.md "Account creation" lists, and never the password', async () => {
  const s = setup()
  const { recoveryText } = await s.service.startSignup(EMAIL, PASSWORD, LIBRARY)
  expect(recoveryText).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4})+$/)
  const signup = s.cloud.calls.find((c) => c.path === '/auth/signup')!
  const body = JSON.parse(signup.body!)
  expect(Object.keys(body).sort()).toEqual(['auth_key', 'email', 'kdf', 'library_id', 'recovery_auth_key', 'salt', 'wrapped_master_password', 'wrapped_master_recovery'])
  expect(body.email).toBe(EMAIL)
  expect(body.library_id).toBe(LIBRARY)
  expect(body.kdf).toEqual(ARGON2_V1)
  expect(b64len(body.salt)).toBe(16)
  expect(b64len(body.auth_key)).toBe(32)
  expect(b64len(body.recovery_auth_key)).toBe(32)
  expect(b64len(body.wrapped_master_password)).toBe(WRAPPED_LENGTH)
  expect(b64len(body.wrapped_master_recovery)).toBe(WRAPPED_LENGTH)
  expect(signup.token).toBeNull()

  const signedIn = await s.service.verify(EMAIL, s.cloud.codes.get(EMAIL)!, DEVICE)
  expect(signedIn).toMatchObject({ email: EMAIL, libraryId: LIBRARY, deviceId: expect.any(String), token: expect.any(String) })
  expect(signedIn.kdf).toEqual(ARGON2_V1)
  expect(Buffer.from(signedIn.wrappedMasterPassword).toString('base64')).toBe(body.wrapped_master_password)

  // nothing sent anywhere holds the password or the recovery key, in the URL or the body
  for (const c of s.cloud.calls) {
    for (const secret of [PASSWORD, recoveryText, recoveryText.replace(/-/g, '')]) {
      expect(c.url).not.toContain(secret)
      expect(c.body ?? '').not.toContain(secret)
    }
  }
})

test('verify: a wrong code, then the right one; without a signup in this tab the code has expired', async () => {
  const s = setup()
  await s.service.startSignup(EMAIL, PASSWORD, LIBRARY)
  const wrong = await failure(s.service.verify(EMAIL, '000000', DEVICE))
  expect(wrong.kind).toBe('codeInvalid')
  expect(accountMessage(wrong)).toBe("That code doesn't match. Check the email and try again.")
  await s.service.verify(EMAIL, s.cloud.codes.get(EMAIL)!, DEVICE)
  const other = new AccountService({ base: s.cloud.base, fetch: s.cloud.fetch, crypto: s.crypto.client })
  const expired = await failure(other.verify(EMAIL, '123456', DEVICE))
  expect(expired.kind).toBe('codeExpired')
  expect(accountMessage(expired)).toBe('That code has expired. Send a new one.')
})

test('wrong password, then the right one, then recovery', async () => {
  const s = setup()
  const { recoveryText } = await account(s)

  const wrong = await failure(s.service.signIn(EMAIL, 'not the password', DEVICE))
  expect(wrong.kind).toBe('wrongPassword')
  expect(accountMessage(wrong)).toBe("That password doesn't match. Forgot it? Sign in with your recovery key instead.")
  // the failed attempt's kek is dropped from the worker
  expect(s.crypto.held().keks).toBe(0)

  const right = await s.service.signIn(EMAIL, PASSWORD, DEVICE)
  expect(right.libraryId).toBe(LIBRARY)
  expect(s.cloud.tokens.has(right.token)).toBe(true)

  // a typo is caught before any request
  const before = s.cloud.calls.length
  const typo = recoveryText.slice(0, -1) + (recoveryText.endsWith('A') ? 'B' : 'A')
  const typoError = await failure(s.service.recover(EMAIL, typo, DEVICE))
  expect(typoError.kind).toBe('recoveryKeyTypo')
  expect(accountMessage(typoError)).toBe('That recovery key has a typo. Check each group and try again.')
  expect(s.cloud.calls.length).toBe(before)

  // a well-formed key of another account
  const otherKey = encodeRecoveryKey(new Uint8Array(16).fill(9))
  const wrongKey = await failure(s.service.recover(EMAIL, otherKey, DEVICE))
  expect(wrongKey.kind).toBe('wrongRecoveryKey')
  expect(accountMessage(wrongKey)).toBe("That recovery key doesn't match this account.")

  const handle = await s.service.recover(EMAIL, recoveryText, DEVICE)
  const short = await failure(s.service.finishRecovery(handle, 'too short'))
  expect(short.kind).toBe('passwordTooShort')
  expect(accountMessage(short)).toBe('Use at least 10 characters.')
  const recovered = await s.service.finishRecovery(handle, 'a brand new password')
  expect(recovered.libraryId).toBe(LIBRARY)
  // every other session ended
  expect(s.cloud.tokens.has(right.token)).toBe(false)
  expect((await failure(s.service.signIn(EMAIL, PASSWORD, DEVICE))).kind).toBe('wrongPassword')
  await expect(s.service.signIn(EMAIL, 'a brand new password', DEVICE)).resolves.toMatchObject({ email: EMAIL })
})

describe('the password must be 10 or more code points after NFC', () => {
  test.each([
    ['nine letters', 'abcdefghi', false],
    ['ten letters', 'abcdefghij', true],
    // 10 UTF-16 units, but five é after NFC
    ['e and a combining accent, five times', 'é'.repeat(5), false],
    // 18 UTF-16 units, nine code points
    ['nine emoji', '😀'.repeat(9), false],
    ['ten emoji', '😀'.repeat(10), true],
  ])('%s', async (_name, password, ok) => {
    const s = setup()
    const p = s.service.startSignup(EMAIL, password, LIBRARY)
    if (ok) {
      await expect(p).resolves.toMatchObject({ recoveryText: expect.any(String) })
    } else {
      expect((await failure(p)).kind).toBe('passwordTooShort')
      expect(s.cloud.calls).toEqual([])
      expect(s.crypto.calls).toEqual([])
    }
  })

  test('a new password after recovery, and a changed password, are held to it too', async () => {
    const s = setup()
    const { recoveryText } = await account(s)
    await s.service.signIn(EMAIL, PASSWORD, DEVICE)
    expect((await failure(s.service.changePassword(PASSWORD, 'short'))).kind).toBe('passwordTooShort')
    const handle = await s.service.recover(EMAIL, recoveryText, DEVICE)
    expect((await failure(s.service.finishRecovery(handle, 'é'.repeat(9)))).kind).toBe('passwordTooShort')
  })
})

test('change password: the current one is checked, and this tab keeps a working token', async () => {
  const s = setup()
  await account(s)
  await s.service.signIn(EMAIL, PASSWORD, DEVICE)
  expect((await failure(s.service.changePassword('not the password', 'another long password'))).kind).toBe('wrongPassword')
  const changed = await s.service.changePassword(PASSWORD, 'another long password')
  expect(s.cloud.tokens.has(changed.token)).toBe(true)
  expect(changed.wrappedMasterPassword.length).toBe(WRAPPED_LENGTH)
  await expect(s.service.devices()).resolves.toHaveLength(1)
  await expect(s.service.signIn(EMAIL, 'another long password', DEVICE)).resolves.toMatchObject({ email: EMAIL })
})

test('devices, revoke, sign out and delete account', async () => {
  const s = setup()
  await account(s)
  const second = new AccountService({ base: s.cloud.base, fetch: s.cloud.fetch, crypto: s.crypto.client })
  const other = await second.signIn(EMAIL, PASSWORD, 'Safari on iOS')
  const list = await s.service.devices()
  expect(list.map((d) => [d.name, d.current])).toEqual([[DEVICE, true], ['Safari on iOS', false]])
  await s.service.revoke(list[1]!.id)
  expect(s.cloud.tokens.has(other.token)).toBe(false)

  expect((await failure(s.service.deleteAccount('not the password'))).kind).toBe('wrongPassword')
  await s.service.deleteAccount(PASSWORD)
  expect(s.cloud.accounts.size).toBe(0)

  await account(s)
  const token = s.service.current()!.token
  await s.service.signOut()
  expect(s.cloud.tokens.has(token)).toBe(false)
  expect(s.service.current()).toBeNull()
})

test('an unverified signup, a network failure and too many attempts each have their message', async () => {
  const s = setup()
  await s.service.startSignup(EMAIL, PASSWORD, LIBRARY)
  const unverified = await failure(s.service.signIn(EMAIL, PASSWORD, DEVICE))
  expect(unverified.kind).toBe('emailUnverified')
  expect(accountMessage(unverified)).toBe("This account isn't verified yet. Finish creating it with the code we emailed you.")
  s.cloud.fail((c) => c.path === '/auth/prelogin', 'network')
  const offline = await failure(s.service.signIn(EMAIL, PASSWORD, DEVICE))
  expect(offline.kind).toBe('network')
  expect(accountMessage(offline)).toBe("The server didn't respond.")
  s.cloud.fail((c) => c.path === '/auth/prelogin', { status: 429, code: 'rate_limited', retryAfter: 30 })
  const limited = await failure(s.service.signIn(EMAIL, PASSWORD, DEVICE))
  expect(limited).toMatchObject({ kind: 'rateLimited', retryAfter: 30 })
  expect(accountMessage(limited)).toBe('Too many attempts. Wait a minute and try again.')
  s.cloud.fail((c) => c.path === '/auth/prelogin', { status: 500, code: 'server_error' })
  const server = await failure(s.service.signIn(EMAIL, PASSWORD, DEVICE))
  expect(server.kind).toBe('server')
  expect(accountMessage(server)).toBe('Something went wrong on the server. Try again.')
  expect(accountMessage(new Error('anything else'))).toBe('Something went wrong. Try again.')
})

/** A worker that answers Argon2id requests with what a browser without the memory gives. */
class WeakWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<CryptoResponse>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  onmessageerror: ((e: MessageEvent) => void) | null = null
  constructor(private readonly how: 'rangeError' | 'outOfMemory') {}
  postMessage(m: CryptoRequest) {
    queueMicrotask(() => {
      if (this.how === 'outOfMemory') this.onerror?.({ message: 'Out of memory' } as ErrorEvent)
      else this.onmessage?.({ data: { id: m.id, ok: false, name: 'RangeError', error: 'WebAssembly.Memory(): could not allocate memory' } } as MessageEvent<CryptoResponse>)
    })
  }
  terminate() {}
}

test.each(['rangeError', 'outOfMemory'] as const)('a device that can\'t run Argon2id shows "This device can\'t unlock…" (%s)', async (how) => {
  const cloud = new FakeCloud()
  const crypto = createCryptoClient({ worker: () => new WeakWorker(how) })
  const service = new AccountService({ base: cloud.base, fetch: cloud.fetch, crypto })
  const e = await failure(service.signIn(EMAIL, PASSWORD, DEVICE))
  expect(e.kind).toBe('deviceTooWeak')
  expect(accountMessage(e)).toBe("This device can't unlock FeatherMark in a browser. Use the Mac, iPhone or iPad app instead, or try the demo.")
  const signup = await failure(new AccountService({ base: cloud.base, fetch: cloud.fetch, crypto: createCryptoClient({ worker: () => new WeakWorker(how) }) }).startSignup(EMAIL, PASSWORD, LIBRARY))
  expect(signup.kind).toBe('deviceTooWeak')
})
