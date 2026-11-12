import type { KdfParams } from '../core/crypto/argon2.ts'
import type { CryptoRequest, CryptoResponse } from './crypto-protocol.ts'

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

const startWorker = (): WorkerLike =>
  new Worker(new URL('./crypto.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike

/**
 * Every call settles: it resolves with the result, or rejects when the worker reports an error, fails to
 * load, dies, is stopped, or doesn't answer in time. Once the worker is gone, later calls reject at once.
 */
export function createCryptoClient(opts: CryptoClientOptions = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const worker = (opts.worker ?? startWorker)()
  const pending = new Map<number, { resolve: (root: Uint8Array) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
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
    if (r.ok) p.resolve(r.root)
    else p.reject(new Error(r.error))
  }
  worker.onerror = (event) => die(event.message || 'the crypto worker stopped')
  worker.onmessageerror = () => die('the crypto worker sent an unreadable message')

  return {
    deriveRoot(password: string, salt: Uint8Array, kdf: KdfParams): Promise<Uint8Array> {
      if (dead !== null) return Promise.reject(new Error(dead))
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => die('the crypto worker did not answer'), timeoutMs)
        pending.set(id, { resolve, reject, timer })
        try {
          worker.postMessage({ id, op: 'deriveRoot', password, salt, kdf })
        } catch (e) {
          pending.delete(id)
          clearTimeout(timer)
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      })
    },
    terminate() {
      die('the crypto worker was stopped')
    },
  }
}
