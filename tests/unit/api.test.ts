import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test, vi } from 'vitest'
import { ApiClient, ApiError } from '../../src/core/sync/api.ts'

const BASE = 'https://cloud.example/v1'
const TOKEN = 'fn1_' + 'A'.repeat(43)
const ULID = '01JC8ZN0AB1CD2EF3GH4JK5MN6'
const SHA = 'ab'.repeat(32)
const KDF = { alg: 'argon2id13', t: 3, m_kib: 262144, p: 1 }
const ACCOUNT = { email: 'a@b.co', library_id: ULID, plan: { state: 'trial', reason: null, trial_ends_at: '2026-11-23T14:32:00.123Z', quota_bytes: 1, used_bytes: 0 }, billing_enabled: true }

type Call = { url: URL; method: string; headers: Headers; body: BodyInit | null | undefined; keepalive: boolean | undefined; signal: AbortSignal | null | undefined }
function b64(bytes: number[]): string { return btoa(String.fromCharCode(...bytes)) }

function harness(respond: (c: Call) => Response | Promise<Response> = () => json({})) {
  const calls: Call[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: new URL(String(input)), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body, keepalive: init?.keepalive, signal: init?.signal }
    calls.push(call)
    return respond(call)
  }) as typeof globalThis.fetch
  return { calls, client: (o: { token?: string; timeoutMs?: number } = {}) => new ApiClient({ base: BASE, fetch, ...o }) }
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const empty = (status: number) => new Response(null, { status })
const sent = (c: Call) => JSON.parse(String(c.body))

// ---- every operation, with the response it needs and the call that makes it
type Op = { key: string; method: string; path: string; public: boolean; reply: () => Response; run: (c: ApiClient) => Promise<unknown> }
const OPS: Op[] = [
  { key: 'GET /server', method: 'GET', path: '/server', public: true, reply: () => json({ api_version: 1, server_version: '1.0.0', billing_enabled: true, max_blob_bytes: 9, default_quota_bytes: 8 }), run: (c) => c.server() },
  { key: 'POST /auth/prelogin', method: 'POST', path: '/auth/prelogin', public: true, reply: () => json({ kdf: KDF, salt: b64([1, 2, 3]) }), run: (c) => c.prelogin('a@b.co') },
  { key: 'POST /auth/signup', method: 'POST', path: '/auth/signup', public: true, reply: () => empty(202), run: (c) => c.signup({ email: 'a@b.co', salt: new Uint8Array([1]), kdf: KDF, authKey: new Uint8Array([2]), recoveryAuthKey: new Uint8Array([3]), wrappedMasterPassword: new Uint8Array([4]), wrappedMasterRecovery: new Uint8Array([5]), libraryId: ULID }) },
  { key: 'POST /auth/verify', method: 'POST', path: '/auth/verify', public: true, reply: () => json({ token: TOKEN, device_id: ULID, account: ACCOUNT }), run: (c) => c.verify({ email: 'a@b.co', code: '123456', deviceName: 'Safari on macOS' }) },
  { key: 'POST /auth/resend', method: 'POST', path: '/auth/resend', public: true, reply: () => empty(202), run: (c) => c.resend('a@b.co') },
  { key: 'POST /auth/login', method: 'POST', path: '/auth/login', public: true, reply: () => json({ token: TOKEN, device_id: ULID, account: ACCOUNT, wrapped_master_password: b64([9]) }), run: (c) => c.login({ email: 'a@b.co', authKey: new Uint8Array([2]), deviceName: 'x' }) },
  { key: 'POST /auth/recover', method: 'POST', path: '/auth/recover', public: true, reply: () => json({ token: TOKEN, device_id: ULID, wrapped_master_recovery: b64([7]) }), run: (c) => c.recover({ email: 'a@b.co', recoveryAuthKey: new Uint8Array([3]), deviceName: 'x' }) },
  { key: 'POST /auth/logout', method: 'POST', path: '/auth/logout', public: false, reply: () => empty(204), run: (c) => c.logout() },
  { key: 'GET /account', method: 'GET', path: '/account', public: false, reply: () => json(ACCOUNT), run: (c) => c.account() },
  { key: 'DELETE /account', method: 'DELETE', path: '/account', public: false, reply: () => empty(202), run: (c) => c.deleteAccount(new Uint8Array([2])) },
  { key: 'POST /account/password', method: 'POST', path: '/account/password', public: false, reply: () => json({ token: TOKEN }), run: (c) => c.setPassword({ currentAuthKey: new Uint8Array([1]), salt: new Uint8Array([1]), kdf: KDF, authKey: new Uint8Array([2]), wrappedMasterPassword: new Uint8Array([3]) }) },
  { key: 'GET /devices', method: 'GET', path: '/devices', public: false, reply: () => json({ devices: [] }), run: (c) => c.devices() },
  { key: 'DELETE /devices/{device_id}', method: 'DELETE', path: `/devices/${ULID}`, public: false, reply: () => empty(204), run: (c) => c.revokeDevice(ULID) },
  { key: 'POST /sync/push', method: 'POST', path: '/sync/push', public: false, reply: () => json({ results: [] }), run: (c) => c.push(ULID, []) },
  { key: 'GET /sync/pull', method: 'GET', path: '/sync/pull', public: false, reply: () => json({ items: [], cursor: 'c_1', has_more: false }), run: (c) => c.pull(ULID, null) },
  { key: 'PUT /blobs/{sha256}', method: 'PUT', path: `/blobs/${SHA}`, public: false, reply: () => json({ sha256: SHA, size: 1 }), run: (c) => c.putBlob(SHA, new Uint8Array([1])) },
  { key: 'GET /blobs/{sha256}', method: 'GET', path: `/blobs/${SHA}`, public: false, reply: () => new Response(new Uint8Array([1, 2])), run: (c) => c.getBlob(SHA) },
]

