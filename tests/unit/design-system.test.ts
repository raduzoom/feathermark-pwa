import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { checkDesignSystem, stylesheets, tokensPath, tokensToCss } from '../../scripts/design-system.ts'

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

test('layout.web sizes become --layout-* variables; breakpoints and notes do not', () => {
  expect(light).toContain(`--layout-library-width: ${tokens.layout.web.libraryWidth}px;`)
  expect(light).toContain(`--layout-measure: ${tokens.layout.web.measure}px;`)
  expect(light).toContain(`--layout-list-width-basis: ${tokens.layout.web.listWidth.basis}px;`)
  expect(css).not.toMatch(/--layout-three-columns-from|--layout-drawer-from|--layout-use|--layout-sheet/)
})

// A small design system to check stylesheets against.
const mini = {
  color: { 'text.primary': { light: '#13243A', dark: '#ECF2EE' } },
  spacing: { scale: [4, 8, 16] },
  radius: { input: 8 },
  controlHeight: { 'button.large': 40 },
  appIcon: {},
  type: {},
  layout: { web: { threeColumnsFrom: 1000, drawerFrom: 640, libraryWidth: 232, gap: 16, measure: 680, note: 'words' } },
}
const miniCss = tokensToCss(mini)
const check = (text: string, file = 'src/ui/x.css') => checkDesignSystem({ tokens: mini, tokensCss: miniCss, sheets: [{ file, text }] })
const messages = (text: string) => check(text).map((p) => `${p.line}: ${p.message}`)

test('the check passes a stylesheet that uses only the design system', () => {
  const ok = `.a {\n  color: var(--c-text-primary);\n  width: var(--layout-library-width);\n  gap: 16px;\n}\n@media (max-width: 999px) {\n  .a { padding: var(--space-8); }\n}\n`
  expect(check(ok)).toEqual([])
})

test('tokens.css out of date', () => {
  expect(checkDesignSystem({ tokens: mini, tokensCss: '/* old */', sheets: [] }).map((p) => p.message)).toEqual([
    'tokens.css does not match tokens.json: run pnpm design-system',
  ])
})

test('a colour literal outside tokens.css', () => {
  expect(messages('.a {\n  color: #13243A;\n  background: rgba(0, 0, 0, 0.2);\n}\n')).toEqual([
    '2: colour literal #13243A: use a --c-* variable',
    '3: colour literal rgba(: use a --c-* variable',
  ])
  // comments don't count
  expect(check('/* #fff */\n.a { color: var(--c-text-primary); }\n')).toEqual([])
})

test('a variable the design system does not define', () => {
  expect(messages('.a {\n  color: var(--c-text-muted);\n}\n')).toEqual(['2: var(--c-text-muted) is not defined'])
  // custom properties a stylesheet declares itself are defined
  expect(check('.a {\n  --qdepth: 2;\n  padding: calc(var(--space-16) * var(--qdepth, 1));\n}\n')).toEqual([])
})

test('a layout.web size written as raw px', () => {
  expect(messages('.a {\n  grid-template-columns: 232px 1fr;\n  max-width: 680px;\n}\n')).toEqual([
    '2: 232px is layout.web.libraryWidth: use var(--layout-library-width)',
    '3: 680px is layout.web.measure: use var(--layout-measure)',
  ])
  // a size another token shares (16 = space-16) isn't a layout size
  expect(check('.a {\n  margin: 16px;\n}\n')).toEqual([])
  // a coincidence can be marked
  expect(check('.a {\n  width: 232px; /* design-system: not a layout size */\n}\n')).toEqual([])
})

test('a breakpoint layout.web does not name', () => {
  expect(messages('@media (min-width: 1000px) {}\n@media (max-width: 639px) {}\n@media (max-width: 720px) {}\n')).toEqual([
    '3: breakpoint 720px is not in layout.web (use 1000, 999 or 639)',
  ])
})

test('the app stylesheets pass the check', () => {
  const problems = checkDesignSystem({ tokens, tokensCss: readFileSync('src/ui/tokens.css', 'utf8'), sheets: stylesheets('src') })
  expect(problems.map((p) => `${p.file}:${p.line}: ${p.message}`)).toEqual([])
})
