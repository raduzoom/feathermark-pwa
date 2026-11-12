// Loads the crypto test vectors from universal/test-vectors/. Values are never copied into code.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** FEATHER_TEST_VECTORS, else ../universal/test-vectors beside this repo. Throws if missing. */
export function vectorsDir(): string {
  const dir = process.env.FEATHER_TEST_VECTORS ?? fileURLToPath(new URL('../../../universal/test-vectors', import.meta.url))
  if (!existsSync(dir)) throw new Error(`test vectors not found at ${dir} (set FEATHER_TEST_VECTORS)`)
  return dir
}

export function loadVectors<T>(file: string): { description: string; spec: string; cases: T[] } {
  return JSON.parse(readFileSync(join(vectorsDir(), file), 'utf8'))
}