/** A tiny line-based reader for the OpenAPI file's `paths:` block (it is regular: paths at 2 spaces, methods at 4). */
function openApiOperations(): string[] {
  const file = process.env.FEATHER_OPENAPI ?? fileURLToPath(new URL('../../../universal/specs/sync-protocol.openapi.yaml', import.meta.url))
  const ops: string[] = []
  let inPaths = false
  let path = ''
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\S/.test(line)) inPaths = line.startsWith('paths:')
    if (!inPaths) continue
    const p = /^ {2}(\/\S*):\s*$/.exec(line)
    if (p) { path = p[1]!; continue }
    const m = /^ {4}(get|put|post|delete):\s*$/.exec(line)
    if (m) ops.push(`${m[1]!.toUpperCase()} ${path}`)
  }
  return ops
}

test('the client has a method for every operation in the OpenAPI file (17)', () => {
  const spec = openApiOperations()
  expect(spec).toHaveLength(17)
  expect([...spec].sort()).toEqual(OPS.map((o) => o.key).sort())
})

test.each(OPS)('$key goes to its path and method', async (op) => {
  const h = harness(() => op.reply())
  await op.run(h.client({ token: TOKEN }))
  expect(h.calls).toHaveLength(1)
  expect(h.calls[0]!.method).toBe(op.method)
  expect(h.calls[0]!.url.origin + h.calls[0]!.url.pathname).toBe(BASE + op.path)
})

test.each(OPS)('$key: Authorization only on non-public calls', async (op) => {
  const h = harness(() => op.reply())
  await op.run(h.client({ token: TOKEN }))
  expect(h.calls[0]!.headers.get('authorization')).toBe(op.public ? null : `Bearer ${TOKEN}`)
})

test.each(OPS)('$key: no query string except library_id, cursor and limit; no secret in the URL', async (op) => {
  const h = harness(() => op.reply())
  await op.run(h.client({ token: TOKEN }))
  const u = h.calls[0]!.url
  const allowed = op.key === 'GET /sync/pull' ? ['library_id'] : []
  expect([...u.searchParams.keys()]).toEqual(allowed)
  expect(u.href).not.toContain(TOKEN)
})

test('requests are JSON, with snake_case fields and standard base64 with padding', async () => {
  const h = harness(() => empty(202))
  await h.client().signup({ email: 'a@b.co', salt: new Uint8Array([251, 255]), kdf: KDF, authKey: new Uint8Array([1]), recoveryAuthKey: new Uint8Array([2, 3]), wrappedMasterPassword: new Uint8Array([4]), wrappedMasterRecovery: new Uint8Array([5]), libraryId: ULID })
  const c = h.calls[0]!
  expect(c.headers.get('content-type')).toMatch(/^application\/json/)
  expect(sent(c)).toEqual({ email: 'a@b.co', salt: '+/8=', kdf: KDF, auth_key: 'AQ==', recovery_auth_key: 'AgM=', wrapped_master_password: 'BA==', wrapped_master_recovery: 'BQ==', library_id: ULID })
})

