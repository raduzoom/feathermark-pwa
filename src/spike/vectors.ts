// The crypto vectors test page (built only with FEATHER_SPIKE=1). Runs every vector file in a browser worker:
// the pure functions in a test worker, then the same values through the app's crypto worker and its client,
// where the master key and keks stay behind handles.
import argon2Vectors from '@vectors/argon2id.json'
import deriveVectors from '@vectors/derive.json'
import envelopeVectors from '@vectors/envelope.json'
import recoveryVectors from '@vectors/recovery.json'
import wrapVectors from '@vectors/wrap.json'
import { fromHex, toHex } from '../core/bytes.ts'
import { seal } from '../core/crypto/envelope.ts'
import { CryptoError } from '../core/crypto/errors.ts'
import { deriveKeys, recoveryKeys } from '../core/crypto/kdf.ts'
import { encodeRecoveryKey } from '../core/crypto/recovery.ts'
import { systemClock } from '../core/clock.ts'
import { newUlid } from '../core/ulid.ts'
import { createCryptoClient, type CryptoClient } from '../worker/crypto-client.ts'
import {
  ERROR_KINDS,
  envelopeBytes,
  envelopePlaintext,
  partName,
  type EnvelopeCase,
  type EnvelopePositive,
} from '../../tests/shared/vector-cases.ts'
import type { VectorsWorkerResponse } from './vectors.worker.ts'
import '../ui/tokens.css'
import '../ui/base.css'
import './argon2.css'
import './vectors.css'

type Row = { file: string; where: string; passed: number; failed: number; skipped: number; failures: string[] }
type Str = Record<string, string | undefined>

const run = document.getElementById('run') as HTMLButtonElement
const summary = document.getElementById('summary') as HTMLOutputElement
const body = document.querySelector('#results tbody') as HTMLTableSectionElement
const report = document.getElementById('report') as HTMLPreElement

const kindOf = (e: unknown) => (e instanceof CryptoError ? e.kind : `${e instanceof Error ? e.name : 'thrown'}: ${String(e)}`)

const row = (where: string, file: string): Row => ({ where, file, passed: 0, failed: 0, skipped: 0, failures: [] })

/** Counts one case: passed when `ok` resolves true. */
async function check(r: Row, name: string, ok: () => Promise<boolean>) {
  let pass = false
  let detail = ''
  try {
    pass = await ok()
  } catch (e) {
    detail = `: ${kindOf(e)}`
  }
  if (pass) r.passed++
  else {
    r.failed++
    r.failures.push(name + detail)
  }
}

/** The pure functions, in a worker of their own. */
function runFunctions(): Promise<Row[]> {
  const worker = new Worker(new URL('./vectors.worker.ts', import.meta.url), { type: 'module' })
  return new Promise<Row[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer in 60 s')), 60_000)
    worker.onmessage = (e: MessageEvent<VectorsWorkerResponse>) => {
      clearTimeout(timer)
      if (e.data.ok) resolve(e.data.results.map((r) => ({ ...r, where: 'functions', skipped: 0 })))
      else reject(new Error(e.data.error))
    }
    worker.onerror = (e) => {
      clearTimeout(timer)
      reject(new Error(e.message || 'the worker stopped'))
    }
    worker.postMessage('run')
  }).finally(() => worker.terminate())
}

