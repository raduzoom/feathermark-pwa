// An in-memory Feather Cloud for the sync engine's tests (sync-protocol.md "Push" rules 1–7, "Pull", "Blobs",
// "Quota", plan states, 401). It serves the real ApiClient through a fake `fetch`, so the engine is tested through
// the client it ships with. No network. The rule order follows the Go server (internal/items/items.go apply).
import { createHash } from 'node:crypto'
import { open, seal } from '../../../src/core/crypto/envelope.ts'
import { CryptoError } from '../../../src/core/crypto/errors.ts'
import { itemKey } from '../../../src/core/crypto/kdf.ts'
import type { ItemType } from '../../../src/core/sync/codec.ts'
import type { CryptoClient } from '../../../src/worker/crypto-client.ts'
import type { OpenResult } from '../../../src/worker/crypto-protocol.ts'

export type StoredItem = { id: string; type: ItemType; version: number; seq: number; deleted: boolean; meta: Uint8Array | null; blobSha: string | null; updatedAt: string }
/** One request the cloud saw. `changes` is set for a push; `url` and `body` are exactly what was sent. */
export type Call = { method: string; path: string; token: string | null; url: string; body: string | null; changes?: Array<{ id: string; type: ItemType; baseVersion: number; deleted: boolean }> }
/** An account on the fake cloud (sync-protocol.md "Accounts"): what signup stored, and its hashed auth keys. */
export type FakeAccount = {
  email: string; libraryId: string; salt: string; kdf: unknown; authHash: string; recoveryHash: string
  wrappedPassword: string; wrappedRecovery: string; verified: boolean
}
const PUBLIC = new Set(['/auth/prelogin', '/auth/signup', '/auth/verify', '/auth/resend', '/auth/login', '/auth/recover'])
export type Failure = 'network' | { status: number; code: string; retryAfter?: number }

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'))
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const cursor = (seq: number) => `c_${String(seq).padStart(12, '0')}`
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const error = (status: number, code: string, headers: Record<string, string> = {}) => json(status, { error: { code, message: code } }, headers)

export class FakeCloud {
  readonly base = 'https://cloud.test/v1'
  /** The one library this fake serves; a verified signup replaces it with the account's own. */
  libraryId = '01JC8ZN0AB1CD2EF3GH4JK5MN6'
  /** Accounts by email, and the verification code the fake "emailed" to each pending signup. */
  readonly accounts = new Map<string, FakeAccount>()
  readonly codes = new Map<string, string>()
  /** Tokens of recovery scope: they may only set a password or log out. */
  readonly recoveryTokens = new Set<string>()
  /** Every token's device: its id, name and account email. */
  readonly devices = new Map<string, { id: string; name: string; email: string }>()
  private deviceSeq = 0
  plan: 'trial' | 'active' | 'read_only' = 'trial'
  quotaBytes = 1 << 30
  /** What GET /server and the account say about billing. */
  billingEnabled = false
  /** Tokens the cloud accepts; remove one to revoke that device (its next call gets 401). */
  readonly tokens = new Set<string>()
  readonly items = new Map<string, StoredItem>()
  readonly blobs = new Map<string, Uint8Array>()
  seq = 0
  /** Items per pull page regardless of `limit`, so a test can split a pull into pages. */
  pageSize: number | null = null
  readonly calls: Call[] = []
  /** Runs on every call, before it is answered (a test can change things at that moment). */
  hook: ((call: Call) => void | Promise<void>) | null = null
  private failures: Array<{ match: (c: Call) => boolean; failure: Failure; times: number }> = []

  /** A token for one device. */
  token(name: string): string {
    const t = `fn1_${name.replace(/\W/g, '_')}`
    this.tokens.add(t)
    return t
  }

  /** The next `times` calls matching `match` fail with `failure`. */
  fail(match: (c: Call) => boolean, failure: Failure, times = 1): void {
    this.failures.push({ match, failure, times })
  }

  /** sync-protocol.md "Quota": live items' meta, the blobs they reference, and blobs nothing references yet. */
  usedBytes(): number {
    let used = 0
    for (const it of this.items.values()) if (!it.deleted) used += it.meta?.length ?? 0
    for (const b of this.blobs.values()) used += b.length
    return used
  }

