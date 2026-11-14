import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { openTags } from './support/tags'
import { noteMore } from './support/note-more'
import { downloadedBody } from './support/note-text'
import { paste } from './support/paste'

const library = (page: Page) => page.getByRole('navigation', { name: 'Library' })
const list = (page: Page) => page.getByRole('listbox', { name: 'Notes' })
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Note' })
const titleBox = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const bodyBox = (page: Page) => page.getByRole('textbox', { name: 'Note' })
const open = (page: Page, title: string) => list(page).getByRole('option', { name: new RegExp(`^${title}`) }).click()

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
})

test('Alt+N makes a new note in the selected notebook with the title focused', async ({ page }) => {
  await library(page).getByRole('button', { name: 'Travel', exact: true }).click()
  await page.keyboard.press('Alt+n')
  await expect(titleBox(page)).toBeFocused()
  await expect(titleBox(page)).toHaveValue('')
  await page.keyboard.type('Packing')
  await expect(list(page).getByRole('option')).toHaveCount(2)
  await expect(page.getByText('Travel', { exact: true }).first()).toBeVisible()
  await expect(library(page).getByRole('button', { name: 'Travel', exact: true })).toContainText('2')
})

test('typing then switching keeps the text', async ({ page }) => {
  await open(page, 'Groceries')
  await bodyBox(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  // Return continues the to-do list (specs/editor.md "Commands")
  await page.keyboard.type('\nCoffee')
  await open(page, 'Bread notes')
  await open(page, 'Groceries')
  expect(await downloadedBody(page)).toBe('- [ ] Oat milk\n- [ ] Lemons\n- [x] Rye flour\n- [ ] Coffee')
})

test('the title and body keep exactly what was typed', async ({ page }) => {
  await page.keyboard.press('Alt+n')
  await page.keyboard.type('  Spaces  ')
  await bodyBox(page).click()
  // pasted, not fill(): Chromium's own editing turns a filled tab into a span with an inline style, which the
  // policy refuses; people's typing, pasting and dropping all go through CodeMirror
  await paste(page, { text: 'a\tb  \n\nCafé\n' })
  await open(page, 'Groceries')
  await open(page, 'Spaces')
  await expect(titleBox(page)).toHaveValue('  Spaces  ')
  expect(await downloadedBody(page)).toBe('a\tb  \n\nCafé\n')
})

test('pin, tags and move change the lists and counts', async ({ page }) => {
  await open(page, 'Bread notes')
  await toolbar(page).getByRole('button', { name: 'Pinned' }).click()
  await expect(toolbar(page).getByRole('button', { name: 'Pinned' })).toHaveAttribute('aria-pressed', 'true')
  await expect(library(page).getByRole('button', { name: 'Pinned', exact: true })).toContainText('4')

  await toolbar(page).getByRole('button', { name: 'Tags' }).click()
  await page.getByRole('menuitemcheckbox', { name: 'ideas' }).click()
  await page.keyboard.press('Escape')
  await openTags(page)
  await library(page).getByRole('button', { name: '#ideas', exact: true }).click()
  await expect(list(page).getByRole('option')).toHaveCount(1)

  await toolbar(page).getByRole('button', { name: 'Move', exact: true }).click()
  await page.getByRole('menuitemradio', { name: 'Travel' }).click()
  await expect(library(page).getByRole('button', { name: 'Travel', exact: true })).toContainText('2')
  await expect(library(page).getByRole('button', { name: 'Personal', exact: true })).toContainText('2')
})

test('move to Trash shows Undo, and Undo brings the note back', async ({ page }) => {
  await open(page, 'Bread notes')
  await (await noteMore(page, 'Move to Trash')).click()
  await expect(page.getByRole('status')).toContainText('“Bread notes” moved to the Trash.')
  await expect(list(page).getByRole('option', { name: /^Bread notes/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(list(page).getByRole('option', { name: /^Bread notes/ })).toHaveCount(1)
})

test('a trashed note is read-only until restored', async ({ page }) => {
  await library(page).getByRole('button', { name: 'Trash', exact: true }).click()
  await open(page, 'Old draft')
  await expect(page.getByText('This note is in the Trash')).toBeVisible()
  await expect(bodyBox(page)).toHaveAttribute('aria-readonly', 'true')
  await page.getByRole('button', { name: 'Restore note' }).click()
  await expect(list(page).getByRole('option')).toHaveCount(0)
  await library(page).getByRole('button', { name: 'Personal', exact: true }).click()
  await expect(list(page).getByRole('option', { name: /^Old draft/ })).toHaveCount(1)
})

test("delete permanently asks first and can't be undone", async ({ page }) => {
  await library(page).getByRole('button', { name: 'Trash', exact: true }).click()
  await open(page, 'Old draft')
  await page.getByRole('button', { name: 'Delete permanently…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete “Old draft” permanently?' })
  await expect(dialog).toContainText("This can't be undone.")
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(list(page).getByRole('option')).toHaveCount(1)
  await page.getByRole('button', { name: 'Delete permanently…' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click()
  await expect(list(page).getByRole('option')).toHaveCount(0)
  await expect(page.getByText('Trash is empty')).toBeVisible()
})

test('Download .md saves the note with its front matter', async ({ page }) => {
  await open(page, 'Reading list 2027')
  const [download] = await Promise.all([page.waitForEvent('download'), (await noteMore(page, 'Download .md')).click()])
  expect(download.suggestedFilename()).toBe('Reading list 2027.md')
  const text = readFileSync((await download.path())!, 'utf8')
  expect(text).toMatch(/^---\nfeather_id: [0-9A-Z]{26}\ntitle: Reading list 2027\ncreated: .+Z\nmodified: .+Z\ntags: \[reading\]\npinned: false\n---\n\n- \[ \] \*The Overstory\*/)
})
