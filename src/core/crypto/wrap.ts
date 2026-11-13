// Master key wrapping (crypto.md, "Master key wrapping"): version 0x01 || kind || nonce (24) || ciphertext+tag (48).
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { CryptoError, InvalidArgument, randomBytes, requireBytes } from './errors.ts'

export type WrapKind = 'password' | 'recovery'
const KIND_BYTE: Record<WrapKind, number> = { password: 0x01, recovery: 0x02 }
const VERSION = 0x01
export const WRAPPED_LENGTH = 74

function kindByte(kind: WrapKind): number {
  const byte = Object.hasOwn(KIND_BYTE, kind) ? KIND_BYTE[kind] : undefined
  if (byte === undefined) throw new InvalidArgument(`unknown wrap kind ${String(kind)}`)
  return byte
}

/** Wraps the 32-byte master key with `key` (kek for 'password', recovery_kek for 'recovery'). 74 bytes. */
export function wrapMasterKey(master: Uint8Array, key: Uint8Array, kind: WrapKind, nonce: Uint8Array = randomBytes(24)): Uint8Array {
  requireBytes(master, 32, 'master key')
  requireBytes(key, 32, 'wrapping key')
  requireBytes(nonce, 24, 'nonce')
  const header = new Uint8Array([VERSION, kindByte(kind)])
  const sealed = xchacha20poly1305(key, nonce, header).encrypt(master)
  const out = new Uint8Array(WRAPPED_LENGTH)
  out.set(header)
  out.set(nonce, 2)
  out.set(sealed, 26)
  return out
}

/**
 * The master key, or CryptoError('authentication') for any failure: wrong length, version, kind or key.
 * Clients must not tell these apart to the user.
 */
export function unwrapMasterKey(wrapped: Uint8Array, key: Uint8Array, kind: WrapKind): Uint8Array {
  requireBytes(key, 32, 'wrapping key')
  const expected = kindByte(kind)
  if (!(wrapped instanceof Uint8Array)) throw new InvalidArgument('wrapped key must be bytes')
  if (wrapped.length !== WRAPPED_LENGTH || wrapped[0] !== VERSION || wrapped[1] !== expected) throw new CryptoError('authentication')
  try {
    return xchacha20poly1305(key, wrapped.subarray(2, 26), wrapped.subarray(0, 2)).decrypt(wrapped.subarray(26))
  } catch {
    throw new CryptoError('authentication')
  }
}