  /** Stores an item as if another client pushed it (bypassing the rules). */
  put(it: Omit<StoredItem, 'seq' | 'updatedAt'>): void {
    this.items.set(it.id, { ...it, seq: ++this.seq, updatedAt: new Date(0).toISOString() })
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const auth = new Headers(init?.headers).get('Authorization')
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null
    const path = url.pathname.replace(/^\/v1/, '')
    const call: Call = { method, path, token, url: String(input), body: typeof init?.body === 'string' ? init.body : null }
    let body: Record<string, any> | null = null // eslint-disable-line @typescript-eslint/no-explicit-any
    let bytes: Uint8Array | null = null
    if (init?.body instanceof Uint8Array) bytes = init.body
    else if (typeof init?.body === 'string') body = JSON.parse(init.body)
    if (path === '/sync/push' && body) {
      call.changes = (body.changes as Array<Record<string, any>>).map((c) => ({ id: c.id, type: c.type, baseVersion: c.base_version, deleted: c.deleted })) // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    this.calls.push(call)
    await this.hook?.(call)
    const f = this.failures.find((x) => x.times > 0 && x.match(call))
    if (f) {
      f.times--
      if (f.failure === 'network') throw new TypeError('fetch failed')
      return error(f.failure.status, f.failure.code, f.failure.retryAfter !== undefined ? { 'Retry-After': String(f.failure.retryAfter) } : {})
    }
    if (PUBLIC.has(path) && method === 'POST') return this.auth(path, body ?? {})
    if (method === 'GET' && path === '/server') {
      return json(200, { api_version: 1, server_version: 'fake', billing_enabled: this.billingEnabled, max_blob_bytes: 100 << 20, default_quota_bytes: this.quotaBytes })
    }
    if (token === null || !this.tokens.has(token)) return error(401, 'unauthorized')
    if (this.recoveryTokens.has(token) && !(method === 'POST' && (path === '/account/password' || path === '/auth/logout'))) return error(403, 'forbidden_scope')
    if (method === 'POST' && path === '/auth/logout') {
      this.revoke(token)
      return new Response(null, { status: 204 })
    }
    if (method === 'GET' && path === '/account') return json(200, this.accountJson(this.accountOf(token)!))
    if (method === 'POST' && path === '/account/password') return this.setPassword(token, body ?? {})
    if (method === 'DELETE' && path === '/account') return this.deleteAccount(token, body ?? {})
    if (method === 'GET' && path === '/devices') {
      const email = this.devices.get(token)?.email
      const list = [...this.devices].filter(([, d]) => d.email === email).map(([t, d]) => ({ id: d.id, name: d.name, created_at: new Date(0).toISOString(), last_seen_at: new Date(0).toISOString(), current: t === token }))
      return json(200, { devices: list })
    }
    const device = /^\/devices\/([^/]+)$/.exec(path)
    if (device && method === 'DELETE') {
      const t = [...this.devices].find(([, d]) => d.id === decodeURIComponent(device[1]!))?.[0]
      if (!t) return error(404, 'not_found')
      this.revoke(t)
      return new Response(null, { status: 204 })
    }

    if (method === 'POST' && path === '/sync/push') return this.push(body!)
    if (method === 'GET' && path === '/sync/pull') return this.pull(url.searchParams)
    const blob = /^\/blobs\/([^/]+)$/.exec(path)
    if (blob && method === 'PUT') return this.putBlob(decodeURIComponent(blob[1]!), bytes ?? new Uint8Array(0))
    if (blob && method === 'GET') {
      const b = this.blobs.get(decodeURIComponent(blob[1]!))
      return b ? new Response(b.slice(), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }) : error(404, 'not_found')
    }
    return error(404, 'not_found')
  }

  // ---- accounts (sync-protocol.md "Accounts"; the server keeps SHA-256 of each auth key)

  /** A signed-in device's token for `email`. */
  private signIn(email: string, deviceName: string, scope: 'full' | 'recovery' = 'full'): { token: string; deviceId: string } {
    const token = this.token(`${email}_${++this.deviceSeq}`)
    const deviceId = `dev_${this.deviceSeq}`
    this.devices.set(token, { id: deviceId, name: deviceName, email })
    if (scope === 'recovery') this.recoveryTokens.add(token)
    return { token, deviceId }
  }

  private revoke(token: string): void {
    this.tokens.delete(token)
    this.recoveryTokens.delete(token)
    this.devices.delete(token)
  }

  private accountOf(token: string): FakeAccount | undefined {
    const email = this.devices.get(token)?.email
    return email === undefined ? undefined : this.accounts.get(email)
  }

