// Content envelopes (crypto.md, "Content envelope"): a 34-byte header, then the plaintext in 65,536-byte chunks,
// each XChaCha20-Poly1305 with nonce = nonce_prefix || uint64_be(index) and AD = header || final.
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { CryptoError, InvalidArgument, randomBytes, requireBytes } from './errors.ts'
import { ulidToBytes } from './ulid-bytes.ts'

export type Part = 'metadata' | 'noteBody' | 'attachment'
const PART_BYTE: Record<Part, number> = { metadata: 0x01, noteBody: 0x02, attachment: 0x03 }
const FORMAT = 0x01
const HEADER = 34
const TAG = 16
const CHUNK = 65536
const SEALED_CHUNK = CHUNK + TAG

function partByte(part: Part): number {
  const byte = Object.hasOwn(PART_BYTE, part) ? PART_BYTE[part] : undefined
  if (byte === undefined) throw new InvalidArgument(`unknown part ${String(part)}`)
  return byte
}

function nonceFor(prefix: Uint8Array, index: number): Uint8Array {
  const nonce = new Uint8Array(24)
  nonce.set(prefix)
  new DataView(nonce.buffer).setBigUint64(16, BigInt(index))
  return nonce
}

function adFor(header: Uint8Array, final: boolean): Uint8Array {
  const ad = new Uint8Array(HEADER + 1)
  ad.set(header)
  ad[HEADER] = final ? 0x01 : 0x00
  return ad
}

/** Encrypts `plain` as `part` of item `id` with its item key. `noncePrefix` (16) is random unless given (tests). */
export function seal(plain: Uint8Array, part: Part, id: string, key: Uint8Array, noncePrefix: Uint8Array = randomBytes(16)): Uint8Array {
  const pb = partByte(part)
  const idBytes = ulidToBytes(id)
  requireBytes(key, 32, 'item key')
  requireBytes(noncePrefix, 16, 'nonce prefix')
  if (!(plain instanceof Uint8Array)) throw new InvalidArgument('plaintext must be bytes')

  const chunks = Math.max(1, Math.ceil(plain.length / CHUNK))
  const out = new Uint8Array(HEADER + plain.length + TAG * chunks)
  out[0] = FORMAT
  out[1] = pb
  out.set(idBytes, 2)
  out.set(noncePrefix, 18)
  const header = out.slice(0, HEADER)
  let at = HEADER
  for (let i = 0; i < chunks; i++) {
    const final = i === chunks - 1
    const sealed = xchacha20poly1305(key, nonceFor(noncePrefix, i), adFor(header, final)).encrypt(plain.subarray(i * CHUNK, (i + 1) * CHUNK))
    out.set(sealed, at)
    at += sealed.length
  }
  return out
}

/**
 * Decodes an envelope expected to be `part` of item `id`, in the six steps of crypto.md "Decoding".
 * Throws CryptoError('malformed') or CryptoError('authentication'); never returns partial plaintext.
 */
export function open(envelope: Uint8Array, part: Part, id: string, key: Uint8Array): Uint8Array {
  const pb = partByte(part)
  const idBytes = ulidToBytes(id)
  requireBytes(key, 32, 'item key')
  if (!(envelope instanceof Uint8Array)) throw new InvalidArgument('envelope must be bytes')

  // 1, 2
  if (envelope.length < HEADER + TAG) throw new CryptoError('malformed', 'envelope too short')
  if (envelope[0] !== FORMAT) throw new CryptoError('malformed', 'unknown envelope format')
  // 3
  if (envelope[1] !== pb || !idBytes.every((b, i) => envelope[2 + i] === b)) throw new CryptoError('authentication', 'envelope for another item or part')
  // 4
  const n = envelope.length - HEADER
  const chunks = Math.ceil(n / SEALED_CHUNK)
  const last = n - SEALED_CHUNK * (chunks - 1)
  if (last < TAG) throw new CryptoError('malformed', 'last chunk shorter than a tag')
  // 5, 6
  const header = envelope.slice(0, HEADER)
  const prefix = header.subarray(18, 34)
  const plain = new Uint8Array(n - TAG * chunks)
  try {
    for (let i = 0; i < chunks; i++) {
      const start = HEADER + i * SEALED_CHUNK
      const end = i === chunks - 1 ? envelope.length : start + SEALED_CHUNK
      const opened = xchacha20poly1305(key, nonceFor(prefix, i), adFor(header, i === chunks - 1)).decrypt(envelope.subarray(start, end))
      plain.set(opened, i * CHUNK)
    }
  } catch {
    plain.fill(0)
    throw new CryptoError('authentication')
  }
  return plain
}
