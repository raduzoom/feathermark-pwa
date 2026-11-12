/// <reference lib="webworker" />
// Crypto runs here so the page never waits on it. Every failure, including a failed 256 MiB
// allocation, is answered as an error, never left hanging.
import { deriveRoot } from '../core/crypto/argon2.ts'
import type { CryptoRequest, CryptoResponse } from './crypto-protocol.ts'

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = async (event: MessageEvent<CryptoRequest>) => {
  const { id, password, salt, kdf } = event.data
  let response: CryptoResponse
  try {
    response = { id, ok: true, root: await deriveRoot(password, salt, kdf) }
  } catch (e) {
    response = { id, ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
  }
  scope.postMessage(response)
}
