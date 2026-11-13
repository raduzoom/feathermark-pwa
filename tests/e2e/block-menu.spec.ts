// The block menu: "+" beside the caret's line, "/" at a line start, keyboard and mouse picks (specs/editor.md).
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { downloadedBody } from './support/note-text'
import { newNoteWith } from './support/paste'

const menu = (page: Page) => page.getByRole('listbox', { name: 'Insert' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note' })

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
})

test('the + button opens the menu beside the caret line', async ({ page }) => {
  await newNoteWith(page, 'Plus', 'first\nsecond')
  const plus = page.getByRole('button', { name: 'Insert block' })
  await expect(plus).toHaveCount(1)
  const line = page.locator('#note-body .cm-line').nth(1)
  const [p, l] = [(await plus.boundingBox())!, (await line.boundingBox())!]
  expect(p.x + p.width).toBeLessThanOrEqual(l.x + 1)
  expect(Math.abs(p.y + p.height / 2 - (l.y + l.height / 2))).toBeLessThan(8)
  await plus.click()
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole('option')).toHaveCount(10)
  await menu(page).getByRole('option', { name: /^Quote/ }).click()
  expect(await downloadedBody(page)).toBe('first\n> second')
})

test('arrow keys move, wrap, and Enter picks', async ({ page }) => {
  await newNoteWith(page, 'Keys', '')
  await page.keyboard.type('/')
  await expect(menu(page)).toBeVisible()
  const active = async () => {
    const id = await body(page).getAttribute('aria-activedescendant')
    return page.locator(`[id="${id}"]`).getAttribute('aria-label')
  }
  expect(await active()).toBe('Heading 1')
  await page.keyboard.press('ArrowUp')
  expect(await active()).toBe('Image or file')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  expect(await active()).toBe('Heading 2')
  await page.keyboard.press('Enter')
  await expect(menu(page)).toHaveCount(0)
  await page.keyboard.type('Title')
  expect(await downloadedBody(page)).toBe('## Title')
})

test('a pick and its trigger undo together', async ({ page }) => {
  await newNoteWith(page, 'Undo pick', 'hello')
  await page.keyboard.press('Home')
  await page.keyboard.type('/h1')
  await expect(menu(page).getByRole('option')).toHaveCount(1)
  await page.keyboard.press('Enter')
  expect(await downloadedBody(page)).toBe('# hello')
  await body(page).focus()
  await page.keyboard.press('ControlOrMeta+z')
  expect(await downloadedBody(page)).toBe('/h1hello')
})

test('clicking a choice picks it', async ({ page }) => {
  await newNoteWith(page, 'Click', 'text')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/')
  await menu(page).getByRole('option', { name: /^Divider/ }).click()
  expect(await downloadedBody(page)).toBe('text\n\n---\n')
})

test('Scan from iPhone is not offered', async ({ page }) => {
  await newNoteWith(page, 'No scan', '')
  await page.keyboard.type('/')
  await expect(menu(page).getByRole('option', { name: /Scan/ })).toHaveCount(0)
  await page.keyboard.type('scan')
  await expect(menu(page)).toHaveCount(0)
  expect(await downloadedBody(page)).toBe('/scan')
})

test('Escape closes the menu and keeps the text', async ({ page }) => {
  await newNoteWith(page, 'Escape', '')
  await page.keyboard.type('/co')
  await expect(menu(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  expect(await downloadedBody(page)).toBe('/co')
})

test('Image or file opens the file picker', async ({ page }) => {
  await newNoteWith(page, 'Picker', '')
  await page.keyboard.type('/image')
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')])
  expect(chooser.isMultiple()).toBe(true)
})
