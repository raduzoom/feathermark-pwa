import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? stylesheets(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : [],
  )
}

test('no stylesheet but tokens.css holds a colour literal', () => {
  for (const file of stylesheets('src').filter((f) => !f.endsWith('tokens.css'))) {
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(text, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
  }
})
