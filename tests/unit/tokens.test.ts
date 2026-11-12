import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { tokensPath, tokensToCss } from '../../scripts/tokens.ts'

const tokens = JSON.parse(readFileSync(tokensPath(), 'utf8'))
const css = tokensToCss(tokens)
const [light = '', dark = ''] = css.split('@media (prefers-color-scheme: dark)')

test('light and dark values land in their blocks', () => {
  expect(light).toContain('--c-bg-window: #F1E2D5;')
  expect(dark).toContain('--c-bg-window: #11171D;')
  expect(light).toContain('--c-accent-fill-on-fill: #FFFFFF;')
  expect(dark).toContain('--c-accent-fill-on-fill: #0E1A15;')
  expect(light).toContain('--c-search-match-current: rgba(245,160,40,0.75);')
})

test('mode-less colours, arrays, type, spacing, radii and heights', () => {
  expect(light).toContain('--c-md-code-block-syntax-keyword: #F2B880;')
  expect(light).toContain('--c-notebook-1: #E8A27C;')
  expect(dark).toContain('--c-notebook-2: #4FBF8A;')
  expect(light).toContain('--type-note-title-size: 44px;')
  expect(light).toContain('--type-note-title-tracking: -0.8px;')
  expect(light).toContain('--space-16: 16px;')
  expect(light).toContain('--radius-panel: 24px;')
  expect(light).toContain('--radius-pill: 999px;')
  expect(light).toContain('--h-button-desktop: 32px;')
  expect(light).toContain("--font-serif: ui-serif, 'New York', 'Sitka Text', Georgia, 'Noto Serif', serif;")
})

test('the app icon colours are variables, the same in both modes', () => {
  expect(light).toContain('--icon-background: #CFE7D9;')
  expect(light).toContain('--icon-page: rgba(255,255,255,0.72);')
  expect(light).toContain('--icon-quill: #13243A;')
  expect(dark).not.toContain('--icon-')
})

test('platform notes never reach the stylesheet', () => {
  expect(css).not.toMatch(/NSVisualEffectView|Mica|radius-window|radius-panel-windows/)
})

test('the committed file is fresh and the output is stable', () => {
  expect(tokensToCss(tokens)).toBe(css)
  expect(readFileSync('src/ui/tokens.css', 'utf8')).toBe(css)
})
