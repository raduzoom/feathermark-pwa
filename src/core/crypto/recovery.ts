// Recovery key text (crypto.md, "Recovery key"): 128 key bits + 12 checksum bits as 28 Crockford base32
// characters, shown in 7 groups of 4.
import { blake2b } from '@noble/hashes/blake2.js'
import { CryptoError, requireBytes } from './errors.ts'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const SEPARATORS = /[\t\n\r \u00a0\u2010\u2011\u2012\u2013\u2014\u2212-]/g // crypto.md parsing step 1; hyphen-minus last

/** The first 12 bits of unkeyed BLAKE2b-256(key). */
function checksum(key: Uint8Array): number {
  const h = blake2b(key, { dkLen: 32 })
  return (h[0]! << 4) | (h[1]! >> 4)
}

function toBig(bytes: Uint8Array): bigint {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  return n
}

export function encodeRecoveryKey(key: Uint8Array): string {
  requireBytes(key, 16, 'recovery key')
  let bits = (toBig(key) << 12n) | BigInt(checksum(key))
  const chars: string[] = []
  for (let i = 0; i < 28; i++) {
    chars.unshift(ALPHABET[Number(bits & 31n)]!)
    bits >>= 5n
  }
  const groups: string[] = []
  for (let i = 0; i < 28; i += 4) groups.push(chars.slice(i, i + 4).join(''))
  return groups.join('-')
}

/** The 16-byte key, or CryptoError('typo') for a wrong length, a character outside the alphabet or a bad checksum. */
export function parseRecoveryKey(text: string): Uint8Array {
  if (typeof text !== 'string') throw new CryptoError('typo')
  const cleaned = text
    .replace(SEPARATORS, '')
    .replace(/[a-z]/g, (c) => c.toUpperCase())
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if ([...cleaned].length !== 28) throw new CryptoError('typo')
  let bits = 0n
  for (const c of cleaned) {
    const v = ALPHABET.indexOf(c)
    if (v < 0) throw new CryptoError('typo')
    bits = (bits << 5n) | BigInt(v)
  }
  const sum = Number(bits & 0xfffn)
  let n = bits >> 12n
  const key = new Uint8Array(16)
  for (let i = 15; i >= 0; i--) {
    key[i] = Number(n & 0xffn)
    n >>= 8n
  }
  if (checksum(key) !== sum) throw new CryptoError('typo')
  return key
}
