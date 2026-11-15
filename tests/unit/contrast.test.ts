import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { compositeOver, contrastRatio } from '../../scripts/contrast.ts'
import { tokensPath } from '../../scripts/design-system.ts'

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
    // the one sheet (glass.sidebar): the note's side over the window and the peach glow (bottom right); the list's side,
    // tinted glass.listPane, over the window and the mint glow (top left)
    const sheet = (under: string) => compositeOver(value('glass.sidebar', mode), under)
    const sheets = [
      ...[window, peach].map(sheet),
      ...[window, mint].map((under) => compositeOver(value('glass.listPane', mode), sheet(under))),
    ]
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
        // the selected row's meta line is text.body: secondary falls under 4.5:1 over the mint glow in dark mode
        ['selected row meta', value('text.body', mode), compositeOver(tint, sheet)],
      ]),
      // menus and quick actions sit on surface.menu: their text, danger items, and the active option on the tint
      ...[value('surface.menu', mode), compositeOver(value('line.hairline', mode), value('surface.menu', mode))].flatMap(
        (menu): Array<[string, string, string]> => [
          ['menu text', value('text.primary', mode), menu],
          ['menu hint', value('text.secondary', mode), menu],
          ['menu danger', value('danger.text', mode), menu],
        ],
      ),
      ['active option', value('text.primary', mode), compositeOver(tint, value('surface.menu', mode))],
      // the View segment's pressed option and the list search field
      ['pressed segment', value('text.primary', mode), compositeOver(value('surface.raised', mode), compositeOver(value('glass.sidebar', mode), window))],
    ]
    for (const [what, text, bg] of pairs) expect(contrastRatio(text, bg), `${mode} ${what}: ${text} on ${bg}`).toBeGreaterThanOrEqual(4.5)
  }
})
