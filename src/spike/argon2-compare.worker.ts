/// <reference lib="webworker" />
// Test page only: runs the openpgpjs argon2id package (SIMD or non-SIMD build) so the device page can race
// it against hash-wasm. Not used by the app.
import setupWasm from 'argon2id/lib/setup.js'
import noSimdUrl from 'argon2id/dist/no-simd.wasm?url'
import simdUrl from 'argon2id/dist/simd.wasm?url'
import { normalizePassword } from '../core/crypto/argon2.ts'

export type CompareImpl = 'argon2id-simd' | 'argon2id-nosimd'
export type CompareRequest = { impl: CompareImpl; password: string; salt: Uint8Array; t: number; m_kib: number; p: number }
export type CompareResponse = { ok: true; root: Uint8Array } | { ok: false; error: string }

const scope = self as unknown as DedicatedWorkerGlobalScope
const loader = (url: string) => async (imports: WebAssembly.Imports) =>
  WebAssembly.instantiate(await (await fetch(url)).arrayBuffer(), imports)

let hash: Promise<Awaited<ReturnType<typeof setupWasm>>> | null = null

scope.onmessage = async (event: MessageEvent<CompareRequest>) => {
  const r = event.data
  let response: CompareResponse
  try {
    // The non-SIMD build is forced by passing its loader in both slots.
    const load = loader(r.impl === 'argon2id-simd' ? simdUrl : noSimdUrl)
    hash ??= setupWasm(load, load)
    const argon2id = await hash
    const root = argon2id({ password: normalizePassword(r.password), salt: r.salt, parallelism: r.p, passes: r.t, memorySize: r.m_kib, tagLength: 32 })
    response = { ok: true, root }
  } catch (e) {
    response = { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
  }
  scope.postMessage(response)
}