test('responses are mapped to camelCase with bytes decoded; unknown fields are ignored', async () => {
  const h = harness((c) => {
    if (c.url.pathname.endsWith('/auth/login')) return json({ token: TOKEN, device_id: ULID, account: { ...ACCOUNT, extra: 1 }, wrapped_master_password: '+/8=', surprise: true })
    return json({ kdf: KDF, salt: 'AQID', more: 1 })
  })
  const session = await h.client().login({ email: 'a@b.co', authKey: new Uint8Array([1]), deviceName: 'x' })
  expect(session.wrappedMasterPassword).toEqual(new Uint8Array([251, 255]))
  expect(session.token).toBe(TOKEN)
  expect(session.deviceId).toBe(ULID)
  expect(session.account).toEqual({ email: 'a@b.co', libraryId: ULID, plan: { state: 'trial', reason: null, trialEndsAt: '2026-11-23T14:32:00.123Z', quotaBytes: 1, usedBytes: 0 }, billingEnabled: true })
  const pre = await h.client().prelogin('a@b.co')
  expect(pre).toEqual({ kdf: KDF, salt: new Uint8Array([1, 2, 3]) })
})

test('server info, recover, devices and setPassword decode', async () => {
  const dev = { id: ULID, name: 'Mac', created_at: 'c', last_seen_at: 'l', current: true }
  const h = harness((c) => {
    const p = c.url.pathname
    if (p.endsWith('/server')) return json({ api_version: 1, server_version: '1.0.0', billing_enabled: false, max_blob_bytes: 5, default_quota_bytes: 6 })
    if (p.endsWith('/auth/recover')) return json({ token: TOKEN, device_id: ULID, wrapped_master_recovery: 'AQI=' })
    if (p.endsWith('/devices')) return json({ devices: [dev] })
    return json({ token: TOKEN })
  })
  const c = h.client({ token: TOKEN })
  expect(await c.server()).toEqual({ apiVersion: 1, serverVersion: '1.0.0', billingEnabled: false, maxBlobBytes: 5, defaultQuotaBytes: 6 })
  expect(await c.recover({ email: 'a@b.co', recoveryAuthKey: new Uint8Array([1]), deviceName: 'x' })).toEqual({ token: TOKEN, deviceId: ULID, wrappedMasterRecovery: new Uint8Array([1, 2]) })
  expect(await c.devices()).toEqual([{ id: ULID, name: 'Mac', createdAt: 'c', lastSeenAt: 'l', current: true }])
  expect(await c.setPassword({ salt: new Uint8Array([1]), kdf: KDF, authKey: new Uint8Array([2]), wrappedMasterPassword: new Uint8Array([3]) })).toEqual({ token: TOKEN })
  const body = sent(h.calls[3]!)
  expect('current_auth_key' in body).toBe(false)
  expect(body.wrapped_master_password).toBe('Aw==')
})

test('deleteAccount, verify and login bodies use the protocol names', async () => {
  const h = harness((c) => (c.method === 'DELETE' ? empty(202) : json({ token: TOKEN, device_id: ULID, account: ACCOUNT })))
  const c = h.client({ token: TOKEN })
  await c.deleteAccount(new Uint8Array([251, 255]))
  await c.verify({ email: 'a@b.co', code: '123456', deviceName: 'Safari on macOS' })
  expect(sent(h.calls[0]!)).toEqual({ auth_key: '+/8=' })
  expect(sent(h.calls[1]!)).toEqual({ email: 'a@b.co', code: '123456', device_name: 'Safari on macOS' })
})

test('push sends snake_case changes with base64 meta and maps every result kind', async () => {
  const item = { id: ULID, type: 'note', version: 5, seq: 9, deleted: false, meta: 'AQI=', blob: { sha256: SHA, size: 3 }, updated_at: 't' }
  const h = harness(() => json({ results: [
    { id: 'a', status: 'accepted', version: 2, seq: 7 },
    { id: 'b', status: 'conflict', current: item },
    { id: 'c', status: 'rejected', error: { code: 'blob_missing' } },
  ] }))
  const res = await h.client({ token: TOKEN }).push(ULID, [
    { id: 'a', type: 'note', baseVersion: 1, deleted: false, meta: new Uint8Array([1, 2]), blobSha256: SHA },
    { id: 'd', type: 'tag', baseVersion: 0, deleted: true, meta: null, blobSha256: null },
  ])
  expect(sent(h.calls[0]!)).toEqual({ library_id: ULID, changes: [
    { id: 'a', type: 'note', base_version: 1, deleted: false, meta: 'AQI=', blob_sha256: SHA },
    { id: 'd', type: 'tag', base_version: 0, deleted: true, meta: null, blob_sha256: null },
  ] })
  expect(res).toEqual([
    { id: 'a', status: 'accepted', version: 2, seq: 7 },
    { id: 'b', status: 'conflict', current: { id: ULID, type: 'note', version: 5, seq: 9, deleted: false, meta: new Uint8Array([1, 2]), blob: { sha256: SHA, size: 3 }, updatedAt: 't' } },
    { id: 'c', status: 'rejected', code: 'blob_missing' },
  ])
})

