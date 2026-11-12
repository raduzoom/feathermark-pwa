import { expect, test } from 'vitest'
import { fromHex, toHex } from '../../src/core/bytes.ts'
import { ARGON2_V1, deriveRoot, normalizePassword } from '../../src/core/crypto/argon2.ts'
import { InvalidArgument } from '../../src/core/crypto/errors.ts'
import { loadVectors } from './vectors.ts'

type Case = { name: string; password: string; password_utf8_nfc: string; salt: string; t: number; m_kib: number; p: number; root: string }
const { cases } = loadVectors<Case>('argon2id.json')

test('the vector file has cases', () => {
  expect(cases.map((c) => c.name)).toEqual(expect.arrayContaining(['ascii', 'unicode_nfc', 'unicode_nfd']))
})

test.each(cases)('normalizes the password for $name', (c) => {
  expect(toHex(normalizePassword(c.password))).toBe(c.password_utf8_nfc)
})

test.each(cases)('derives the root for every vector case: $name', async (c) => {
  const root = await deriveRoot(c.password, fromHex(c.salt), { alg: 'argon2id13', t: c.t, m_kib: c.m_kib, p: c.p })
  expect(toHex(root)).toBe(c.root)
}, 60_000)

test.each([
  ['less memory', { ...ARGON2_V1, m_kib: 1024 }, 16],
  ['fewer passes', { ...ARGON2_V1, t: 1 }, 16],
  ['another algorithm', { ...ARGON2_V1, alg: 'argon2i' }, 16],
  ['a short salt', ARGON2_V1, 15],
] as const)('refuses %s before hashing', async (_name, kdf, saltLength) => {
  await expect(deriveRoot('correct horse battery staple', new Uint8Array(saltLength), kdf)).rejects.toBeInstanceOf(InvalidArgument)
})
