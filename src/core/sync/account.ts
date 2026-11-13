// Signup, sign-in, recovery, password change, devices and sign-out against one Feather Cloud (crypto.md "Account
// creation", "Password change"; sync-protocol.md "Accounts"). Ported from AccountService.swift; the messages are
// AccountFlows.swift's AccountCopy, word for word, in the web's sentence case (ui-copy.md "Security and recovery",
// "Web app" › "Accounts (Phase 20)").
//
// The web keeps no keychain: the password, root, keks and master key stay in the crypto worker, and what comes back
// (SignedIn) carries only the session handle, the token and the wrapped key the vault needs to unlock offline.
import type { KdfParams } from '../crypto/argon2.ts'
import { CryptoError } from '../crypto/errors.ts'
import type { CryptoClient } from '../../worker/crypto-client.ts'
import { ApiClient, ApiError, type CloudAccount, type CloudDevice } from './api.ts'
import { passwordLongEnough } from './password.ts'

export type AccountErrorKind =
  | 'wrongPassword'
  | 'recoveryKeyTypo'
  | 'wrongRecoveryKey'
  | 'emailUnverified'
  | 'codeInvalid'
  | 'codeExpired'
  | 'passwordTooShort'
  | 'rateLimited'
  | 'network'
  | 'server'
  | 'deviceTooWeak'

export class AccountError extends Error {
  override name = 'AccountError'
  constructor(
    readonly kind: AccountErrorKind,
    /** The server's error code, for `server`. */
    readonly code: string | null = null,
    /** Seconds from Retry-After, for `rateLimited`. */
    readonly retryAfter: number | null = null,
  ) {
    super(code ? `${kind}: ${code}` : kind)
  }
}

const MESSAGES: Record<AccountErrorKind, string> = {
  wrongPassword: "That password doesn't match. Forgot it? Sign in with your recovery key instead.",
  recoveryKeyTypo: 'That recovery key has a typo. Check each group and try again.',
  wrongRecoveryKey: "That recovery key doesn't match this account.",
  emailUnverified: "This account isn't verified yet. Finish creating it with the code we emailed you.",
  codeInvalid: "That code doesn't match. Check the email and try again.",
  codeExpired: 'That code has expired. Send a new one.',
  passwordTooShort: 'Use at least 10 characters.',
  rateLimited: 'Too many attempts. Wait a minute and try again.',
  network: "The server didn't respond.",
  server: 'Something went wrong on the server. Try again.',
  deviceTooWeak: "This device can't unlock FeatherMark in a browser. Use the Mac, iPhone or iPad app instead, or try the demo.",
}

/** The message a screen shows for a failed account action (AccountCopy.message). */
export function accountMessage(e: unknown): string {
  return e instanceof AccountError ? MESSAGES[e.kind] : 'Something went wrong. Try again.'
}

/** The password rule, in code points after NFC (AccountFlows.swift PasswordStrength). */
export { MIN_PASSWORD, passwordLongEnough } from './password.ts'

/** A signed-in account in this tab: the crypto session that holds its master key, its token, and what the vault keeps
 *  to unlock without the server (the password-wrapped master key, its salt and parameters). */
export type SignedIn = {
  email: string
  token: string
  deviceId: string
  libraryId: string
  account: CloudAccount
  session: number
  wrappedMasterPassword: Uint8Array
  salt: Uint8Array
  kdf: KdfParams
}

/** A recovery sign-in waiting for its new password: its token may only set a password. */
export type RecoveryHandle = { email: string; token: string; deviceId: string; session: number }

/** What a password change gives back: the new token and what the vault keeps to unlock with the new password. */
export type NewCredentials = { token: string; wrappedMasterPassword: Uint8Array; salt: Uint8Array; kdf: KdfParams }

/** Errors from the crypto worker that mean this browser can't do 256 MiB of Argon2id: a RangeError (a failed
 *  WebAssembly.Memory), or the worker dying of memory. */
export function tooWeak(e: unknown): boolean {
  if (e instanceof RangeError) return true
  if (!(e instanceof Error) || e instanceof CryptoError || e instanceof TypeError) return false
  return /^RangeError\b|out of memory|could not allocate|allocation failed|memory access out of bounds/i.test(e.message)
}

function mapped(e: unknown): unknown {
  if (e instanceof AccountError) return e
  if (tooWeak(e)) return new AccountError('deviceTooWeak')
  if (!(e instanceof ApiError)) return e
  if (e.status === 0) return new AccountError('network')
  if (e.code === 'email_unverified') return new AccountError('emailUnverified')
  if (e.code === 'verification_invalid') return new AccountError('codeInvalid')
  if (e.code === 'verification_expired') return new AccountError('codeExpired')
  if (e.status === 429) return new AccountError('rateLimited', null, e.retryAfter)
  return new AccountError('server', e.code)
}

async function guard<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body()
  } catch (e) {
    throw mapped(e)
  }
}

type Pending = { email: string; session: number; wrappedMasterPassword: Uint8Array; salt: Uint8Array; kdf: KdfParams }

