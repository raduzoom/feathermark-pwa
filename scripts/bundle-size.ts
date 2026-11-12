// Gzipped size of what the first visit downloads: dist/index.html and every script, style and preload it names.
// Run: node scripts/bundle-size.ts [--check]   (--check fails over the 300 KB budget from the web design)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const BUDGET = 300 * 1024
const dist = new URL('../dist/', import.meta.url).pathname
const html = readFileSync(join(dist, 'index.html'))
const files = [...new Set([...html.toString().matchAll(/(?:src|href)="\/([^"]+\.(?:js|css))"/g)].map((m) => m[1]!))]
let total = gzipSync(html, { level: 9 }).length
for (const f of files) total += gzipSync(readFileSync(join(dist, f)), { level: 9 }).length
console.log(`first load: ${(total / 1024).toFixed(1)} KB gzipped (${files.length + 1} files, budget ${BUDGET / 1024} KB)`)
if (process.argv.includes('--check') && total > BUDGET) {
  console.error('first load is over budget')
  process.exit(1)
}
