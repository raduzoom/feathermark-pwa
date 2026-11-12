import type { KdfParams } from '../core/crypto/argon2.ts'

export type CryptoRequest = { id: number; op: 'deriveRoot'; password: string; salt: Uint8Array; kdf: KdfParams }
export type CryptoResponse = { id: number; ok: true; root: Uint8Array } | { id: number; ok: false; error: string }
