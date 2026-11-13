// Loads the crypto test vectors from universal/test-vectors/. Values are never copied into code.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { CryptoError } from '../../src/core/crypto/errors.ts'
import { ERROR_KINDS } from '../shared/vector-cases.ts'

/** FEATHER_TEST_VECTORS, else ../universal/test-vectors beside this repo. Throws if missing. */
export function vectorsDir(): string {
  const dir = process.env.FEATHER_TEST_VECTORS ?? fileURLToPath(new URL('../../../universal/test-vectors', import.meta.url))
  if (!existsSync(dir)) throw new Error(`test vectors not found at ${dir} (set FEATHER_TEST_VECTORS)`)
  return dir
}

export function loadVectors<T>(file: string): { description: string; spec: string; cases: T[] } {
  return JSON.parse(readFileSync(join(vectorsDir(), file), 'utf8'))
}

/** `run` must throw the CryptoError kind the vectors name `error` (authentication_failed, malformed_envelope, recovery_key_typo). */
export function expectCryptoError(run: () => unknown, error: string): void {
  const kind = ERROR_KINDS[error]
  if (!kind) throw new Error(`unknown vector error ${error}`)
  let thrown: unknown
  try {
    run()
  } catch (e) {
    thrown = e
  }
  expect(thrown, `expected CryptoError('${kind}')`).toBeInstanceOf(CryptoError)
  expect((thrown as CryptoError).kind).toBe(kind)
}
