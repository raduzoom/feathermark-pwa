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

// The web shell redesign (universal/plans/web-shell-redesign.md, Task 6): the pairs it adds.
const onColour = (key: string, which: string, mode: 'light' | 'dark') => color[key]![`${which}.${mode}`]!

test('the redesign’s text pairs hold 4.5:1', () => {
  for (const mode of ['light', 'dark'] as const) {
    const window = value('bg.window', mode)
    const mint = value('bg.glow.mint', mode)
    const peach = value('bg.glow.peach', mode)
    const tint = value('accent.tint', mode)
    const onTint = onColour('accent.tint', 'onTint', mode)
    // the one sheet, over the window and over the peach glow now at the bottom right
    const sheets = [window, peach].map((under) => compositeOver(value('glass.editor', mode), under))
    const pairs: Array<[string, string, string]> = [
      // "New note", filled
      ['New note', onColour('action.primary', 'onPrimary', mode), value('action.primary', mode)],
      // the library with no panel: straight on the window and on the mint glow (its foot, the demo card, the sync line)
      ...[window, mint].flatMap((bg): Array<[string, string, string]> => [
        ['library secondary', value('text.secondary', mode), bg],
        ['library primary', value('text.primary', mode), bg],
        ['selected library row', onTint, compositeOver(tint, bg)],
      ]),
      ...sheets.flatMap((sheet): Array<[string, string, string]> => [
        ['sheet secondary', value('text.secondary', mode), sheet],
        ['sheet on-tint', onTint, sheet],
        // the selected row: title, preview (body) and meta (secondary) on the tint over the sheet
        ['selected row title', value('text.primary', mode), compositeOver(tint, sheet)],
        ['selected row preview', value('text.body', mode), compositeOver(tint, sheet)],
        ['selected row meta', value('text.secondary', mode), compositeOver(tint, sheet)],
      ]),
      // menus and quick actions sit on the window colour; danger items, and the active option on the tint
      ['menu danger', value('danger.text', mode), window],
      ['menu danger hovered', value('danger.text', mode), compositeOver(tint, window)],
      ['active option', onTint, compositeOver(tint, window)],
    ]
    for (const [what, text, bg] of pairs) expect(contrastRatio(text, bg), `${mode} ${what}: ${text} on ${bg}`).toBeGreaterThanOrEqual(4.5)
  }
})
