// scripts/bundle-size.ts: the first load's files, its size, and whether crypto or sync code slipped into it. Run on
// dist/ (the demo) and dist-cloud/ (the accounts build).
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { firstLoad } from '../../scripts/bundle-size.ts'

function dist(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-size-'))
  mkdirSync(join(dir, 'assets'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

const page = (...scripts: string[]) => `<!doctype html>${scripts.map((s) => `<script type="module" src="/${s}"></script>`).join('')}<link rel="stylesheet" href="/assets/a.css">`

test('lists what the first visit downloads and passes a clean build', () => {
  const r = firstLoad(dist({ 'index.html': page('assets/index.js'), 'assets/index.js': 'console.log(1)', 'assets/a.css': 'p{}', 'assets/lazy.js': 'feather/v1/kek' }))
  expect(r.files).toEqual(['assets/index.js', 'assets/a.css'])
  expect(r.problems).toEqual([])
  expect(r.total).toBeGreaterThan(0)
})

test('fails on crypto code in the first load', () => {
  const r = firstLoad(dist({ 'index.html': page('assets/index.js'), 'assets/index.js': 'const l="feather/v1/kek"', 'assets/a.css': '' }))
  expect(r.problems).toEqual(['crypto code in the first load: assets/index.js'])
})

test('fails on sync code in the first load (the API client, the engine)', () => {
  const r = firstLoad(dist({ 'index.html': page('assets/index.js'), 'assets/index.js': 'fetch(base+"/sync/pull?cursor=")', 'assets/a.css': '' }))
  expect(r.problems).toEqual(['sync code in the first load: assets/index.js'])
})

test('fails over 300 KB gzipped', () => {
  // hex of random bytes: about half a byte per character after gzip, and never a marker string
  const big = randomBytes(400 * 1024).toString('hex')
  const r = firstLoad(dist({ 'index.html': page('assets/index.js'), 'assets/index.js': big, 'assets/a.css': '' }))
  expect(r.problems).toEqual(['first load is over budget'])
})