export class AccountService {
  private readonly base: string
  private readonly fetchImpl: typeof fetch | undefined
  private readonly crypto: CryptoClient
  private signedIn: { email: string; token: string; session: number } | null = null
  private pending: Pending | null = null
  /** Sessions this service handed out (a verified signup, a recovery) that no tab has taken up with use() yet: their
   *  master key in the worker and their token on the server, so an abandoned screen can drop both. */
  private readonly loose = new Map<number, string>()

  constructor(o: { base: string; crypto: CryptoClient; fetch?: typeof fetch }) {
    this.base = o.base
    this.crypto = o.crypto
    this.fetchImpl = o.fetch
  }

  private client(token?: string): ApiClient {
    return new ApiClient({ base: this.base, ...(token === undefined ? {} : { token }), ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}) })
  }

  /** The account this service acts for, or null. */
  current(): { email: string; token: string; session: number } | null {
    return this.signedIn && { ...this.signedIn }
  }

  /** Acts for an account signed in earlier (an unlocked vault: a new session handle, the kept token). */
  use(s: { email: string; token: string; session: number }): void {
    this.loose.delete(s.session)
    this.signedIn = { ...s }
  }

  // ---- abandoned screens (create account left after step 2, recovery left before its new password)

  /** Drops a session nobody will use: its master key in the worker, and its token on the server (best effort; a
   *  failed logout leaves a token that expires on its own). */
  async discard(h: { session: number; token: string }): Promise<void> {
    this.loose.delete(h.session)
    if (this.signedIn?.session === h.session) this.signedIn = null
    await this.crypto.forget(h.session).catch(() => undefined)
    await this.client(h.token).logout().catch(() => undefined)
  }

  /** Drops a signup whose code was never verified: its master key in the worker. */
  async discardPending(): Promise<void> {
    const p = this.pending
    this.pending = null
    if (p) await this.crypto.forget(p.session).catch(() => undefined)
  }

  /** Drops everything handed out and not taken up: the pending signup and every loose session. */
  async discardLoose(): Promise<void> {
    await this.discardPending()
    await Promise.all([...this.loose].map(([session, token]) => this.discard({ session, token })))
  }

  // ---- signup

  /** Makes the keys in the worker and starts the signup. The recovery key text is for the screen only. */
  async startSignup(email: string, password: string, libraryId: string): Promise<{ recoveryText: string }> {
    if (!passwordLongEnough(password)) throw new AccountError('passwordTooShort')
    const keys = await guard(() => this.crypto.signUpKeys(password))
    try {
      await guard(() =>
        this.client().signup({
          email, salt: keys.salt, kdf: keys.kdf, authKey: keys.authKey, recoveryAuthKey: keys.recoveryAuthKey,
          wrappedMasterPassword: keys.wrappedPassword, wrappedMasterRecovery: keys.wrappedRecovery, libraryId,
        }),
      )
    } catch (e) {
      await this.crypto.forget(keys.session).catch(() => undefined)
      throw e
    }
    if (this.pending) await this.crypto.forget(this.pending.session).catch(() => undefined)
    this.pending = { email, session: keys.session, wrappedMasterPassword: keys.wrappedPassword, salt: keys.salt, kdf: keys.kdf }
    return { recoveryText: keys.recoveryText }
  }

  async resend(email: string): Promise<void> {
    await guard(() => this.client().resend(email))
  }

  async verify(email: string, code: string, deviceName: string): Promise<SignedIn> {
    const p = this.pending
    if (!p || p.email !== email) throw new AccountError('codeExpired')
    const r = await guard(() => this.client().verify({ email, code, deviceName }))
    this.pending = null
    this.signedIn = { email, token: r.token, session: p.session }
    this.loose.set(p.session, r.token)
    return { email, token: r.token, deviceId: r.deviceId, libraryId: r.account.libraryId, account: r.account, session: p.session, wrappedMasterPassword: p.wrappedMasterPassword, salt: p.salt, kdf: p.kdf }
  }

  // ---- sign-in and recovery

  async signIn(email: string, password: string, deviceName: string): Promise<SignedIn> {
    const pre = await guard(() => this.client().prelogin(email))
    const keys = await guard(() => this.crypto.logInKeys(password, pre.salt, pre.kdf))
    let r: Awaited<ReturnType<ApiClient['login']>>
    try {
      r = await this.client().login({ email, authKey: keys.authKey, deviceName })
    } catch (e) {
      await this.crypto.forget(keys.kek).catch(() => undefined)
      if (e instanceof ApiError && e.status === 401) throw new AccountError('wrongPassword')
      throw mapped(e)
    }
    let session: number
    try {
      ;({ session } = await this.crypto.unwrap(r.wrappedMasterPassword, keys.kek, 'password'))
    } catch {
      await this.crypto.forget(keys.kek).catch(() => undefined)
      throw new AccountError('wrongPassword')
    }
    this.signedIn = { email, token: r.token, session }
    return { email, token: r.token, deviceId: r.deviceId, libraryId: r.account.libraryId, account: r.account, session, wrappedMasterPassword: r.wrappedMasterPassword, salt: pre.salt, kdf: pre.kdf }
  }

  /** Reads the key first (a typo never reaches the server), then signs in with recovery scope. */
  async recover(email: string, recoveryText: string, deviceName: string): Promise<RecoveryHandle> {
    let keys: { recoveryAuthKey: Uint8Array; kek: number }
    try {
      keys = await this.crypto.recoveryKeys(recoveryText)
    } catch (e) {
      if (e instanceof CryptoError) throw new AccountError('recoveryKeyTypo')
      throw mapped(e)
    }
    let r: Awaited<ReturnType<ApiClient['recover']>>
    try {
      r = await this.client().recover({ email, recoveryAuthKey: keys.recoveryAuthKey, deviceName })
    } catch (e) {
      await this.crypto.forget(keys.kek).catch(() => undefined)
      if (e instanceof ApiError && e.status === 401) throw new AccountError('wrongRecoveryKey')
      throw mapped(e)
    }
    try {
      const { session } = await this.crypto.unwrap(r.wrappedMasterRecovery, keys.kek, 'recovery')
      this.loose.set(session, r.token)
      return { email, token: r.token, deviceId: r.deviceId, session }
    } catch {
      await this.crypto.forget(keys.kek).catch(() => undefined)
      throw new AccountError('wrongRecoveryKey')
    }
  }

  /** Sets the new password with the recovery token; every other session ends. */
  async finishRecovery(handle: RecoveryHandle, newPassword: string): Promise<SignedIn> {
    if (!passwordLongEnough(newPassword)) throw new AccountError('passwordTooShort')
    const keys = await guard(() => this.crypto.newPassword(handle.session, newPassword))
    const { token } = await guard(() => this.client(handle.token).setPassword({ salt: keys.salt, kdf: keys.kdf, authKey: keys.authKey, wrappedMasterPassword: keys.wrappedPassword }))
    // the recovery token is spent; the new one is loose until a tab takes it up
    this.loose.set(handle.session, token)
    const account = await guard(() => this.client(token).account())
    this.signedIn = { email: handle.email, token, session: handle.session }
    return { email: handle.email, token, deviceId: handle.deviceId, libraryId: account.libraryId, account, session: handle.session, wrappedMasterPassword: keys.wrappedPassword, salt: keys.salt, kdf: keys.kdf }
  }

  async changePassword(current: string, next: string): Promise<NewCredentials> {
    const me = this.requireSignedIn()
    if (!passwordLongEnough(next)) throw new AccountError('passwordTooShort')
    const currentAuthKey = await this.authKey(me.email, current)
    const keys = await guard(() => this.crypto.newPassword(me.session, next))
    let token: string
    try {
      ;({ token } = await this.client(me.token).setPassword({ currentAuthKey, salt: keys.salt, kdf: keys.kdf, authKey: keys.authKey, wrappedMasterPassword: keys.wrappedPassword }))
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) throw new AccountError('wrongPassword')
      throw mapped(e)
    }
    this.signedIn = { ...me, token }
    return { token, wrappedMasterPassword: keys.wrappedPassword, salt: keys.salt, kdf: keys.kdf }
  }

  // ---- account, devices, sign-out

  async account(): Promise<CloudAccount> {
    const me = this.requireSignedIn()
    return guard(() => this.client(me.token).account())
  }

  async devices(): Promise<CloudDevice[]> {
    const me = this.requireSignedIn()
    return guard(() => this.client(me.token).devices())
  }

  async revoke(deviceId: string): Promise<void> {
    const me = this.requireSignedIn()
    await guard(() => this.client(me.token).revokeDevice(deviceId))
  }

  /** Ends the session on the server if it can, and forgets it here in any case. The caller drops the crypto session. */
  async signOut(o?: { keepalive: boolean }): Promise<void> {
    const me = this.signedIn
    this.signedIn = null
    if (me) await this.client(me.token).logout(o).catch(() => undefined)
  }

  /** Forgets the account here without asking the server (after a 401). */
  forget(): void {
    this.signedIn = null
  }

  async deleteAccount(password: string): Promise<void> {
    const me = this.requireSignedIn()
    const authKey = await this.authKey(me.email, password)
    try {
      await this.client(me.token).deleteAccount(authKey)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) throw new AccountError('wrongPassword')
      throw mapped(e)
    }
    this.signedIn = null
  }

  // ---- helpers

  private requireSignedIn(): { email: string; token: string; session: number } {
    if (!this.signedIn) throw new AccountError('server', 'signed_out')
    return this.signedIn
  }

  /** The auth key for `password`: the server's salt and parameters, then Argon2id in the worker. The kek isn't kept. */
  private async authKey(email: string, password: string): Promise<Uint8Array> {
    const pre = await guard(() => this.client().prelogin(email))
    const keys = await guard(() => this.crypto.logInKeys(password, pre.salt, pre.kdf))
    await this.crypto.forget(keys.kek).catch(() => undefined)
    return keys.authKey
  }
}
