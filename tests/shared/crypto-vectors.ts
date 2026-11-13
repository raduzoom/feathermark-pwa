// Runs whole crypto vector files and counts passes and failures, for the browser test page (spike/vectors.html),
// which runs it in a worker. The unit tests run the same cases one by one. No Node or DOM APIs here.
import { fromHex, toHex } from '../../src/core/bytes.ts'
import { deriveKeys, itemKey, recoveryKeys } from '../../src/core/crypto/kdf.ts'
import { open, seal, type Part } from '../../src/core/crypto/envelope.ts'
import { CryptoError } from '../../src/core/crypto/errors.ts'
import { encodeRecoveryKey, parseRecoveryKey } from '../../src/core/crypto/recovery.ts'
import { ulidToBytes } from '../../src/core/crypto/ulid-bytes.ts'
import { unwrapMasterKey, wrapMasterKey, type WrapKind } from '../../src/core/crypto/wrap.ts'
import { ERROR_KINDS, envelopeBytes, envelopePlaintext, partName, type EnvelopeCase, type EnvelopePositive } from './vector-cases.ts'

/** The error kind `run` threw, or a description of what it did instead. */
export function errorOf(run: () => unknown): string {
  try {
    run()
    return 'no error'
  } catch (e) {
    return e instanceof CryptoError ? e.kind : `${e instanceof Error ? e.name : 'thrown'}: ${String(e)}`
  }
}

export type VectorFile = { description: string; spec: string; cases: Record<string, unknown>[] }
export type VectorResult = { file: string; passed: number; failed: number; failures: string[] }
export type Sha256 = (bytes: Uint8Array) => Promise<string>

/**
 * Runs every case of one vector file (derive, wrap, envelope, recovery) and counts passes and failures.
 * `sha256` checks large envelopes (crypto.subtle in a browser).
 */
export async function runVectorFile(file: string, data: VectorFile, sha256: Sha256): Promise<VectorResult> {
  const result: VectorResult = { file, passed: 0, failed: 0, failures: [] }
  const check = async (name: string, ok: () => boolean | Promise<boolean>) => {
    let pass = false
    let detail = ''
    try {
      pass = await ok()
    } catch (e) {
      detail = `: ${e instanceof Error ? e.message : String(e)}`
    }
    if (pass) result.passed++
    else {
      result.failed++
      result.failures.push(name + detail)
    }
  }
  const cases = data.cases as never[]
  if (file === 'derive.json') {
    for (const c of cases as Array<Record<string, string>>) {
      await check(c.name!, () => {
        if (c.kind === 'password') {
          const k = deriveKeys(fromHex(c.root!))
          return toHex(k.kek) === c.kek && toHex(k.authKey) === c.auth_key
        }
        if (c.kind === 'item') return toHex(ulidToBytes(c.item_id!)) === c.item_id_bytes && toHex(itemKey(fromHex(c.master_key!), c.item_id!)) === c.item_key
        const r = recoveryKeys(fromHex(c.recovery_key!))
        return toHex(r.recoveryKek) === c.recovery_kek && toHex(r.recoveryAuthKey) === c.recovery_auth_key
      })
    }
  } else if (file === 'wrap.json') {
    for (const c of cases as Array<Record<string, string>>) {
      const kind = c.kind as WrapKind
      await check(c.name!, () => {
        if (c.error) return errorOf(() => unwrapMasterKey(fromHex(c.wrapped!), fromHex(c.wrapping_key!), kind)) === ERROR_KINDS[c.error]
        const wrapped = wrapMasterKey(fromHex(c.master_key!), fromHex(c.wrapping_key!), kind, fromHex(c.nonce!))
        return toHex(wrapped) === c.wrapped && toHex(unwrapMasterKey(wrapped, fromHex(c.wrapping_key!), kind)) === c.master_key
      })
    }
  } else if (file === 'envelope.json') {
    const all = cases as EnvelopeCase[]
    const positive = new Map(all.filter((c): c is EnvelopePositive => !('error' in c)).map((c) => [c.name, c]))
    const sealCase = (c: EnvelopePositive) => seal(envelopePlaintext(c), partName(c.part), c.item_id, fromHex(c.item_key), fromHex(c.nonce_prefix))
    for (const c of all) {
      await check(c.name, async () => {
        if ('error' in c) {
          const envelope = envelopeBytes(c, (name) => sealCase(positive.get(name)!))
          return errorOf(() => open(envelope, partName(c.expected_part), c.item_id, fromHex(c.item_key))) === ERROR_KINDS[c.error]
        }
        const envelope = sealCase(c)
        const sealedOk = c.envelope !== undefined ? toHex(envelope) === c.envelope : envelope.length === c.envelope_length && (await sha256(envelope)) === c.envelope_sha256
        const plain = open(envelope, partName(c.part), c.item_id, fromHex(c.item_key))
        return sealedOk && toHex(plain) === toHex(envelopePlaintext(c))
      })
    }
  } else if (file === 'recovery.json') {
    for (const c of cases as Array<Record<string, string>>) {
      await check(c.name!, () => {
        if (c.kind === 'format') return encodeRecoveryKey(fromHex(c.recovery_key!)) === c.text && toHex(parseRecoveryKey(c.text!)) === c.recovery_key
        if (c.error) return errorOf(() => parseRecoveryKey(c.input!)) === ERROR_KINDS[c.error]
        return toHex(parseRecoveryKey(c.input!)) === c.recovery_key
      })
    }
  } else throw new Error(`no runner for ${file}`)
  return result
}
