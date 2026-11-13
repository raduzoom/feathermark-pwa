// A 50,000-word note built from the editor corpus (headings, lists, code, links, tables), for the speed tests.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const corpusDir = join(process.env.FEATHER_TEST_VECTORS ?? join(import.meta.dirname, '../../../../universal/test-vectors'), 'editor/corpus')

export function bigNote(words = 50_000): string {
  const parts = readdirSync(corpusDir)
    .filter((f) => f.endsWith('.md') && f !== 'crlf.md')
    .map((f) => readFileSync(join(corpusDir, f), 'utf8'))
  let out = ''
  let count = 0
  for (let i = 0; count < words; i++) {
    const p = parts[i % parts.length]!
    out += p + '\n\n'
    count += p.split(/\s+/).filter(Boolean).length
  }
  return out
}