/** The same values through the app's crypto worker: log in, unwrap, open, recover. */
async function runCryptoWorker(client: CryptoClient): Promise<Row[]> {
  const handles: number[] = []
  const keep = <T extends number>(h: T) => (handles.push(h), h)
  const derive = deriveVectors.cases as Str[]
  const passwordDerive = derive.find((c) => c.kind === 'password')!
  const recoveryDerive = derive.find((c) => c.kind === 'recovery')!

  // argon2id.json: each password logs in to the auth key its root gives. The ascii case's kek is the one
  // wrap.json wraps with.
  const argon = row('crypto worker', 'argon2id.json')
  const kekByHex = new Map<string, number>()
  for (const c of argon2Vectors.cases) {
    await check(argon, c.name, async () => {
      const login = await client.logInKeys(c.password, fromHex(c.salt), { alg: 'argon2id13', t: c.t, m_kib: c.m_kib, p: c.p })
      keep(login.kek)
      const expected = deriveKeys(fromHex(c.root))
      if (c.root === passwordDerive.root) kekByHex.set(toHex(expected.kek), login.kek)
      return toHex(login.authKey) === toHex(expected.authKey)
    })
  }

  // The recovery key, as text, gives the recovery kek wrap.json wraps with.
  const rec = await client.recoveryKeys(encodeRecoveryKey(fromHex(recoveryDerive.recovery_key!)))
  keep(rec.kek)
  if (toHex(rec.recoveryAuthKey) === recoveryDerive.recovery_auth_key) kekByHex.set(recoveryDerive.recovery_kek!, rec.kek)

  // wrap.json: unwrap with the kek handles; cases whose key no password or recovery key gives are skipped.
  const wrap = row('crypto worker', 'wrap.json')
  const sessions: number[] = []
  let skipped = 0
  for (const c of wrapVectors.cases as Str[]) {
    const kek = kekByHex.get(c.wrapping_key!)
    if (kek === undefined) {
      skipped++
      continue
    }
    const kind = c.kind as 'password' | 'recovery'
    await check(wrap, c.name!, async () => {
      if (c.error) {
        const e = await client.unwrap(fromHex(c.wrapped!), kek, kind).then(() => null, (e: unknown) => e)
        return kindOf(e) === ERROR_KINDS[c.error]
      }
      const { session } = await client.unwrap(fromHex(c.wrapped!), kek, kind)
      sessions.push(keep(session))
      return true
    })
  }
  wrap.skipped = skipped

  // envelope.json: every session opens every case (and seals and opens its plaintext again).
  const env = row('crypto worker', 'envelope.json')
  const all = envelopeVectors.cases as EnvelopeCase[]
  const positive = new Map(all.filter((c): c is EnvelopePositive => !('error' in c)).map((c) => [c.name, c]))
  const sealCase = (c: EnvelopePositive) => seal(envelopePlaintext(c), partName(c.part), c.item_id, fromHex(c.item_key), fromHex(c.nonce_prefix))
  for (const session of sessions) {
    for (const c of all) {
      await check(env, c.name, async () => {
        if ('error' in c) {
          const envelope = envelopeBytes(c, (name) => sealCase(positive.get(name)!))
          const [result] = await client.open(session, [{ envelope, part: partName(c.expected_part), id: c.item_id }])
          return !(result instanceof Uint8Array) && result?.error === ERROR_KINDS[c.error]
        }
        const plain = envelopePlaintext(c)
        const part = partName(c.part)
        const [fresh] = await client.seal(session, [{ plain, part, id: c.item_id }])
        const [given, again] = await client.open(session, [
          { envelope: c.envelope !== undefined ? fromHex(c.envelope) : sealCase(c), part, id: c.item_id },
          { envelope: fresh!, part, id: c.item_id },
        ])
        return [given, again].every((r) => r instanceof Uint8Array && toHex(r) === toHex(plain))
      })
    }
  }

  // recovery.json: parsing happens in the worker; a typo is told apart from a key that doesn't unwrap.
  const recovery = row('crypto worker', 'recovery.json')
  skipped = 0
  for (const c of recoveryVectors.cases as Str[]) {
    if (c.kind !== 'parse') {
      skipped++
      continue
    }
    await check(recovery, c.name!, async () => {
      if (c.error) {
        const e = await client.recoveryKeys(c.input!).then(() => null, (e: unknown) => e)
        return kindOf(e) === ERROR_KINDS[c.error]
      }
      const r = await client.recoveryKeys(c.input!)
      keep(r.kek)
      return toHex(r.recoveryAuthKey) === toHex(recoveryKeys(fromHex(c.recovery_key!)).recoveryAuthKey)
    })
  }
  recovery.skipped = skipped

  for (const h of handles) await client.forget(h)
  return [argon, wrap, env, recovery]
}

function cell(tr: HTMLTableRowElement, text: string) {
  tr.insertCell().textContent = text
}

