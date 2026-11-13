// The crypto worker's state and operations, kept apart from the message plumbing so Node can test them. Master
// keys and keks live only here, behind numeric handles; plaintext and envelopes go back to the page.
import { ARGON2_V1, deriveRoot, type KdfParams } from '../core/crypto/argon2.ts'
import { open, seal } from '../core/crypto/envelope.ts'
import { CryptoError, InvalidArgument, randomBytes } from '../core/crypto/errors.ts'
import { deriveKeys, itemKey, recoveryKeys } from '../core/crypto/kdf.ts'
import { encodeRecoveryKey, parseRecoveryKey } from '../core/crypto/recovery.ts'
import { unwrapMasterKey, wrapMasterKey, type WrapKind } from '../core/crypto/wrap.ts'
import type { CryptoOps, NewPasswordKeys, OpenRequest, OpenResult, SealRequest, SignUpKeys } from './crypto-protocol.ts'

export type KeyringOptions = {
  /** Tests only: sees each master key and kek as it is stored, to check that forget wipes it. */
  onKey?: (key: Uint8Array) => void
}

type Keyring = { [K in keyof CryptoOps]: (...args: CryptoOps[K]['args']) => Promise<CryptoOps[K]['result']> } & {
  /** How many sessions and kek handles are held (tests). */
  held(): { sessions: number; keks: number }
}

const wipe = (...keys: Uint8Array[]) => keys.forEach((k) => k.fill(0))

export function createKeyring(opts: KeyringOptions = {}): Keyring {
  // One handle space for sessions and keks, so forget(handle) takes either.
  const sessions = new Map<number, { master: Uint8Array; keks: Set<number> }>()
  const keks = new Map<number, Uint8Array>()
  let next = 1

  const store = (key: Uint8Array) => {
    opts.onKey?.(key)
    return key
  }
  const newSession = (master: Uint8Array) => {
    const handle = next++
    sessions.set(handle, { master: store(master), keks: new Set() })
    return handle
  }
  const newKek = (kek: Uint8Array) => {
    const handle = next++
    keks.set(handle, store(kek))
    return handle
  }
  const session = (handle: number) => {
    const s = sessions.get(handle)
    if (!s) throw new InvalidArgument('no such session')
    return s
  }
  const items = <T>(list: T[]): T[] => {
    if (!Array.isArray(list)) throw new InvalidArgument('items must be an array')
    return list
  }

  /** Argon2id, then kek and auth_key; the root is wiped. */
  const passwordKeys = async (password: string, salt: Uint8Array, kdf: KdfParams) => {
    if (typeof password !== 'string') throw new InvalidArgument('password must be a string')
    const root = await deriveRoot(password, salt, kdf)
    try {
      return deriveKeys(root)
    } finally {
      wipe(root)
    }
  }

  return {
    async signUpKeys(password: string): Promise<SignUpKeys> {
      const salt = randomBytes(16)
      const kdf = { ...ARGON2_V1 }
      const { kek, authKey } = await passwordKeys(password, salt, kdf)
      const master = randomBytes(32)
      const recoveryKey = randomBytes(16)
      const { recoveryKek, recoveryAuthKey } = recoveryKeys(recoveryKey)
      try {
        return {
          salt,
          kdf,
          authKey,
          recoveryAuthKey,
          wrappedPassword: wrapMasterKey(master, kek, 'password'),
          wrappedRecovery: wrapMasterKey(master, recoveryKek, 'recovery'),
          recoveryText: encodeRecoveryKey(recoveryKey),
          session: newSession(master),
        }
      } finally {
        wipe(kek, recoveryKek, recoveryKey)
      }
    },

    async logInKeys(password: string, salt: Uint8Array, kdf: KdfParams) {
      const { kek, authKey } = await passwordKeys(password, salt, kdf)
      return { authKey, kek: newKek(kek) }
    },

    async unwrap(wrapped: Uint8Array, kekHandle: number, kind: WrapKind) {
      const kek = keks.get(kekHandle)
      if (!kek) throw new InvalidArgument('no such key handle')
      const master = unwrapMasterKey(wrapped, kek, kind)
      const handle = newSession(master)
      sessions.get(handle)!.keks.add(kekHandle)
      return { session: handle }
    },

    async recoveryKeys(text: string) {
      const recoveryKey = parseRecoveryKey(text)
      try {
        const { recoveryKek, recoveryAuthKey } = recoveryKeys(recoveryKey)
        return { recoveryAuthKey, kek: newKek(recoveryKek) }
      } finally {
        wipe(recoveryKey)
      }
    },

    async newPassword(handle: number, password: string): Promise<NewPasswordKeys> {
      session(handle)
      const salt = randomBytes(16)
      const kdf = { ...ARGON2_V1 }
      const { kek, authKey } = await passwordKeys(password, salt, kdf)
      try {
        // Looked up again: the session may have been forgotten (and its key wiped) during the derivation.
        return { salt, kdf, authKey, wrappedPassword: wrapMasterKey(session(handle).master, kek, 'password') }
      } finally {
        wipe(kek)
      }
    },

    async seal(handle: number, list: SealRequest[]) {
      const { master } = session(handle)
      return items(list).map(({ plain, part, id }) => {
        const key = itemKey(master, id)
        try {
          return seal(plain, part, id, key)
        } finally {
          wipe(key)
        }
      })
    },

    async open(handle: number, list: OpenRequest[]): Promise<OpenResult[]> {
      const { master } = session(handle)
      return items(list).map(({ envelope, part, id }) => {
        const key = itemKey(master, id)
        try {
          return open(envelope, part, id, key)
        } catch (e) {
          if (e instanceof CryptoError) return { error: e.kind }
          throw e
        } finally {
          wipe(key)
        }
      })
    },

    async forget(handle: number) {
      const s = sessions.get(handle)
      if (s) {
        for (const k of s.keks) {
          const kek = keks.get(k)
          if (kek) wipe(kek)
          keks.delete(k)
        }
        wipe(s.master)
        sessions.delete(handle)
      }
      const kek = keks.get(handle)
      if (kek) {
        wipe(kek)
        keks.delete(handle)
      }
    },

    held: () => ({ sessions: sessions.size, keks: keks.size }),
  }
}
