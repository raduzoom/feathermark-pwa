// The shared editor fixtures in universal/test-vectors/editor/ (the Markdown corpus and the command cases).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { vectorsDir } from '../vectors.ts'

export function corpus(): Array<{ name: string; text: string }> {
  const dir = join(vectorsDir(), 'editor', 'corpus')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
}

export type CommandCase = { name: string; source: string; command: string; input?: string; expected: unknown } & Record<string, unknown>

export function commandCases(): CommandCase[] {
  return JSON.parse(readFileSync(join(vectorsDir(), 'editor', 'commands.json'), 'utf8')).cases
}
