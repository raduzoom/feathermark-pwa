import { expect, test } from 'vitest'
import { fromHex, toHex } from '../../src/core/bytes.ts'
import { encodeRecoveryKey, parseRecoveryKey } from '../../src/core/crypto/recovery.ts'
import { expectCryptoError, loadVectors } from './vectors.ts'

type Format = { name: string; kind: 'format'; recovery_key: string; text: string }
type Parse = { name: string; kind: 'parse'; input: string; recovery_key: string }
type Typo = { name: string; kind: 'parse'; input: string; error: string }
const { cases } = loadVectors<Format | Parse | Typo>('recovery.json')
const formats = cases.filter((c): c is Format => c.kind === 'format')
const parses = cases.filter((c): c is Parse => c.kind === 'parse' && !('error' in c))
const typos = cases.filter((c): c is Typo => 'error' in c)

test('the vector file has format, parse and typo cases', () => {
  expect([formats.length, parses.length, typos.length].every((n) => n > 0)).toBe(true)
})

test.each(formats)('formats $name', (c) => {
  expect(encodeRecoveryKey(fromHex(c.recovery_key))).toBe(c.text)
})

test.each(formats)('parses what it formats: $name', (c) => {
  expect(toHex(parseRecoveryKey(c.text))).toBe(c.recovery_key)
})

test.each(parses)('parses $name', (c) => {
  expect(toHex(parseRecoveryKey(c.input))).toBe(c.recovery_key)
})

test.each(typos)('refuses $name as a typo', (c) => {
  expectCryptoError(() => parseRecoveryKey(c.input), c.error)
})

test('a recovery key that is not 16 bytes is a TypeError', () => {
  expect(() => encodeRecoveryKey(new Uint8Array(15))).toThrow(TypeError)
})
