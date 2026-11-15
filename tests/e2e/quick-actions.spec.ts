// Quick actions (Ctrl/⌘+K, or the app bar's search button): search all notes or run an action.
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Quick actions' })
const field = (page: Page) => dialog(page).getByRole('combobox', { name: 'Search all notes' })
const list = (page: Page) => page.getByRole('listbox', { name: 'Notes' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note' })

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
})

test('opens from the app bar button and from Ctrl/⌘+K, with the field focused', async ({ page }) => {
  await page.getByRole('button', { name: 'Search and quick actions' }).click()
  await expect(dialog(page)).toBeVisible()
  await expect(field(page)).toBeFocused()
  await expect(dialog(page).getByRole('group', { name: 'This note' }).getByRole('option', { name: 'Pin note', exact: true })).toHaveCount(0)
  await expect(dialog(page).getByRole('group', { name: 'This note' }).getByRole('option', { name: 'Unpin note' })).toBeVisible()
  await expect(dialog(page).getByRole('group', { name: 'Library' }).getByRole('option', { name: 'New note', exact: true })).toHaveAttribute('aria-keyshortcuts', 'Alt+N')
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+k')
  await expect(field(page)).toBeFocused()
})

test('Escape closes, clears the search and returns focus to what had it', async ({ page }) => {
  const row = list(page).getByRole('option', { name: /^Groceries/ })
  await row.click()
  await row.focus()
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('flour')
  await expect(list(page).getByRole('option')).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await expect(row).toBeFocused()
  await expect(list(page).getByRole('option')).toHaveCount(7)
})

test('typing finds a note, and Return opens it', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('tram')
  const notes = dialog(page).getByRole('group', { name: 'Notes' })
  await expect(notes.getByRole('option', { name: 'Lisbon, spring trip' })).toBeVisible()
  // no action is named like it, so the note is the first choice
  await expect(dialog(page).getByRole('group', { name: 'Library' })).toHaveCount(0)
  await expect(field(page)).toHaveAttribute('aria-activedescendant', (await notes.getByRole('option').first().getAttribute('id'))!)
  await page.keyboard.press('Enter')
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Lisbon, spring trip')
  // the list keeps showing the search
  await expect(page.getByRole('heading', { level: 2, name: 'Search' })).toBeVisible()
})

test('arrows move through the choices and wrap; "New note" makes a note', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+k')
  const options = dialog(page).getByRole('option')
  const active = async () => field(page).getAttribute('aria-activedescendant')
  const first = await options.first().getAttribute('id')
  await page.keyboard.press('ArrowUp')
  expect(await active()).toBe(await options.last().getAttribute('id'))
  await page.keyboard.press('ArrowDown')
  expect(await active()).toBe(first)
  await page.keyboard.type('new note')
  await expect(dialog(page).getByRole('option', { name: 'New note', exact: true })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(dialog(page)).toHaveCount(0)
  await expect(list(page).getByRole('option')).toHaveCount(8)
  await expect(page.getByRole('textbox', { name: 'Title' })).toBeFocused()
})

test('Pin note and Move to Trash act on the open note', async ({ page }) => {
  await list(page).getByRole('option', { name: /^Bread notes/ }).click()
  await page.keyboard.press('ControlOrMeta+k')
  await dialog(page).getByRole('option', { name: 'Pin note' }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.getByRole('toolbar', { name: 'Note' }).getByRole('button', { name: 'Pinned' })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('trash')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('status')).toContainText('“Bread notes” moved to the Trash.')
})

test('with the caret in the note body, Ctrl/⌘+K makes a link and does not open quick actions', async ({ page }) => {
  await list(page).getByRole('option', { name: /^Groceries/ }).click()
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+k')
  await expect(dialog(page)).toHaveCount(0)
  await expect(body(page)).toBeFocused()
})

test('"Add a tag" and "Move to a notebook" open the toolbar menus; "Go to Recent" shows Recent', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('add a tag')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu', { name: 'Tags' })).toBeVisible()
  await expect(page.getByRole('menu', { name: 'Tags' }).getByRole('menuitemcheckbox').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('move to a')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu', { name: 'Move' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('recent')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 2, name: 'Recent' })).toBeVisible()
})
