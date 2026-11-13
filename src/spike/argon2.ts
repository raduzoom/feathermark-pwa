// The device test page (built only with FEATHER_SPIKE=1). Races three Argon2id builds on the vector cases,
// each in its own worker, one derivation at a time, and shows match and time per case.
import argon2Vectors from '@vectors/argon2id.json'
import { fromHex, toHex } from '../core/bytes.ts'
import { deriveKeys } from '../core/crypto/kdf.ts'
import { createCryptoClient } from '../worker/crypto-client.ts'
import type { CompareImpl, CompareRequest, CompareResponse } from './argon2-compare.worker.ts'
import '../ui/tokens.css'
import '../ui/base.css'
import './argon2.css'

type Case = { name: string; password: string; salt: string; t: number; m_kib: number; p: number; root: string }
type Impl = 'hash-wasm' | CompareImpl
const cases = argon2Vectors.cases as Case[]
const IMPLS: Impl[] = ['hash-wasm', 'argon2id-simd', 'argon2id-nosimd']

const run = document.getElementById('run') as HTMLButtonElement
const summary = document.getElementById('summary') as HTMLOutputElement
const body = document.querySelector('#results tbody') as HTMLTableSectionElement
const report = document.getElementById('report') as HTMLPreElement

/** One derivation function per build; each lives in its own worker, stopped when its cases are done. */
function startImpl(impl: Impl): { derive: (c: Case) => Promise<Uint8Array>; expected: (c: Case) => string; stop: () => void } {
  if (impl === 'hash-wasm') {
    // The app's crypto worker keeps the root to itself, so this build is checked by the auth key the root
    // gives (one BLAKE2b after the Argon2id): it matches exactly when the root does.
    const client = createCryptoClient()
    return {
      derive: async (c) => {
        const { authKey, kek } = await client.logInKeys(c.password, fromHex(c.salt), { alg: 'argon2id13', t: c.t, m_kib: c.m_kib, p: c.p })
        await client.forget(kek)
        return authKey
      },
      expected: (c) => toHex(deriveKeys(fromHex(c.root)).authKey),
      stop: () => client.terminate(),
    }
  }
  const worker = new Worker(new URL('./argon2-compare.worker.ts', import.meta.url), { type: 'module' })
  return {
    derive: (c) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no answer in 90 s')), 90_000)
        worker.onmessage = (e: MessageEvent<CompareResponse>) => {
          clearTimeout(timer)
          if (e.data.ok) resolve(e.data.root)
          else reject(new Error(e.data.error))
        }
        worker.onerror = (e) => {
          clearTimeout(timer)
          reject(new Error(e.message || 'the worker stopped'))
        }
        const request: CompareRequest = { impl, password: c.password, salt: fromHex(c.salt), t: c.t, m_kib: c.m_kib, p: c.p }
        worker.postMessage(request)
      }),
    expected: (c) => c.root,
    stop: () => worker.terminate(),
  }
}

function cell(row: HTMLTableRowElement, text: string, className?: string) {
  const td = row.insertCell()
  td.textContent = text
  if (className) td.className = className
}

// Diagnosis: is the engine slow everywhere (a JavaScript loop is slow too, and Argon2id time grows with
// memory in proportion), or only with large memory (a jump at the big sizes)?
const diagnose = document.getElementById('diagnose') as HTMLButtonElement
const diagnosis = document.getElementById('diagnosis') as HTMLOutputElement
const diagnosisBody = document.querySelector('#diagnosis-results tbody') as HTMLTableSectionElement

function jsLoop(): number {
  let x = 1
  for (let i = 0; i < 200_000_000; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
  }
  return x
}

diagnose.addEventListener('click', async () => {
  diagnose.disabled = true
  diagnosis.removeAttribute('data-done')
  diagnosisBody.replaceChildren()
  const lines = [navigator.userAgent, `crossOriginIsolated ${self.crossOriginIsolated} · secure ${self.isSecureContext} · cores ${navigator.hardwareConcurrency}`]
  const step = async (name: string, work: () => Promise<unknown> | unknown) => {
    diagnosis.textContent = `Running ${name}…`
    const row = diagnosisBody.insertRow()
    row.dataset.step = name
    let ok = true
    let detail = ''
    const start = performance.now()
    try {
      await work()
    } catch (e) {
      ok = false
      detail = e instanceof Error ? e.message : String(e)
    }
    const ms = Math.round(performance.now() - start)
    row.dataset.ok = String(ok)
    cell(row, name)
    cell(row, ok ? 'Done' : `Error: ${detail}`)
    cell(row, String(ms), 'ms')
    lines.push(`${name}: ${ok ? 'ok' : 'error ' + detail} ${ms} ms`)
  }

  await step('js-loop', jsLoop)
  const runner = startImpl('argon2id-simd')
  try {
    for (const mib of [8, 32, 128, 256]) {
      const c: Case = { name: 'diagnosis', password: 'diagnosis', salt: '00112233445566778899aabbccddeeff', t: 1, m_kib: mib * 1024, p: 1, root: '' }
      await step(`argon2id-${mib}MiB`, () => runner.derive(c))
    }
  } finally {
    runner.stop()
  }
  diagnosis.textContent = 'Diagnosis done'
  diagnosis.dataset.done = 'true'
  report.textContent = lines.join('\n')
  diagnose.disabled = false
})

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : undefined)

run.addEventListener('click', async () => {
  run.disabled = true
  run.textContent = 'Running…'
  summary.removeAttribute('data-done')
  body.replaceChildren()
  const lines = [navigator.userAgent]
  const results: string[] = []
  const total = IMPLS.length * cases.length
  let done = 0

  for (const impl of IMPLS) {
    const runner = startImpl(impl)
    const times: number[] = []
    let matches = 0
    for (const c of cases) {
      summary.textContent = `Running ${++done} of ${total}…`
      const row = body.insertRow()
      row.dataset.impl = impl
      row.dataset.case = c.name
      let match = 'error'
      let detail = ''
      const start = performance.now()
      try {
        match = String(toHex(await runner.derive(c)) === runner.expected(c))
      } catch (e) {
        detail = e instanceof Error ? e.message : String(e)
      }
      const ms = Math.round(performance.now() - start)
      row.dataset.match = match
      if (match === 'true') {
        matches++
        times.push(ms)
      }
      cell(row, impl)
      cell(row, c.name)
      cell(row, match === 'true' ? 'Match' : match === 'false' ? 'Wrong result' : `Error: ${detail}`)
      cell(row, String(ms), 'ms')
      lines.push(`${impl} ${c.name}: ${match} ${ms} ms${detail ? ' ' + detail : ''}`)
    }
    runner.stop()
    const m = median(times)
    results.push(`${impl} ${matches}/${cases.length}` + (m === undefined ? '' : ` median ${m} ms`))
  }

  summary.textContent = results.join(' · ')
  summary.dataset.done = 'true'
  report.textContent = [...lines, summary.textContent].join('\n')
  run.disabled = false
  run.textContent = 'Run test'
})
