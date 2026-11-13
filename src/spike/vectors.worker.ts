/// <reference lib="webworker" />
// Test page only: runs the crypto vector files through the pure functions (src/core/crypto) in a worker, the
// context the app's crypto worker runs them in. Acts only on messages.
import derive from '@vectors/derive.json'
import envelope from '@vectors/envelope.json'
import recovery from '@vectors/recovery.json'
import wrap from '@vectors/wrap.json'
import { toHex } from '../core/bytes.ts'
import { runVectorFile, type VectorFile, type VectorResult } from '../../tests/shared/crypto-vectors.ts'

const scope = self as unknown as DedicatedWorkerGlobalScope
const FILES: Record<string, unknown> = { 'derive.json': derive, 'wrap.json': wrap, 'envelope.json': envelope, 'recovery.json': recovery }
const sha256 = async (bytes: Uint8Array) => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)))

export type VectorsWorkerResponse = { ok: true; results: VectorResult[] } | { ok: false; error: string }

scope.onmessage = async () => {
  let response: VectorsWorkerResponse
  try {
    const results: VectorResult[] = []
    for (const [file, data] of Object.entries(FILES)) results.push(await runVectorFile(file, data as VectorFile, sha256))
    response = { ok: true, results }
  } catch (e) {
    response = { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
  }
  scope.postMessage(response)
}
