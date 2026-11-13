// The binary form of an item id (crypto.md, "Ids").
import { InvalidArgument } from './errors.ts'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * 26 Crockford base32 characters (ASCII lowercase read as uppercase; I, L, O and U refused; first character
 * 0–7) → the low 128 bits as 16 bytes, big-endian. Anything else is not an id: InvalidArgument (a TypeError).
 */
export function ulidToBytes(id: string): Uint8Array {
  if (typeof id !== 'string' || id.length !== 26) throw new InvalidArgument('not a ULID')
  let n = 0n
  for (let i = 0; i < 26; i++) {
    let c = id.charCodeAt(i)
    if (c >= 0x61 && c <= 0x7a) c -= 0x20 // ASCII a–z only; no Unicode case mapping
    const v = ALPHABET.indexOf(String.fromCharCode(c))
    if (v < 0 || (i === 0 && v > 7)) throw new InvalidArgument('not a ULID')
    n = (n << 5n) | BigInt(v)
  }
  const out = new Uint8Array(16)
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(n & 0xffn)
    n >>= 8n
  }
  return out
}
