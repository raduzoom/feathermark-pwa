// The Feather Cloud HTTP client (sync-protocol.md; sync-protocol.openapi.yaml; Swift: APIClient.swift). It maps the
// JSON's snake_case to camelCase types, decodes base64 to Uint8Array and back, and turns every failure into `ApiError`.
// It never logs, never puts a secret in a URL (the only query values are `library_id`, `cursor` and `limit`), and sends
// `Authorization: Bearer` only on operations that are not public.
import type { ItemType } from './codec.ts'
import type { KdfParams } from '../crypto/argon2.ts'

export type { ItemType }

export class ApiError extends Error {
  override name = 'ApiError'
  /** HTTP status; 0 means the request never got an answer (network failure or timeout). */
  readonly status: number
  /** The body's `error.code`, or `network`, `timeout`, or a code derived from the status. */
  readonly code: string
  /** Seconds from `Retry-After`, or null. */
  readonly retryAfter: number | null
  constructor(status: number, code: string, retryAfter: number | null = null) {
    super(`${status} ${code}`)
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

export type ServerInfo = { apiVersion: number; serverVersion: string; billingEnabled: boolean; maxBlobBytes: number; defaultQuotaBytes: number }
export type PlanState = 'trial' | 'active' | 'read_only'
export type CloudPlan = { state: PlanState; reason: string | null; trialEndsAt: string | null; quotaBytes: number; usedBytes: number }
export type CloudAccount = { email: string; libraryId: string; plan: CloudPlan; billingEnabled: boolean }
export type CloudDevice = { id: string; name: string; createdAt: string; lastSeenAt: string; current: boolean }
export type Session = { token: string; deviceId: string; account: CloudAccount }
export type BlobRef = { sha256: string; size: number }
export type PulledItem = { id: string; type: ItemType; version: number; seq: number; deleted: boolean; meta: Uint8Array | null; blob: BlobRef | null; updatedAt: string }
export type PullPage = { items: PulledItem[]; cursor: string; hasMore: boolean }
export type Change = { id: string; type: ItemType; baseVersion: number; deleted: boolean; meta: Uint8Array | null; blobSha256: string | null }
export type PushResult =
  | { id: string; status: 'accepted'; version: number; seq: number }
  | { id: string; status: 'conflict'; current: PulledItem }
  | { id: string; status: 'rejected'; code: string }

export type SignupBody = { email: string; salt: Uint8Array; kdf: KdfParams; authKey: Uint8Array; recoveryAuthKey: Uint8Array; wrappedMasterPassword: Uint8Array; wrappedMasterRecovery: Uint8Array; libraryId: string }
/** The code counts only together with the auth key the signup sent. */
export type VerifyBody = { email: string; code: string; authKey: Uint8Array; deviceName: string }
export type LoginBody = { email: string; authKey: Uint8Array; deviceName: string }
export type RecoverBody = { email: string; recoveryAuthKey: Uint8Array; deviceName: string }
export type SetPasswordBody = { currentAuthKey?: Uint8Array; salt: Uint8Array; kdf: KdfParams; authKey: Uint8Array; wrappedMasterPassword: Uint8Array }

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** Standard base64 with padding. */
export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
export function fromBase64(text: string): Uint8Array {
  const s = atob(text)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
const opt64 = (v: unknown): Uint8Array | null => (typeof v === 'string' ? fromBase64(v) : null)

function account(j: Json): CloudAccount {
  const p = j.plan
  return {
    email: j.email, libraryId: j.library_id, billingEnabled: j.billing_enabled,
    plan: { state: p.state, reason: p.reason ?? null, trialEndsAt: p.trial_ends_at ?? null, quotaBytes: p.quota_bytes, usedBytes: p.used_bytes },
  }
}
function session(j: Json): Session {
  return { token: j.token, deviceId: j.device_id, account: account(j.account) }
}
function item(j: Json): PulledItem {
  return {
    id: j.id, type: j.type, version: j.version, seq: j.seq, deleted: j.deleted, meta: opt64(j.meta),
    blob: j.blob ? { sha256: j.blob.sha256, size: j.blob.size } : null, updatedAt: j.updated_at,
  }
}
function pushResult(j: Json): PushResult {
  if (j.status === 'accepted') return { id: j.id, status: 'accepted', version: j.version, seq: j.seq }
  if (j.status === 'conflict') return { id: j.id, status: 'conflict', current: item(j.current) }
  return { id: j.id, status: 'rejected', code: j.error?.code ?? 'invalid_request' }
}

const STATUS_CODES: Record<number, string> = { 400: 'invalid_request', 401: 'unauthorized', 403: 'forbidden_scope', 404: 'not_found', 413: 'blob_too_large', 429: 'rate_limited' }

/** An upload gets the base timeout plus the time to send its body at 32 KB/s (32 bytes per ms). */
const BLOB_UPLOAD_BYTES_PER_MS = 32

type Request = { method: string; path: string; query?: Record<string, string>; body?: Json; bytes?: Uint8Array; public?: boolean; keepalive?: boolean; timeoutMs?: number; idle?: boolean }

export class ApiClient {
  private readonly base: string
  private token: string | undefined
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(o: { base: string; token?: string; fetch?: typeof fetch; timeoutMs?: number }) {
    this.base = o.base.replace(/\/+$/, '')
    this.token = o.token
    this.fetchImpl = o.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.timeoutMs = o.timeoutMs ?? 30_000
  }

  /** A new token for this device (a password change gives one); later requests use it. */
  setToken(token: string): void {
    this.token = token
  }

  // ---- public
  async server(): Promise<ServerInfo> {
    const j = await this.json({ method: 'GET', path: '/server', public: true })
    return { apiVersion: j.api_version, serverVersion: j.server_version, billingEnabled: j.billing_enabled, maxBlobBytes: j.max_blob_bytes, defaultQuotaBytes: j.default_quota_bytes }
  }
  async prelogin(email: string): Promise<{ kdf: KdfParams; salt: Uint8Array }> {
    const j = await this.json({ method: 'POST', path: '/auth/prelogin', body: { email }, public: true })
    return { kdf: j.kdf, salt: fromBase64(j.salt) }
  }
  async signup(b: SignupBody): Promise<void> {
    await this.send({ method: 'POST', path: '/auth/signup', public: true, body: {
      email: b.email, salt: toBase64(b.salt), kdf: b.kdf, auth_key: toBase64(b.authKey), recovery_auth_key: toBase64(b.recoveryAuthKey),
      wrapped_master_password: toBase64(b.wrappedMasterPassword), wrapped_master_recovery: toBase64(b.wrappedMasterRecovery), library_id: b.libraryId,
    } }, 'none')
  }
  async verify(b: VerifyBody): Promise<Session> {
    return session(await this.json({ method: 'POST', path: '/auth/verify', public: true, body: { email: b.email, code: b.code, auth_key: toBase64(b.authKey), device_name: b.deviceName } }))
  }
  async resend(email: string): Promise<void> {
    await this.send({ method: 'POST', path: '/auth/resend', public: true, body: { email } }, 'none')
  }
  async login(b: LoginBody): Promise<Session & { wrappedMasterPassword: Uint8Array }> {
    const j = await this.json({ method: 'POST', path: '/auth/login', public: true, body: { email: b.email, auth_key: toBase64(b.authKey), device_name: b.deviceName } })
    return { ...session(j), wrappedMasterPassword: fromBase64(j.wrapped_master_password) }
  }
  async recover(b: RecoverBody): Promise<{ token: string; deviceId: string; wrappedMasterRecovery: Uint8Array }> {
    const j = await this.json({ method: 'POST', path: '/auth/recover', public: true, body: { email: b.email, recovery_auth_key: toBase64(b.recoveryAuthKey), device_name: b.deviceName } })
    return { token: j.token, deviceId: j.device_id, wrappedMasterRecovery: fromBase64(j.wrapped_master_recovery) }
  }

  // ---- signed in
  async logout(o?: { keepalive: boolean }): Promise<void> {
    await this.send({ method: 'POST', path: '/auth/logout', keepalive: o?.keepalive }, 'none')
  }
  async account(): Promise<CloudAccount> {
    return account(await this.json({ method: 'GET', path: '/account' }))
  }
  async deleteAccount(authKey: Uint8Array): Promise<void> {
    await this.send({ method: 'DELETE', path: '/account', body: { auth_key: toBase64(authKey) } }, 'none')
  }
  async setPassword(b: SetPasswordBody): Promise<{ token: string }> {
    const body: Json = { salt: toBase64(b.salt), kdf: b.kdf, auth_key: toBase64(b.authKey), wrapped_master_password: toBase64(b.wrappedMasterPassword) }
    if (b.currentAuthKey) body.current_auth_key = toBase64(b.currentAuthKey)
    const j = await this.json({ method: 'POST', path: '/account/password', body })
    return { token: j.token }
  }
  async devices(): Promise<CloudDevice[]> {
    const j = await this.json({ method: 'GET', path: '/devices' })
    return (j.devices as Json[]).map((d) => ({ id: d.id, name: d.name, createdAt: d.created_at, lastSeenAt: d.last_seen_at, current: d.current }))
  }
  async revokeDevice(id: string): Promise<void> {
    await this.send({ method: 'DELETE', path: `/devices/${encodeURIComponent(id)}` }, 'none')
  }

  // ---- sync
  async push(libraryId: string, changes: Change[]): Promise<PushResult[]> {
    const j = await this.json({ method: 'POST', path: '/sync/push', body: {
      library_id: libraryId,
      changes: changes.map((c) => ({ id: c.id, type: c.type, base_version: c.baseVersion, deleted: c.deleted, meta: c.meta ? toBase64(c.meta) : null, blob_sha256: c.blobSha256 })),
    } })
    return (j.results as Json[]).map(pushResult)
  }
  async pull(libraryId: string, cursor: string | null, limit?: number): Promise<PullPage> {
    const query: Record<string, string> = { library_id: libraryId }
    if (cursor !== null) query.cursor = cursor
    if (limit !== undefined) query.limit = String(limit)
    const j = await this.json({ method: 'GET', path: '/sync/pull', query })
    return { items: (j.items as Json[]).map(item), cursor: j.cursor, hasMore: j.has_more }
  }
  async putBlob(sha256: string, bytes: Uint8Array): Promise<void> {
    await this.send({ method: 'PUT', path: `/blobs/${encodeURIComponent(sha256)}`, bytes, timeoutMs: this.timeoutMs + bytes.length / BLOB_UPLOAD_BYTES_PER_MS }, 'none')
  }
  async getBlob(sha256: string): Promise<Uint8Array> {
    return (await this.send({ method: 'GET', path: `/blobs/${encodeURIComponent(sha256)}`, idle: true }, 'bytes')) as Uint8Array
  }

  // ---- plumbing
  private async json(r: Request): Promise<Json> {
    return (await this.send(r, 'json')) as Json
  }

  /** One request. The timeout covers the headers and the whole body; every failure is an ApiError. */
  private async send(r: Request, want: 'json' | 'bytes' | 'none'): Promise<unknown> {
    const url = new URL(this.base + r.path)
    for (const [k, v] of Object.entries(r.query ?? {})) url.searchParams.set(k, v)
    const headers: Record<string, string> = {}
    if (!r.public && this.token) headers.Authorization = `Bearer ${this.token}`
    let body: BodyInit | undefined
    if (r.bytes) { headers['Content-Type'] = 'application/octet-stream'; body = r.bytes as BodyInit }
    else if (r.body) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(r.body) }
    if (want === 'json') headers.Accept = 'application/json'

    const controller = new AbortController()
    let timedOut = false
    const limit = r.timeoutMs ?? this.timeoutMs
    const arm = () => setTimeout(() => { timedOut = true; controller.abort() }, limit)
    let timer = arm()
    // A download's timeout is an idle one: every chunk that arrives starts the wait again.
    const rearm = () => { clearTimeout(timer); timer = arm() }
    try {
      const init: RequestInit = { method: r.method, headers, signal: controller.signal }
      if (body !== undefined) init.body = body
      if (r.keepalive) init.keepalive = true
      const res = await this.fetchImpl(url.toString(), init)
      if (!res.ok) throw await this.failure(res)
      if (want === 'none') { await res.arrayBuffer().catch(() => undefined); return undefined }
      if (want === 'bytes') return r.idle ? await this.readIdle(res, rearm) : new Uint8Array(await res.arrayBuffer())
      return await res.json()
    } catch (e) {
      if (e instanceof ApiError) throw e
      throw new ApiError(0, timedOut ? 'timeout' : 'network')
    } finally {
      clearTimeout(timer)
    }
  }

  private async readIdle(res: Response, rearm: () => void): Promise<Uint8Array> {
    if (!res.body) return new Uint8Array(await res.arrayBuffer())
    const reader = res.body.getReader()
    const parts: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      rearm()
      parts.push(value)
      total += value.length
    }
    const out = new Uint8Array(total)
    let at = 0
    for (const p of parts) { out.set(p, at); at += p.length }
    return out
  }

  private async failure(res: Response): Promise<ApiError> {
    let code: string | undefined
    try {
      const j = await res.json()
      if (typeof j?.error?.code === 'string') code = j.error.code
    } catch { /* not JSON */ }
    const ra = res.headers.get('Retry-After')
    const seconds = ra !== null && /^\d+$/.test(ra.trim()) ? Number(ra) : null
    return new ApiError(res.status, code ?? STATUS_CODES[res.status] ?? 'server_error', seconds)
  }
}
