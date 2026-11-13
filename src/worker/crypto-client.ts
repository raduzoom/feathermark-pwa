import { CRYPTO_ERROR_KINDS, CryptoError, InvalidArgument } from '../core/crypto/errors.ts'
import type { CryptoOp, CryptoOps, CryptoRequest, CryptoResponse } from './crypto-protocol.ts'

export type { NewPasswordKeys, OpenRequest, OpenResult, SealRequest, SignUpKeys } from './crypto-protocol.ts'

/** The part of a Worker the client uses, so tests can drive a fake one. */
export type WorkerLike = {
  postMessage(message: CryptoRequest): void
  terminate(): void
  onmessage: ((e: MessageEvent<CryptoResponse>) => void) | null
  onerror: ((e: ErrorEvent) => void) | null
  onmessageerror: ((e: MessageEvent) => void) | null
}

export type CryptoClientOptions = {
  worker?: () => WorkerLike
  /** A request with no answer after this long rejects and stops the worker. */
  timeoutMs?: number
}

export type CryptoClient = { [K in CryptoOp]: (...args: CryptoOps[K]['args']) => Promise<CryptoOps[K]['result']> } & {
  terminate(): void
}

const startWorker = (): WorkerLike =>
  new Worker(new URL('./crypto.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike

const OPS: CryptoOp[] = ['signUpKeys', 'logInKeys', 'unwrap', 'recoveryKeys', 'newPassword', 'seal', 'open', 'forget']

/** The worker's error as the matching class: CryptoError with its kind, TypeError for invalid arguments. */
function errorFrom(r: Extract<CryptoResponse, { ok: false }>): Error {
  if (r.kind !== undefined && CRYPTO_ERROR_KINDS.includes(r.kind)) return new CryptoError(r.kind, r.error)
  if (r.name === 'InvalidArgument' || r.name === 'TypeError') return new InvalidArgument(r.error)
  return new Error(`${r.name}: ${r.error}`)
}

/**
 * The crypto worker's API. The master key and keks stay in the worker; calls take and return handles for them
 * (`session`, `kek`). `forget(handle)` drops a session's master key and every kek handle it was unlocked with,
 * or a single kek handle.
 *
 * Every call settles: it resolves with the result, or rejects when the worker reports an error, fails to
 * load, dies, is stopped, or doesn't answer in time. Once the worker is gone, later calls reject at once.
 */
export function createCryptoClient(opts: CryptoClientOptions = {}): CryptoClient {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const worker = (opts.worker ?? startWorker)()
  const pending = new Map<number, { resolve: (result: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let dead: string | null = null
  let nextId = 1

  const die = (reason: string) => {
    if (dead === null) dead = reason
    worker.terminate()
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    pending.clear()
  }

  worker.onmessage = (event) => {
    const r = event.data
    const p = pending.get(r.id)
    if (!p) return
    pending.delete(r.id)
    clearTimeout(p.timer)
    if (r.ok) p.resolve(r.result)
    else p.reject(errorFrom(r))
  }
  worker.onerror = (event) => die(event.message || 'the crypto worker stopped')
  worker.onmessageerror = () => die('the crypto worker sent an unreadable message')

  const call = (op: CryptoOp, args: unknown[]): Promise<unknown> => {
    if (dead !== null) return Promise.reject(new Error(dead))
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => die('the crypto worker did not answer'), timeoutMs)
      pending.set(id, { resolve, reject, timer })
      try {
        worker.postMessage({ id, op, args } as CryptoRequest)
      } catch (e) {
        pending.delete(id)
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  const client = { terminate: () => die('the crypto worker was stopped') } as CryptoClient
  for (const op of OPS) (client as unknown as Record<string, unknown>)[op] = (...args: unknown[]) => call(op, args)
  return client
}
