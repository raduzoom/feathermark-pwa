import { expect, test } from 'vitest'
import { ARGON2_V1 } from '../../src/core/crypto/argon2.ts'
import type { CryptoRequest, CryptoResponse } from '../../src/worker/crypto-protocol.ts'
import { createCryptoClient, type WorkerLike } from '../../src/worker/crypto-client.ts'

class FakeWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<CryptoResponse>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  onmessageerror: ((e: MessageEvent) => void) | null = null
  sent: CryptoRequest[] = []
  terminated = false
  throwOnPost = false
  postMessage(message: CryptoRequest) {
    if (this.throwOnPost) throw new Error('cannot clone')
    this.sent.push(message)
  }
  terminate() {
    this.terminated = true
  }
  answer(response: CryptoResponse) {
    this.onmessage?.({ data: response } as MessageEvent<CryptoResponse>)
  }
  fail(message: string) {
    this.onerror?.({ message } as ErrorEvent)
  }
}

const salt = new Uint8Array(16)
const setup = (timeoutMs = 60_000) => {
  const fake = new FakeWorker()
  return { fake, client: createCryptoClient({ worker: () => fake, timeoutMs }) }
}

test('passes the root through', async () => {
  const { fake, client } = setup()
  const call = client.deriveRoot('pw', salt, ARGON2_V1)
  fake.answer({ id: fake.sent[0]!.id, ok: true, root: new Uint8Array([7]) })
  await expect(call).resolves.toEqual(new Uint8Array([7]))
})

test('rejects calls after terminate', async () => {
  const { fake, client } = setup()
  client.terminate()
  expect(fake.terminated).toBe(true)
  await expect(client.deriveRoot('pw', salt, ARGON2_V1)).rejects.toThrow('the crypto worker was stopped')
})

test('rejects calls made after the worker failed to load', async () => {
  const { fake, client } = setup()
  fake.fail('script failed to load')
  await expect(client.deriveRoot('pw', salt, ARGON2_V1)).rejects.toThrow('script failed to load')
})

test('rejects a request the worker never answers, and stops the worker', async () => {
  const { fake, client } = setup(30)
  await expect(client.deriveRoot('pw', salt, ARGON2_V1)).rejects.toThrow('the crypto worker did not answer')
  expect(fake.terminated).toBe(true)
  await expect(client.deriveRoot('pw', salt, ARGON2_V1)).rejects.toThrow('the crypto worker did not answer')
})

test('rejects when the request cannot be sent', async () => {
  const { fake, client } = setup()
  fake.throwOnPost = true
  await expect(client.deriveRoot('pw', salt, ARGON2_V1)).rejects.toThrow('cannot clone')
})
