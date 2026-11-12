// The candidate replacement for hash-wasm must reproduce the vectors, in both its builds, before its speed
// on a phone means anything.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { expect, test } from 'vitest'
import { fromHex, toHex } from '../../src/core/bytes.ts'
import { normalizePassword } from '../../src/core/crypto/argon2.ts'
import { loadVectors } from './vectors.ts'

type Case = { name: string; password: string; salt: string; t: number; m_kib: number; p: number; root: string }
const { cases } = loadVectors<Case>('argon2id.json')
const wasm = (file: string) => readFileSync(createRequire(import.meta.url).resolve(`argon2id/dist/${file}`))

for (const build of ['simd.wasm', 'no-simd.wasm']) {
  test.each(cases)(`argon2id ${build} derives the root: $name`, async (c) => {
    const { default: setupWasm } = await import('argon2id/lib/setup.js')
    const load = (o: WebAssembly.Imports) => WebAssembly.instantiate(wasm(build), o)
    const argon2id = await setupWasm(load, load)
    const root = argon2id({ password: normalizePassword(c.password), salt: fromHex(c.salt), parallelism: c.p, passes: c.t, memorySize: c.m_kib, tagLength: 32 })
    expect(toHex(root)).toBe(c.root)
  }, 60_000)
}
