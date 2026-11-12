import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { compositeOver, contrastRatio } from '../../scripts/contrast.ts'
import { tokensPath } from '../../scripts/tokens.ts'

const color = JSON.parse(readFileSync(tokensPath(), 'utf8')).color as Record<string, Record<string, string>>
const value = (key: string, mode: 'light' | 'dark') => color[key]![mode]!

test('contrast of black on white is 21', () => {
  expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 2)
})

test('half white over black is mid grey', () => {
  expect(compositeOver('rgba(255,255,255,0.5)', '#000000')).toBe('#808080')
})

test('text holds 4.5:1 on every panel', () => {
  for (const mode of ['light', 'dark'] as const) {
    const window = value('bg.window', mode)
    const surfaces = [window, ...['glass.sidebar', 'glass.list', 'glass.editor'].map((k) => compositeOver(value(k, mode), window))]
    for (const text of ['text.primary', 'text.body', 'text.secondary']) {
      for (const surface of surfaces) {
        expect(contrastRatio(value(text, mode), surface), `${mode} ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  }
})
