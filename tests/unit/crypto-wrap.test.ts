import { expect, test } from 'vitest'
import { fromHex, toHex } from '../../src/core/bytes.ts'
import { CryptoError } from '../../src/core/crypto/errors.ts'
import { unwrapMasterKey, wrapMasterKey, type WrapKind } from '../../src/core/crypto/wrap.ts'
import { expectCryptoError, loadVectors } from './vectors.ts'

type Positive = { name: string; kind: WrapKind; wrapping_key: string; master_key: string; nonce: string; wrapped: string }
type Negative = { name: string; kind: WrapKind; wrapping_key: string; wrapped: string; error: string }
type Case = Positive | Negative
const { cases } = loadVectors<Case>('wrap.json')
const positive = cases.filter((c): c is Positive => !('error' in c))
const negative = cases.filter((c): c is Negative => 'error' in c)

test('the vector file has positive and negative cases', () => {
  expect(positive.length).toBeGreaterThan(0)
  expect(negative.length).toBeGreaterThan(0)
})

test.each(positive)('wraps $name to the exact bytes', (c) => {
  const wrapped = wrapMasterKey(fromHex(c.master_key), fromHex(c.wrapping_key), c.kind, fromHex(c.nonce))
  expect(toHex(wrapped)).toBe(c.wrapped)
  expect(wrapped.length).toBe(74)
})

test.each(positive)('unwraps $name', (c) => {
  expect(toHex(unwrapMasterKey(fromHex(c.wrapped), fromHex(c.wrapping_key), c.kind))).toBe(c.master_key)
})

test.each(negative)('refuses $name', (c) => {
  expectCryptoError(() => unwrapMasterKey(fromHex(c.wrapped), fromHex(c.wrapping_key), c.kind), c.error)
})

test('a wrapped key of the wrong length or version is an authentication failure', () => {
  const c = positive[0]!
  const wrapped = fromHex(c.wrapped)
  const key = fromHex(c.wrapping_key)
  expectCryptoError(() => unwrapMasterKey(wrapped.subarray(0, 73), key, c.kind), 'authentication_failed')
  const v2 = wrapped.slice()
  v2[0] = 2
  expectCryptoError(() => unwrapMasterKey(v2, key, c.kind), 'authentication_failed')
})

test('a fresh wrap uses a random nonce and unwraps', () => {
  const c = positive[0]!
  const a = wrapMasterKey(fromHex(c.master_key), fromHex(c.wrapping_key), c.kind)
  const b = wrapMasterKey(fromHex(c.master_key), fromHex(c.wrapping_key), c.kind)
  expect(toHex(a)).not.toBe(toHex(b))
  expect(toHex(unwrapMasterKey(a, fromHex(c.wrapping_key), c.kind))).toBe(c.master_key)
})

test('wrong argument lengths are TypeErrors, not crypto errors', () => {
  const c = positive[0]!
  expect(() => wrapMasterKey(new Uint8Array(31), fromHex(c.wrapping_key), c.kind)).toThrow(TypeError)
  expect(() => wrapMasterKey(fromHex(c.master_key), new Uint8Array(16), c.kind)).toThrow(TypeError)
  expect(() => wrapMasterKey(fromHex(c.master_key), fromHex(c.wrapping_key), c.kind, new Uint8Array(12))).toThrow(TypeError)
  expect(() => wrapMasterKey(fromHex(c.master_key), fromHex(c.wrapping_key), 'other' as WrapKind)).toThrow(TypeError)
  expect(() => unwrapMasterKey(fromHex(c.wrapped), new Uint8Array(16), c.kind)).toThrow(TypeError)
  expect(new CryptoError('authentication')).not.toBeInstanceOf(TypeError)
})
