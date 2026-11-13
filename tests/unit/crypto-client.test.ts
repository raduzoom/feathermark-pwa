import { expect, test } from 'vitest'
import { ARGON2_V1 } from '../../src/core/crypto/argon2.ts'
import { CryptoError } from '../../src/core/crypto/errors.ts'
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
  last() {
    return this.sent[this.sent.length - 1]!
  }
}

const salt = new Uint8Array(16)
const setup = (timeoutMs = 60_000) => {
  const fake = new FakeWorker()
  return { fake, client: createCryptoClient({ worker: () => fake, timeoutMs }) }
}
type Client = ReturnType<typeof setup>['client']

// Every call of the API, with the request it must send.
const CALLS: Array<[string, (c: Client) => Promise<unknown>, unknown[]]> = [
  ['signUpKeys', (c) => c.signUpKeys('pw'), ['pw']],
  ['logInKeys', (c) => c.logInKeys('pw', salt, ARGON2_V1), ['pw', salt, ARGON2_V1]],
  ['unwrap', (c) => c.unwrap(new Uint8Array(74), 3, 'password'), [new Uint8Array(74), 3, 'password']],
  ['recoveryKeys', (c) => c.recoveryKeys('DT1H'), ['DT1H']],
  ['newPassword', (c) => c.newPassword(4, 'pw'), [4, 'pw']],
  ['seal', (c) => c.seal(4, [{ plain: new Uint8Array([1]), part: 'metadata', id: '01JC8ZQ6V4N1XG2H3K5M7P9R0T' }]), [4, [{ plain: new Uint8Array([1]), part: 'metadata', id: '01JC8ZQ6V4N1XG2H3K5M7P9R0T' }]]],
  ['open', (c) => c.open(4, [{ envelope: new Uint8Array(50), part: 'noteBody', id: '01JC8ZQ6V4N1XG2H3K5M7P9R0T' }]), [4, [{ envelope: new Uint8Array(50), part: 'noteBody', id: '01JC8ZQ6V4N1XG2H3K5M7P9R0T' }]]],
  ['forget', (c) => c.forget(4), [4]],
]

test.each(CALLS)('%s sends its op and arguments and passes the result through', async (op, call, args) => {
  const { fake, client } = setup()
  const pending = call(client)
  expect(fake.last()).toEqual({ id: fake.last().id, op, args })
  const result = { any: 'result' }
  fake.answer({ id: fake.last().id, ok: true, result })
  await expect(pending).resolves.toEqual(result)
})

test('open passes per-item errors through', async () => {
  const { fake, client } = setup()
  const pending = client.open(1, [])
  fake.answer({ id: fake.last().id, ok: true, result: [new Uint8Array([1]), { error: 'authentication' }] })
  await expect(pending).resolves.toEqual([new Uint8Array([1]), { error: 'authentication' }])
})

test.each(['authentication', 'malformed', 'typo'] as const)('a %s error from the worker rejects with a CryptoError of that kind', async (kind) => {
  const { fake, client } = setup()
  const pending = client.recoveryKeys('x')
  fake.answer({ id: fake.last().id, ok: false, name: 'CryptoError', kind, error: kind })
  const e = await pending.catch((e: unknown) => e)
  expect(e).toBeInstanceOf(CryptoError)
  expect((e as CryptoError).kind).toBe(kind)
})

test('an invalid argument in the worker rejects with a TypeError', async () => {
  const { fake, client } = setup()
  const pending = client.seal(1, [])
  fake.answer({ id: fake.last().id, ok: false, name: 'InvalidArgument', error: 'not a ULID' })
  await expect(pending).rejects.toBeInstanceOf(TypeError)
})

test('any other worker error rejects with its name and message', async () => {
  const { fake, client } = setup()
  const pending = client.logInKeys('pw', salt, ARGON2_V1)
  fake.answer({ id: fake.last().id, ok: false, name: 'RangeError', error: 'out of memory' })
  await expect(pending).rejects.toThrow('RangeError: out of memory')
})

test.each(CALLS)('%s rejects after terminate', async (_op, call) => {
  const { fake, client } = setup()
  client.terminate()
  expect(fake.terminated).toBe(true)
  await expect(call(client)).rejects.toThrow('the crypto worker was stopped')
})

test.each(CALLS)('%s rejects when the worker dies while it waits, and after', async (_op, call) => {
  const { fake, client } = setup()
  const pending = call(client)
  fake.fail('script failed to load')
  await expect(pending).rejects.toThrow('script failed to load')
  await expect(call(client)).rejects.toThrow('script failed to load')
})

test.each(CALLS)('%s rejects when the worker sends an unreadable message', async (_op, call) => {
  const { fake, client } = setup()
  const pending = call(client)
  fake.onmessageerror?.({} as MessageEvent)
  await expect(pending).rejects.toThrow('unreadable')
})

test.each(CALLS)('%s rejects when the worker never answers, and stops the worker', async (_op, call) => {
  const { fake, client } = setup(30)
  await expect(call(client)).rejects.toThrow('the crypto worker did not answer')
  expect(fake.terminated).toBe(true)
  await expect(call(client)).rejects.toThrow('the crypto worker did not answer')
})

test.each(CALLS)('%s rejects when the request cannot be sent', async (_op, call) => {
  const { fake, client } = setup()
  fake.throwOnPost = true
  await expect(call(client)).rejects.toThrow('cannot clone')
})

test('an answer for an unknown request is ignored', async () => {
  const { fake, client } = setup()
  const pending = client.forget(1)
  fake.answer({ id: 999, ok: true, result: undefined })
  fake.answer({ id: fake.last().id, ok: true, result: undefined })
  await expect(pending).resolves.toBeUndefined()
})