run.addEventListener('click', async () => {
  run.disabled = true
  summary.removeAttribute('data-done')
  body.replaceChildren()
  summary.textContent = 'Running…'
  const rows: Row[] = []
  const client = createCryptoClient()
  try {
    rows.push(...(await runFunctions()))
    rows.push(...(await runCryptoWorker(client)))
    const failed = rows.reduce((n, r) => n + r.failed, 0)
    summary.textContent = failed === 0 ? `All ${rows.reduce((n, r) => n + r.passed, 0)} checks passed` : `${failed} checks failed`
  } catch (e) {
    summary.textContent = `Error: ${kindOf(e)}`
  } finally {
    client.terminate()
  }
  for (const r of rows) {
    const tr = body.insertRow()
    tr.dataset.file = r.file
    cell(tr, r.where)
    cell(tr, r.file)
    cell(tr, String(r.passed))
    cell(tr, String(r.failed))
    cell(tr, String(r.skipped))
  }
  report.textContent = JSON.stringify(rows)
  summary.dataset.done = 'true'
  run.disabled = false
})

// Account: sign up, then open what that session sealed from every other way in.
const accountRun = document.getElementById('account-run') as HTMLButtonElement
const account = document.getElementById('account') as HTMLOutputElement
const accountReport = document.getElementById('account-report') as HTMLPreElement

/** True when anything the worker returned holds 32 bytes that aren't an auth key. */
function keyBytesIn(value: unknown, field = ''): boolean {
  if (value instanceof Uint8Array) return value.length === 32 && field !== 'authKey' && field !== 'recoveryAuthKey'
  if (Array.isArray(value)) return value.some((v) => keyBytesIn(v))
  if (value && typeof value === 'object') return Object.entries(value).some(([k, v]) => keyBytesIn(v, k))
  return false
}

accountRun.addEventListener('click', async () => {
  accountRun.disabled = true
  account.removeAttribute('data-done')
  account.textContent = 'Running…'
  const client = createCryptoClient()
  const seen: unknown[] = []
  const see = <T>(v: T) => (seen.push(v), v)
  const text = new TextEncoder()
  const read = (rs: Array<Uint8Array | { error: string }>) => rs.map((r) => (r instanceof Uint8Array ? new TextDecoder().decode(r) : r.error))
  try {
    const password = 'correct horse battery staple'
    const id = newUlid(systemClock)
    const up = see(await client.signUpKeys(password))
    const sealed = see(
      await client.seal(up.session, [
        { plain: text.encode('a note title'), part: 'metadata', id },
        { plain: text.encode('a note body'), part: 'noteBody', id },
      ]),
    )
    const openWith = async (session: number) =>
      read(
        see(
          await client.open(session, [
            { envelope: sealed[0]!, part: 'metadata', id },
            { envelope: sealed[1]!, part: 'noteBody', id },
          ]),
        ),
      )

    const login = see(await client.logInKeys(password, up.salt, up.kdf))
    const loggedIn = see(await client.unwrap(up.wrappedPassword, login.kek, 'password'))
    const opened = await openWith(loggedIn.session)

    const rec = see(await client.recoveryKeys(up.recoveryText))
    const recovered = see(await client.unwrap(up.wrappedRecovery, rec.kek, 'recovery'))
    const recoveryOpened = await openWith(recovered.session)

    const changed = see(await client.newPassword(recovered.session, 'a brand new passphrase'))
    const login2 = see(await client.logInKeys('a brand new passphrase', changed.salt, changed.kdf))
    const third = see(await client.unwrap(changed.wrappedPassword, login2.kek, 'password'))
    const newPasswordOpened = await openWith(third.session)

    const wrong = see(await client.logInKeys('not the password at all', up.salt, up.kdf))
    const wrongPassword = await client.unwrap(up.wrappedPassword, wrong.kek, 'password').then(() => 'unlocked', kindOf)
    const typo = await client.recoveryKeys(up.recoveryText.slice(0, -1)).then(() => 'parsed', kindOf)

    await client.forget(loggedIn.session)
    const afterForget = await openWith(loggedIn.session).then(() => 'opened', () => 'rejected')
    for (const h of [wrong.kek, up.session, recovered.session, third.session]) await client.forget(h)

    accountReport.textContent = JSON.stringify({ opened, recoveryOpened, newPasswordOpened, wrongPassword, typo, afterForget, keyBytesSeen: keyBytesIn(seen) })
    account.textContent = 'Done'
  } catch (e) {
    account.textContent = `Error: ${kindOf(e)}`
    accountReport.textContent = JSON.stringify({ error: kindOf(e) })
  } finally {
    client.terminate()
  }
  account.dataset.done = 'true'
  accountRun.disabled = false
})
