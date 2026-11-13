/// <reference lib="webworker" />
// Crypto runs here so the page never waits on it, and so the keys that open everything (master keys, keks)
// never reach the page: it holds numeric handles. Every request is answered, failures included (a failed
// 256 MiB allocation too), never left hanging. The worker acts only on messages.
import { CryptoError } from '../core/crypto/errors.ts'
import type { CryptoRequest, CryptoResponse } from './crypto-protocol.ts'
import { createKeyring } from './keyring.ts'

const scope = self as unknown as DedicatedWorkerGlobalScope
const keyring = createKeyring()

scope.onmessage = async (event: MessageEvent<CryptoRequest>) => {
  const { id, op, args } = event.data
  let response: CryptoResponse
  try {
    if (!Object.hasOwn(keyring, op) || op === ('held' as string)) throw new TypeError(`unknown operation ${String(op)}`)
    const run = keyring[op] as (...a: unknown[]) => Promise<unknown>
    response = { id, ok: true, result: await run(...(args as unknown[])) }
  } catch (e) {
    response =
      e instanceof CryptoError
        ? { id, ok: false, name: e.name, error: e.message, kind: e.kind }
        : { id, ok: false, name: e instanceof Error ? e.name : 'Error', error: e instanceof Error ? e.message : String(e) }
  }
  scope.postMessage(response)
}
