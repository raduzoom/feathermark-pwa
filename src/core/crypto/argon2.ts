// Password derivation (crypto.md, "Normalization" and "Password derivation").
import { argon2id } from 'hash-wasm'
import { InvalidArgument } from './errors.ts'

export type KdfParams = { alg: string; t: number; m_kib: number; p: number }

/** The only parameters accepted. A server can't make a client allocate more, or derive with less. */
export const ARGON2_V1: KdfParams = Object.freeze({ alg: 'argon2id13', t: 3, m_kib: 262144, p: 1 })

/** NFC, then UTF-8. No trimming, no case change. */
export function normalizePassword(password: string): Uint8Array {
  return new TextEncoder().encode(password.normalize('NFC'))
}

/** root = Argon2id(NFC_UTF8(password), salt, t 3, 256 MiB, p 1) → 32 bytes. */
export async function deriveRoot(password: string, salt: Uint8Array, kdf: KdfParams): Promise<Uint8Array> {
  const v1 = kdf.alg === ARGON2_V1.alg && kdf.t === ARGON2_V1.t && kdf.m_kib === ARGON2_V1.m_kib && kdf.p === ARGON2_V1.p
  if (!v1) throw new InvalidArgument('unsupported KDF parameters')
  if (salt.length !== 16) throw new InvalidArgument('salt must be 16 bytes')
  return argon2id({
    password: normalizePassword(password),
    salt,
    iterations: kdf.t,
    memorySize: kdf.m_kib,
    parallelism: kdf.p,
    hashLength: 32,
    outputType: 'binary',
  })
}