  private accountJson(a: FakeAccount) {
    return { email: a.email, library_id: a.libraryId, billing_enabled: this.billingEnabled, plan: { state: this.plan, reason: null, trial_ends_at: null, quota_bytes: this.quotaBytes, used_bytes: this.usedBytes() } }
  }

  private auth(path: string, b: Record<string, any>): Response { // eslint-disable-line @typescript-eslint/no-explicit-any
    const email = String(b.email ?? '')
    const a = this.accounts.get(email)
    const hash = (v: unknown) => sha256(unb64(String(v ?? '')))
    switch (path) {
      case '/auth/prelogin':
        // an unknown email gets a fake salt, so the answer looks the same
        return json(200, { kdf: a?.kdf ?? { alg: 'argon2id13', t: 3, m_kib: 262144, p: 1 }, salt: a?.salt ?? b64(createHash('sha256').update(email).digest().subarray(0, 16)) })
      case '/auth/signup':
        if (!a?.verified) {
          this.accounts.set(email, { email, libraryId: b.library_id, salt: b.salt, kdf: b.kdf, authHash: hash(b.auth_key), recoveryHash: hash(b.recovery_auth_key), wrappedPassword: b.wrapped_master_password, wrappedRecovery: b.wrapped_master_recovery, verified: false })
          this.codes.set(email, String(100000 + this.codes.size))
        }
        return new Response(null, { status: 202 })
      case '/auth/resend':
        return new Response(null, { status: 202 })
      case '/auth/verify': {
        if (!a || a.verified || !this.codes.has(email)) return error(400, 'verification_expired')
        // the code counts only together with the signup's auth key
        if (this.codes.get(email) !== b.code || typeof b.auth_key !== 'string' || a.authHash !== hash(b.auth_key)) return error(400, 'verification_invalid')
        a.verified = true
        this.codes.delete(email)
        this.libraryId = a.libraryId
        const s = this.signIn(email, b.device_name)
        return json(200, { token: s.token, device_id: s.deviceId, account: this.accountJson(a) })
      }
      case '/auth/login': {
        if (!a || a.authHash !== hash(b.auth_key)) return error(401, 'unauthorized')
        if (!a.verified) return error(403, 'email_unverified')
        const s = this.signIn(email, b.device_name)
        return json(200, { token: s.token, device_id: s.deviceId, account: this.accountJson(a), wrapped_master_password: a.wrappedPassword })
      }
      case '/auth/recover': {
        if (!a || !a.verified || a.recoveryHash !== hash(b.recovery_auth_key)) return error(401, 'unauthorized')
        const s = this.signIn(email, b.device_name, 'recovery')
        return json(200, { token: s.token, device_id: s.deviceId, wrapped_master_recovery: a.wrappedRecovery })
      }
    }
    return error(404, 'not_found')
  }

  private setPassword(token: string, b: Record<string, any>): Response { // eslint-disable-line @typescript-eslint/no-explicit-any
    const a = this.accountOf(token)!
    if (!this.recoveryTokens.has(token) && a.authHash !== sha256(unb64(String(b.current_auth_key ?? '')))) return error(401, 'unauthorized')
    Object.assign(a, { salt: b.salt, kdf: b.kdf, authHash: sha256(unb64(b.auth_key)), wrappedPassword: b.wrapped_master_password })
    const name = this.devices.get(token)!.name
    // every session ends, this one included; a new full-scope token comes back
    for (const [t, d] of [...this.devices]) if (d.email === a.email) this.revoke(t)
    return json(200, { token: this.signIn(a.email, name).token })
  }

  private deleteAccount(token: string, b: Record<string, any>): Response { // eslint-disable-line @typescript-eslint/no-explicit-any
    const a = this.accountOf(token)!
    if (a.authHash !== sha256(unb64(String(b.auth_key ?? '')))) return error(401, 'unauthorized')
    for (const [t, d] of [...this.devices]) if (d.email === a.email) this.revoke(t)
    this.accounts.delete(a.email)
    return new Response(null, { status: 202 })
  }

  private itemJson(it: StoredItem) {
    return {
      id: it.id, type: it.type, version: it.version, seq: it.seq, deleted: it.deleted, meta: it.meta ? b64(it.meta) : null,
      blob: it.blobSha ? { sha256: it.blobSha, size: this.blobs.get(it.blobSha)?.length ?? 0 } : null, updated_at: it.updatedAt,
    }
  }