test('pull sends only library_id, cursor and limit, and maps items', async () => {
  const h = harness(() => json({ items: [
    { id: ULID, type: 'tag', version: 1, seq: 1, deleted: false, meta: 'AQ==', blob: null, updated_at: 't' },
    { id: 'z', type: 'note', version: 2, seq: 2, deleted: true, meta: null, blob: null, updated_at: 't' },
  ], cursor: 'c_2', has_more: true }))
  const c = h.client({ token: TOKEN })
  const page = await c.pull(ULID, 'c_1', 50)
  expect(Object.fromEntries(h.calls[0]!.url.searchParams)).toEqual({ library_id: ULID, cursor: 'c_1', limit: '50' })
  expect(page.cursor).toBe('c_2')
  expect(page.hasMore).toBe(true)
  expect(page.items[0]!.meta).toEqual(new Uint8Array([1]))
  expect(page.items[1]!.meta).toBeNull()
  await c.pull(ULID, null)
  expect(Object.fromEntries(h.calls[1]!.url.searchParams)).toEqual({ library_id: ULID })
})

test('blobs: octet-stream body up, bytes down', async () => {
  const h = harness((c) => (c.method === 'PUT' ? json({ sha256: SHA, size: 2 }) : new Response(new Uint8Array([7, 8, 9]))))
  const c = h.client({ token: TOKEN })
  await c.putBlob(SHA, new Uint8Array([1, 2]))
  expect(h.calls[0]!.headers.get('content-type')).toBe('application/octet-stream')
  expect(new Uint8Array(h.calls[0]!.body as Uint8Array)).toEqual(new Uint8Array([1, 2]))
  expect(await c.getBlob(SHA)).toEqual(new Uint8Array([7, 8, 9]))
})

test('errors become ApiError with status and the body code', async () => {
  const h = harness(() => json({ error: { code: 'read_only', message: 'Plan is read only.' } }, 403))
  const err = await h.client({ token: TOKEN }).push(ULID, []).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(ApiError)
  expect(err).toMatchObject({ status: 403, code: 'read_only', retryAfter: null })
})

test('a non-JSON error body falls back to a code from the status', async () => {
  const h = harness(() => new Response('<html>', { status: 502 }))
  const err = await h.client().server().catch((e: unknown) => e)
  expect(err).toMatchObject({ status: 502, code: 'server_error' })
  const h2 = harness(() => new Response('x', { status: 401 }))
  expect(await h2.client().server().catch((e: unknown) => e)).toMatchObject({ status: 401, code: 'unauthorized' })
})

test('429 carries Retry-After in seconds', async () => {
  const h = harness(() => json({ error: { code: 'rate_limited', message: 'm' } }, 429, { 'Retry-After': '17' }))
  const err = await h.client().prelogin('a@b.co').catch((e: unknown) => e)
  expect(err).toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 17 })
})

test('a network failure is status 0', async () => {
  const c = new ApiClient({ base: BASE, fetch: (async () => { throw new TypeError('Failed to fetch') }) as typeof fetch })
  const err = await c.server().catch((e: unknown) => e)
  expect(err).toBeInstanceOf(ApiError)
  expect(err).toMatchObject({ status: 0, code: 'network' })
})

test('a request never takes longer than the timeout', async () => {
  const hang = ((_: unknown, init?: RequestInit) => new Promise((_res, rej) => {
    init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
  })) as typeof fetch
  const c = new ApiClient({ base: BASE, fetch: hang, timeoutMs: 30 })
  const t = Date.now()
  const err = await c.server().catch((e: unknown) => e)
  expect(Date.now() - t).toBeLessThan(2000)
  expect(err).toMatchObject({ status: 0, code: 'timeout' })
})

test('the timeout also covers a body that never arrives', async () => {
  const stuck = ((_: unknown, init?: RequestInit) => {
    const body = new ReadableStream({ start(ctrl) { init?.signal?.addEventListener('abort', () => ctrl.error(new DOMException('aborted', 'AbortError'))) } })
    return Promise.resolve(new Response(body, { status: 200 }))
  }) as typeof fetch
  const c = new ApiClient({ base: BASE, fetch: stuck, timeoutMs: 30 })
  expect(await c.getBlob(SHA).catch((e: unknown) => e)).toMatchObject({ status: 0, code: 'timeout' })
})

