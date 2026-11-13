import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { fromHex, toHex } from '../../src/core/bytes.ts'
import { open, seal, type Part } from '../../src/core/crypto/envelope.ts'
import { envelopeBytes, envelopePlaintext, partName, type EnvelopeCase, type EnvelopeNegative, type EnvelopePositive } from '../shared/vector-cases.ts'
import { expectCryptoError, loadVectors } from './vectors.ts'

const { cases } = loadVectors<EnvelopeCase>('envelope.json')
const positive = cases.filter((c): c is EnvelopePositive => !('error' in c))
const negative = cases.filter((c): c is EnvelopeNegative => 'error' in c)
const byName = new Map(positive.map((c) => [c.name, c]))

const plaintextOf = envelopePlaintext

const sealCase = (c: EnvelopePositive) => seal(plaintextOf(c), partName(c.part), c.item_id, fromHex(c.item_key), fromHex(c.nonce_prefix))
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

test('the vector file has positive, large and negative cases', () => {
  expect(positive.some((c) => c.plaintext_pattern)).toBe(true)
  expect(negative.some((c) => c.mutation)).toBe(true)
})

test.each(positive)('seals $name to the exact bytes', (c) => {
  const envelope = sealCase(c)
  if (c.envelope !== undefined) expect(toHex(envelope)).toBe(c.envelope)
  else {
    expect(envelope.length).toBe(c.envelope_length)
    expect(sha256(envelope)).toBe(c.envelope_sha256)
  }
})

test.each(positive)('opens $name', (c) => {
  const envelope = c.envelope !== undefined ? fromHex(c.envelope) : sealCase(c)
  const plain = open(envelope, partName(c.part), c.item_id, fromHex(c.item_key))
  expect(toHex(plain)).toBe(toHex(plaintextOf(c)))
})

test.each(negative)('refuses $name', (c) => {
  const envelope = envelopeBytes(c, (name) => sealCase(byName.get(name)!))
  expectCryptoError(() => open(envelope, partName(c.expected_part), c.item_id, fromHex(c.item_key)), c.error)
})

test('a fresh seal uses a random nonce prefix and opens', () => {
  const c = positive.find((p) => p.name === 'hello_world')!
  const part: Part = partName(c.part)
  const a = seal(fromHex(c.plaintext!), part, c.item_id, fromHex(c.item_key))
  const b = seal(fromHex(c.plaintext!), part, c.item_id, fromHex(c.item_key))
  expect(toHex(a.subarray(18, 34))).not.toBe(toHex(b.subarray(18, 34)))
  expect(toHex(open(a, part, c.item_id, fromHex(c.item_key)))).toBe(c.plaintext)
})

test('invalid arguments are TypeErrors, before any crypto', () => {
  const c = positive.find((p) => p.name === 'hello_world')!
  const key = fromHex(c.item_key)
  const plain = fromHex(c.plaintext!)
  expect(() => seal(plain, 'body' as Part, c.item_id, key)).toThrow(TypeError)
  expect(() => seal(plain, 'noteBody', 'not an id', key)).toThrow(TypeError)
  expect(() => seal(plain, 'noteBody', c.item_id, new Uint8Array(16))).toThrow(TypeError)
  expect(() => seal(plain, 'noteBody', c.item_id, key, new Uint8Array(24))).toThrow(TypeError)
  expect(() => open(fromHex(c.envelope!), 'noteBody', 'not an id', key)).toThrow(TypeError)
  expect(() => open(fromHex(c.envelope!), 'noteBody', c.item_id, new Uint8Array(16))).toThrow(TypeError)
})
