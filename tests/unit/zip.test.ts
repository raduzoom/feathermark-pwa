// The zip writer for downloads: stored entries (no compression), CRC-32, UTF-8 names.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { crc32, zipStored } from '../../src/core/zip.ts'

const enc = (s: string) => new TextEncoder().encode(s)
const MODIFIED = Date.UTC(2026, 10, 12, 13, 52, 30)

test('CRC-32 of "123456789" is cbf43926', () => {
  expect(crc32(enc('123456789')).toString(16)).toBe('cbf43926')
})

test('a zip of two files lists them with their CRC32', () => {
  const zip = zipStored([{ path: 'a.md', bytes: enc('hello') }, { path: '_attachments/a/b.bin', bytes: new Uint8Array([0, 1, 2]) }], MODIFIED)
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  expect(view.getUint32(0, true)).toBe(0x04034b50) // local header
  expect(view.getUint32(14, true)).toBe(crc32(enc('hello')))
  const eocd = zip.byteLength - 22
  expect(view.getUint32(eocd, true)).toBe(0x06054b50)
  expect(view.getUint16(eocd + 10, true)).toBe(2) // entries
})

test('UTF-8 names set flag 11', () => {
  const zip = zipStored([{ path: 'Café.md', bytes: enc('x') }], MODIFIED)
  const view = new DataView(zip.buffer)
  expect(view.getUint16(6, true) & 0x0800).toBe(0x0800)
})

test('unzip accepts it', () => {
  let unzip = true
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' })
  } catch {
    unzip = false
  }
  if (!unzip) return
  const dir = mkdtempSync(join(tmpdir(), 'feather-zip-'))
  const file = join(dir, 't.zip')
  writeFileSync(file, zipStored([{ path: 'Groceries.md', bytes: enc('- [ ] Milk\n') }, { path: '_attachments/Groceries/Café plan.png', bytes: new Uint8Array(1000).fill(7) }], MODIFIED))
  const out = execFileSync('unzip', ['-t', file], { encoding: 'utf8' })
  expect(out).toContain('No errors detected')
})
