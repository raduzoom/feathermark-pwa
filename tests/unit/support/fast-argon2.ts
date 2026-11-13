// A stand-in for Argon2id in unit tests that sign in and unlock many times: the same parameter checks as
// deriveRoot (argon2.ts), with SHA-256 over salt and the NFC password in place of the 256 MiB hash, so a test runs
// in milliseconds. Different passwords still give different keys, so a wrong password still fails to unwrap.
// Use it through vi.mock (see session.test.ts); the real Argon2id is proved by argon2.test.ts and the vectors.
import { sha256 } from '@noble/hashes/sha2.js'
import type * as Argon2 from '../../../src/core/crypto/argon2.ts'
import { InvalidArgument } from '../../../src/core/crypto/errors.ts'

export function fastDeriveRoot(real: typeof Argon2): typeof Argon2.deriveRoot {
  return async (password, salt, kdf) => {
    const v1 = kdf.alg === real.ARGON2_V1.alg && kdf.t === real.ARGON2_V1.t && kdf.m_kib === real.ARGON2_V1.m_kib && kdf.p === real.ARGON2_V1.p
    if (!v1) throw new InvalidArgument('unsupported KDF parameters')
    if (salt.length !== 16) throw new InvalidArgument('salt must be 16 bytes')
    const pw = real.normalizePassword(password)
    const input = new Uint8Array(salt.length + pw.length)
    input.set(salt)
    input.set(pw, salt.length)
    return sha256(input)
  }
}
