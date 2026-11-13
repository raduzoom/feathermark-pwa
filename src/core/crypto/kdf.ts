// Keyed BLAKE2b key derivations (crypto.md, "Key derivations"). Plain keyed BLAKE2b with a 32-byte output: no
// salt, no personalization.
import { blake2b } from '@noble/hashes/blake2.js'
import { requireBytes } from './errors.ts'
import { ulidToBytes } from './ulid-bytes.ts'

const ascii = (s: string) => new TextEncoder().encode(s)
const PASSWORD_KEK = ascii('feather/v1/password-kek')
const AUTH = ascii('feather/v1/auth')
const ITEM = ascii('feather/v1/item')
const RECOVERY_KEK = ascii('feather/v1/recovery-kek')
const RECOVERY_AUTH = ascii('feather/v1/recovery-auth')

const derive = (key: Uint8Array, message: Uint8Array) => blake2b(message, { key, dkLen: 32 })

/** kek and auth_key from the Argon2id root. */
export function deriveKeys(root: Uint8Array): { kek: Uint8Array; authKey: Uint8Array } {
  requireBytes(root, 32, 'root')
  return { kek: derive(root, PASSWORD_KEK), authKey: derive(root, AUTH) }
}

/** item_key = BLAKE2b(key: master_key, "feather/v1/item" || binary item id). */
export function itemKey(master: Uint8Array, id: string): Uint8Array {
  requireBytes(master, 32, 'master key')
  const message = new Uint8Array(ITEM.length + 16)
  message.set(ITEM)
  message.set(ulidToBytes(id), ITEM.length)
  return derive(master, message)
}

/** recovery_kek and recovery_auth_key from the 16-byte recovery key. */
export function recoveryKeys(recoveryKey: Uint8Array): { recoveryKek: Uint8Array; recoveryAuthKey: Uint8Array } {
  requireBytes(recoveryKey, 16, 'recovery key')
  return { recoveryKek: derive(recoveryKey, RECOVERY_KEK), recoveryAuthKey: derive(recoveryKey, RECOVERY_AUTH) }
}