  private push(body: Record<string, any>): Response { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (body.library_id !== this.libraryId) return error(400, 'library_mismatch')
    if (this.plan === 'read_only') return error(403, 'read_only')
    const changes = body.changes as Array<Record<string, any>> // eslint-disable-line @typescript-eslint/no-explicit-any
    if (changes.length > 100) return error(400, 'invalid_request')
    const results = changes.map((c) => {
      const id = c.id as string
      const rejected = (code: string) => ({ id, status: 'rejected', error: { code } })
      const meta = c.meta === null ? null : unb64(c.meta)
      const sha = c.blob_sha256 as string | null
      // rules 4 and 5, shape
      if (c.deleted ? meta !== null || sha !== null : meta === null || ((c.type === 'note' || c.type === 'attachment') !== (sha !== null))) return rejected('invalid_request')
      const cur = this.items.get(id)
      if (c.base_version === 0 && cur) return { id, status: 'conflict', current: this.itemJson(cur) } // rule 1
      if (c.base_version > 0 && !cur) return rejected('not_found') // rule 2
      if (cur && cur.type !== c.type) return rejected('type_mismatch') // rule 3
      if (cur && cur.version !== c.base_version) return { id, status: 'conflict', current: this.itemJson(cur) } // rule 2
      if (sha !== null && !this.blobs.has(sha)) return rejected('blob_missing') // rule 5
      const before = this.usedBytes()
      const next: StoredItem = { id, type: c.type, version: c.base_version + 1, seq: this.seq + 1, deleted: c.deleted, meta, blobSha: sha, updatedAt: new Date(0).toISOString() }
      this.items.set(id, next)
      const after = this.usedBytes()
      if (after > this.quotaBytes && after > before) { // rule 6
        if (cur) this.items.set(id, cur)
        else this.items.delete(id)
        return rejected('quota_exceeded')
      }
      this.seq++ // rule 7
      return { id, status: 'accepted', version: next.version, seq: next.seq }
    })
    return json(200, { results })
  }

  private pull(q: URLSearchParams): Response {
    if (q.get('library_id') !== this.libraryId) return error(400, 'library_mismatch')
    const after = q.has('cursor') ? Number(q.get('cursor')!.slice(2)) : 0
    const limit = this.pageSize ?? Math.min(Number(q.get('limit') ?? 500), 1000)
    const sorted = [...this.items.values()].filter((it) => it.seq > after).sort((a, b) => a.seq - b.seq)
    const page = sorted.slice(0, limit)
    return json(200, { items: page.map((it) => this.itemJson(it)), cursor: cursor(page.at(-1)?.seq ?? after), has_more: sorted.length > limit })
  }

  private putBlob(sha: string, bytes: Uint8Array): Response {
    if (sha256(bytes) !== sha) return error(400, 'blob_hash_mismatch')
    if (this.plan === 'read_only') return error(403, 'read_only')
    if (!this.blobs.has(sha)) {
      if (this.usedBytes() + bytes.length > this.quotaBytes) return error(403, 'quota_exceeded')
      this.blobs.set(sha, bytes.slice())
    }
    return json(200, { sha256: sha, size: bytes.length })
  }
}

/** The crypto worker's seal and open, run in the test with a fixed master key (Node has no worker). */
export function fakeCrypto(master: Uint8Array): CryptoClient {
  const unsupported = () => Promise.reject(new Error('not in the fake crypto client'))
  return {
    seal: async (_session: number, list: Array<{ plain: Uint8Array; part: Parameters<typeof seal>[1]; id: string }>) =>
      list.map(({ plain, part, id }) => seal(plain, part, id, itemKey(master, id))),
    open: async (_session: number, list: Array<{ envelope: Uint8Array; part: Parameters<typeof open>[1]; id: string }>): Promise<OpenResult[]> =>
      list.map(({ envelope, part, id }) => {
        try {
          return open(envelope, part, id, itemKey(master, id))
        } catch (e) {
          if (e instanceof CryptoError) return { error: e.kind }
          throw e
        }
      }),
    signUpKeys: unsupported,
    logInKeys: unsupported,
    unwrap: unsupported,
    recoveryKeys: unsupported,
    newPassword: unsupported,
    forget: async () => undefined,
    terminate: () => undefined,
  } as CryptoClient
}
