import { expect, test } from 'vitest'
import { fromHex, toHex } from '../../src/core/bytes.ts'
import { deriveKeys, itemKey, recoveryKeys } from '../../src/core/crypto/kdf.ts'
import { ulidToBytes } from '../../src/core/crypto/ulid-bytes.ts'
import { loadVectors } from './vectors.ts'

type Case =
  | { name: string; kind: 'password'; root: string; kek: string; auth_key: string }
  | { name: string; kind: 'item'; master_key: string; item_id: string; item_id_bytes: string; item_key: string }
  | { name: string; kind: 'recovery'; recovery_key: string; recovery_kek: string; recovery_auth_key: string }
const { cases } = loadVectors<Case>('derive.json')

test('the vector file has a case of each kind', () => {
  expect(new Set(cases.map((c) => c.kind))).toEqual(new Set(['password', 'item', 'recovery']))
})

test.each(cases)('derives $name', (c) => {
  if (c.kind === 'password') {
    const { kek, authKey } = deriveKeys(fromHex(c.root))
    expect([toHex(kek), toHex(authKey)]).toEqual([c.kek, c.auth_key])
  } else if (c.kind === 'item') {
    expect(toHex(ulidToBytes(c.item_id))).toBe(c.item_id_bytes)
    expect(toHex(itemKey(fromHex(c.master_key), c.item_id))).toBe(c.item_key)
  } else {
    const { recoveryKek, recoveryAuthKey } = recoveryKeys(fromHex(c.recovery_key))
    expect([toHex(recoveryKek), toHex(recoveryAuthKey)]).toEqual([c.recovery_kek, c.recovery_auth_key])
  }
})

const item = cases.find((c) => c.kind === 'item')!

test('ulidToBytes reads lowercase as uppercase', () => {
  expect(toHex(ulidToBytes(item.item_id.toLowerCase()))).toBe(item.item_id_bytes)
})

test('ulidToBytes gives the low 128 bits, big-endian', () => {
  expect(toHex(ulidToBytes('00000000000000000000000000'))).toBe('00'.repeat(16))
  expect(toHex(ulidToBytes('7ZZZZZZZZZZZZZZZZZZZZZZZZZ'))).toBe('ff'.repeat(16))
  expect(toHex(ulidToBytes('00000000000000000000000001'))).toBe('00'.repeat(15) + '01')
})

test.each([
  ['I', '0000000000000000000000000I'],
  ['L', '0000000000000000000000000L'],
  ['O', '0000000000000000000000000O'],
  ['U', '0000000000000000000000000U'],
  ['a lowercase i', '0000000000000000000000000i'],
  ['a first character of 8', '80000000000000000000000000'],
  ['a first character of Z', 'Z0000000000000000000000000'],
  ['25 characters', '0000000000000000000000000'],
  ['27 characters', '000000000000000000000000000'],
  ['a non-ASCII letter that uppercases to S', '0000000000000000000000000ſ'],
  ['the empty string', ''],
])('ulidToBytes refuses %s with a TypeError', (_name, text) => {
  expect(() => ulidToBytes(text)).toThrow(TypeError)
})

test('itemKey refuses a non-ULID id and a master key that is not 32 bytes before any crypto', () => {
  expect(() => itemKey(fromHex(item.master_key), 'not an id')).toThrow(TypeError)
  expect(() => itemKey(new Uint8Array(31), item.item_id)).toThrow(TypeError)
  expect(() => deriveKeys(new Uint8Array(16))).toThrow(TypeError)
  expect(() => recoveryKeys(new Uint8Array(32))).toThrow(TypeError)
})