test('logout passes keepalive only when asked', async () => {
  const h = harness(() => empty(204))
  const c = h.client({ token: TOKEN })
  await c.logout()
  await c.logout({ keepalive: true })
  expect(h.calls[0]!.keepalive).toBeFalsy()
  expect(h.calls[1]!.keepalive).toBe(true)
})

test('the client never logs', async () => {
  const seen: unknown[] = []
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }
  for (const k of Object.keys(orig) as Array<keyof typeof orig>) console[k] = (...a: unknown[]) => { seen.push(a) }
  try {
    const h = harness(() => json({ error: { code: 'unauthorized', message: 'm' } }, 401))
    await h.client({ token: TOKEN }).account().catch(() => {})
  } finally { Object.assign(console, orig) }
  expect(seen).toEqual([])
})

test('a base with a trailing slash still works', async () => {
  const h = harness(() => json({ devices: [] }))
  await new ApiClient({ base: BASE + '/', fetch: (async (i: RequestInfo | URL, n?: RequestInit) => { h.calls.push({ url: new URL(String(i)) } as Call); void n; return json({ devices: [] }) }) as typeof fetch, token: TOKEN }).devices()
  expect(h.calls[0]!.url.pathname).toBe('/v1/devices')
})

// ---- blob timeouts: JSON keeps the flat timeout; uploads get time for the body; downloads time out only when idle
afterEach(() => { vi.useRealTimers() })

test('putBlob allows 30 s plus the time to send the body at 32 KB/s', async () => {
  vi.useFakeTimers()
  const body = new Uint8Array(32 * 60_000) // 1.92 MB: timeout 30 s + 60 s
  let aborted = false
  const slow = ((_: unknown, init?: RequestInit) => new Promise((res, rej) => {
    init?.signal?.addEventListener('abort', () => { aborted = true; rej(new DOMException('aborted', 'AbortError')) })
    setTimeout(() => res(json({ sha256: SHA, size: body.length })), 85_000)
  })) as typeof fetch
  const done = new ApiClient({ base: BASE, fetch: slow, token: TOKEN }).putBlob(SHA, body)
  await vi.advanceTimersByTimeAsync(31_000)
  expect(aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(60_000)
  await expect(done).resolves.toBeUndefined()
  expect(aborted).toBe(false)
})

test('putBlob still times out, after its longer allowance', async () => {
  vi.useFakeTimers()
  const hang = ((_: unknown, init?: RequestInit) => new Promise((_res, rej) => {
    init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
  })) as typeof fetch
  const p = new ApiClient({ base: BASE, fetch: hang, token: TOKEN }).putBlob(SHA, new Uint8Array(32 * 60_000)).catch((e: unknown) => e)
  await vi.advanceTimersByTimeAsync(91_000)
  expect(await p).toMatchObject({ status: 0, code: 'timeout' })
})

function chunkedFetch(chunks: number, every: number, stallAfter = Infinity): typeof fetch {
  return ((_: unknown, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        init?.signal?.addEventListener('abort', () => ctrl.error(new DOMException('aborted', 'AbortError')))
        for (let i = 1; i <= chunks; i++) {
          if (i > stallAfter) break
          setTimeout(() => { try { ctrl.enqueue(new Uint8Array([i])); if (i === chunks) ctrl.close() } catch { /* aborted */ } }, i * every)
        }
      },
    })
    return Promise.resolve(new Response(body, { status: 200 }))
  }) as typeof fetch
}

test('getBlob keeps going while chunks keep arriving (idle timeout, not total)', async () => {
  vi.useFakeTimers()
  const done = new ApiClient({ base: BASE, fetch: chunkedFetch(6, 20_000), token: TOKEN }).getBlob(SHA)
  await vi.advanceTimersByTimeAsync(125_000)
  expect(await done).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]))
})

test('getBlob fails with status 0, code timeout when no bytes arrive for 31 s', async () => {
  vi.useFakeTimers()
  const p = new ApiClient({ base: BASE, fetch: chunkedFetch(5, 20_000, 2), token: TOKEN }).getBlob(SHA).catch((e: unknown) => e)
  await vi.advanceTimersByTimeAsync(40_000 + 31_000)
  expect(await p).toMatchObject({ status: 0, code: 'timeout' })
})
