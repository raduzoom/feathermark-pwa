import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { noteMore } from './support/note-more'

// "Search all notes" is the quick actions field: open them first
const field = (page: Page) => page.getByRole('dialog', { name: 'Quick actions' }).getByRole('combobox', { name: 'Search all notes' })
async function search(page: Page) {
  if (!(await field(page).isVisible())) await page.getByRole('button', { name: 'Search and quick actions' }).click()
  return field(page)
}
const list = (page: Page) => page.getByRole('listbox', { name: 'Notes' })
const titles = async (page: Page) => (await list(page).getByRole('option').allInnerTexts()).map((t) => t.split('\n')[0]!.trim())

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
})

test('Ctrl/⌘ K opens quick actions with the search field focused', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+k')
  await expect(field(page)).toBeFocused()
})

test('results come in rank order with highlighted snippets', async ({ page }) => {
  await (await search(page)).fill('flour')
  await expect(page.getByRole('heading', { level: 2, name: 'Search' })).toBeVisible()
  expect(await titles(page)).toEqual(['Groceries', 'Bread notes'])
  await expect(list(page).getByRole('option').first().locator('mark')).toHaveText('flour')
  await page.keyboard.press('Escape')
  await expect(field(page)).toHaveCount(0)
  await expect(list(page).getByRole('option')).toHaveCount(7)
  await page.keyboard.press('ControlOrMeta+k')
  await expect(field(page)).toHaveValue('')
})

test('accents and prefixes match', async ({ page }) => {
  await page.keyboard.press('Alt+n')
  await page.keyboard.type('Été à Lisbonne')
  await (await search(page)).fill('lis')
  expect(await titles(page)).toEqual(expect.arrayContaining(['Lisbon, spring trip', 'Été à Lisbonne']))
  await (await search(page)).fill('ete')
  expect(await titles(page)).toEqual(['Été à Lisbonne'])
})

test('no results shows the copy and the way out', async ({ page }) => {
  await page.getByRole('navigation', { name: 'Library' }).getByRole('button', { name: 'Projects', exact: true }).click()
  await list(page).getByRole('option').first().click()
  await page.getByRole('searchbox', { name: 'Search in this view' }).fill('lemons')
  await expect(page.getByText('No notes match “lemons”')).toBeVisible()
  await expect(page.getByText("You're searching in Projects only. Try all notebooks, or fewer words.")).toBeVisible()
  await page.getByRole('button', { name: 'Search all notebooks' }).click()
  expect(await titles(page)).toEqual(['Groceries'])
})

test('download keeps the body byte for byte', async ({ page }) => {
  await page.keyboard.press('Alt+n')
  await page.keyboard.type('Bytes')
  // CRLF can't be typed into a textarea (it reports LF); line-endings.test.ts covers editing a CRLF note.
  const body = 'line one\nCafe\u0301 and tabs\t\t\n\nend  '
  await page.getByRole('textbox', { name: 'Note' }).fill(body)
  await (await search(page)).fill('bytes')
  // the note is the first choice: Return opens it
  await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Bytes')
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    (await noteMore(page, 'Download .md')).click(),
  ])
  const text = readFileSync((await download.path())!)
  const expected = Buffer.from(body, 'utf8')
  expect(text.subarray(text.length - expected.length).equals(expected)).toBe(true)
})
