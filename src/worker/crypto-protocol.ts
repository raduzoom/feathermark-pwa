// Messages between the page and the crypto worker. Keys that open things (master key, root, kek, recovery key)
// never cross: the page gets numeric handles for them.
import type { KdfParams } from '../core/crypto/argon2.ts'
import type { Part } from '../core/crypto/envelope.ts'
import type { CryptoErrorKind } from '../core/crypto/errors.ts'
import type { WrapKind } from '../core/crypto/wrap.ts'

export type SealRequest = { plain: Uint8Array; part: Part; id: string }
export type OpenRequest = { envelope: Uint8Array; part: Part; id: string }
export type OpenResult = Uint8Array | { error: CryptoErrorKind }

/** Account creation: what the server gets, the recovery key text to show once, and an unlocked session. */
export type SignUpKeys = {
  salt: Uint8Array
  kdf: KdfParams
  authKey: Uint8Array
  recoveryAuthKey: Uint8Array
  wrappedPassword: Uint8Array
  wrappedRecovery: Uint8Array
  recoveryText: string
  session: number
}
export type NewPasswordKeys = { salt: Uint8Array; kdf: KdfParams; authKey: Uint8Array; wrappedPassword: Uint8Array }

/** Each operation's arguments and result. */
export type CryptoOps = {
  signUpKeys: { args: [password: string]; result: SignUpKeys }
  logInKeys: { args: [password: string, salt: Uint8Array, kdf: KdfParams]; result: { authKey: Uint8Array; kek: number } }
  unwrap: { args: [wrapped: Uint8Array, kek: number, kind: WrapKind]; result: { session: number } }
  recoveryKeys: { args: [text: string]; result: { recoveryAuthKey: Uint8Array; kek: number } }
  newPassword: { args: [session: number, password: string]; result: NewPasswordKeys }
  seal: { args: [session: number, items: SealRequest[]]; result: Uint8Array[] }
  open: { args: [session: number, items: OpenRequest[]]; result: OpenResult[] }
  forget: { args: [handle: number]; result: void }
}
export type CryptoOp = keyof CryptoOps

export type CryptoRequest = { [K in CryptoOp]: { id: number; op: K; args: CryptoOps[K]['args'] } }[CryptoOp]
export type CryptoResponse =
  | { id: number; ok: true; result: unknown }
  /** `name` is the error's class name; `kind` is set for a CryptoError. */
  | { id: number; ok: false; name: string; error: string; kind?: CryptoErrorKind }
