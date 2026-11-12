// ULIDs as crypto.md "Ids" defines them: 26 Crockford base32 characters, 48 bits of time in ms, then 80 random bits.
import type { Clock } from './clock.ts'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function newUlid(clock: Clock): string {
  let time = clock()
  let out = ''
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[time % 32]! + out
    time = Math.floor(time / 32)
  }
  const random = crypto.getRandomValues(new Uint8Array(16))
  for (const byte of random) out += ALPHABET[byte % 32]!
  return out
}

export function isUlid(s: string): boolean {
  return /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(s.toUpperCase())
}

export function ulidTime(id: string): number {
  let t = 0
  for (const ch of id.slice(0, 10).toUpperCase()) t = t * 32 + ALPHABET.indexOf(ch)
  return t
}
