// Gzipped size of what the first visit downloads: index.html and every script, style and preload it names.
// Run: node scripts/bundle-size.ts [--check] [--dir dist-cloud]   (default dist/; --check fails over the 300 KB budget
// from the web design, or when crypto or sync code is in the first load: the crypto worker, its libraries, the API
// client, the account service and the sync engine load only through import() and new Worker, when someone logs in)
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

const BUDGET = 300 * 1024
// Strings that survive minification in the crypto code: our key-derivation labels (kdf.ts), the envelope's own
// error text (envelope.ts), @noble/ciphers' ARX checks, and hash-wasm's Argon2id module name.
const CRYPTO = /feather\/v1\/|last chunk shorter than a tag|arx: |argon2/i
// And in the sync code: the API client's paths (api.ts), which the account service and the engine both pull in.
const SYNC = /\/sync\/pull|\/sync\/push|\/auth\/prelogin/

export type FirstLoad = { files: string[]; sizes: Record<string, number>; total: number; problems: string[] }

export function firstLoad(dir: string): FirstLoad {
  const html = readFileSync(join(dir, 'index.html'))
  const files = [...new Set([...html.toString().matchAll(/(?:src|href)="\/([^"]+\.(?:js|css))"/g)].map((m) => m[1]!))]
  const sizes: Record<string, number> = { 'index.html': gzipSync(html, { level: 9 }).length }
  let total = sizes['index.html']!
  const withCrypto: string[] = []
  const withSync: string[] = []
  for (const f of files) {
    const bytes = readFileSync(join(dir, f))
    sizes[f] = gzipSync(bytes, { level: 9 }).length
    total += sizes[f]!
    if (!f.endsWith('.js')) continue
    const text = bytes.toString()
    if (CRYPTO.test(text)) withCrypto.push(f)
    if (SYNC.test(text)) withSync.push(f)
  }
  const problems: string[] = []
  if (total > BUDGET) problems.push('first load is over budget')
  if (withCrypto.length) problems.push(`crypto code in the first load: ${withCrypto.join(', ')}`)
  if (withSync.length) problems.push(`sync code in the first load: ${withSync.join(', ')}`)
  return { files, sizes, total, problems }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const at = process.argv.indexOf('--dir')
  const dir = resolve(new URL('..', import.meta.url).pathname, at >= 0 ? process.argv[at + 1]! : 'dist')
  const r = firstLoad(dir)
  for (const [f, size] of Object.entries(r.sizes)) console.log(`  ${f} ${(size / 1024).toFixed(1)} KB`)
  console.log(`first load of ${dir}: ${(r.total / 1024).toFixed(1)} KB gzipped (${r.files.length + 1} files, budget ${BUDGET / 1024} KB)`)
  if (process.argv.includes('--check') && r.problems.length) {
    for (const p of r.problems) console.error(p)
    process.exit(1)
  }
}
