// The crypto vector cases (../universal/test-vectors/): shapes and helpers both test suites share, the unit
// tests in Node and the browser test page (spike/vectors.html). No Node or DOM APIs, and no crypto here.
import { fromHex } from '../../src/core/bytes.ts'
import type { Part } from '../../src/core/crypto/envelope.ts'
import type { CryptoErrorKind } from '../../src/core/crypto/errors.ts'

/** The vectors' error names, as crypto.md "Errors" maps them to our kinds. */
export const ERROR_KINDS: Record<string, CryptoErrorKind> = {
  authentication_failed: 'authentication',
  malformed_envelope: 'malformed',
  recovery_key_typo: 'typo',
}

const PARTS: Record<number, Part> = { 1: 'metadata', 2: 'noteBody', 3: 'attachment' }
export function partName(n: number): Part {
  const part = PARTS[n]
  if (!part) throw new Error(`unknown part ${n} in the vectors`)
  return part
}

export type EnvelopePositive = {
  name: string
  item_key: string
  item_id: string
  part: number
  nonce_prefix: string
  plaintext?: string
  plaintext_pattern?: string
  length?: number
  envelope?: string
  envelope_sha256?: string
  envelope_length?: number
}
export type EnvelopeNegative = {
  name: string
  item_key: string
  item_id: string
  expected_part: number
  error: string
  envelope?: string
  derived_from?: string
  mutation?: 'drop_last_chunk' | 'swap_chunks_0_1' | 'cut_last_chunk_to_10_bytes'
}
export type EnvelopeCase = EnvelopePositive | EnvelopeNegative

/** "byte i = i mod 251" for large plaintexts, else the hex. */
export const envelopePlaintext = (c: EnvelopePositive): Uint8Array =>
  c.plaintext !== undefined ? fromHex(c.plaintext) : Uint8Array.from({ length: c.length! }, (_, i) => i % 251)

/** A negative case's envelope: given, or a mutation of a positive case's (README "Mutations"). */
export function envelopeBytes(c: EnvelopeNegative, sealed: (name: string) => Uint8Array): Uint8Array {
  if (c.envelope !== undefined) return fromHex(c.envelope)
  const source = sealed(c.derived_from!)
  const header = source.subarray(0, 34)
  const body = source.subarray(34)
  const S = 65552
  const n = body.length
  const k = Math.ceil(n / S)
  const parts =
    c.mutation === 'drop_last_chunk'
      ? [body.subarray(0, S * (k - 1))]
      : c.mutation === 'swap_chunks_0_1'
        ? [body.subarray(S, 2 * S), body.subarray(0, S), body.subarray(2 * S, n)]
        : c.mutation === 'cut_last_chunk_to_10_bytes'
          ? [body.subarray(0, S * (k - 1)), body.subarray(n - 10, n)]
          : null
  if (!parts) throw new Error(`unknown mutation ${c.mutation}`)
  return concat([header, ...parts])
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
