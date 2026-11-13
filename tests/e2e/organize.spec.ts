import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

const library = (page: Page) => page.getByRole('navigation', { name: 'Library' })
const list = (page: Page) => page.getByRole('listbox', { name: 'Notes' })
const more = (page: Page, name: string) => library(page).getByRole('button', { name: `More for ${name}`, exact: true })

async function nameDialog(page: Page, title: string, name: string, confirm: string) {
  const dialog = page.getByRole('dialog', { name: title })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name)
  await dialog.getByRole('button', { name: confirm, exact: true }).click()
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
})

test('create, rename, nest and delete a notebook', async ({ page }) => {
  await library(page).getByRole('button', { name: 'New notebook', exact: true }).click()
  await nameDialog(page, 'New notebook', 'Garden', 'Create')
  await expect(library(page).getByRole('button', { name: 'Garden', exact: true })).toBeVisible()

  await more(page, 'Garden').click()
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  await nameDialog(page, 'Rename notebook', 'Allotment', 'Rename')

  await more(page, 'Allotment').click()
  await page.getByRole('menuitem', { name: 'New notebook inside…' }).click()
  await nameDialog(page, 'New notebook', 'Beds', 'Create')

  await library(page).getByRole('button', { name: 'Beds', exact: true }).click()
  await page.keyboard.press('Alt+n')
  await page.keyboard.type('Tomatoes')
  await expect(library(page).getByRole('button', { name: 'Allotment', exact: true })).toContainText('1')

  await more(page, 'Allotment').click()
  await page.getByRole('menuitem', { name: 'Delete notebook…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete “Allotment”?' })
  await expect(dialog).toContainText('Its 1 sub-notebook is deleted too, and its 1 note moves to the Trash.')
  await dialog.getByRole('button', { name: 'Delete notebook' }).click()
  await expect(library(page).getByRole('button', { name: 'Allotment', exact: true })).toHaveCount(0)
  await expect(library(page).getByRole('button', { name: 'Trash', exact: true })).toContainText('2')
})

test("a notebook can't move inside its own sub-notebook", async ({ page }) => {
  await more(page, 'Projects').click()
  await page.getByRole('menuitem', { name: 'Move to…' }).click()
  await expect(page.getByRole('menuitemradio', { name: 'Home' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await more(page, 'Home').click()
  await page.getByRole('menuitem', { name: 'Move to…' }).click()
  await page.getByRole('menuitemradio', { name: 'Top level' }).click()
  await expect(library(page).getByRole('button', { name: 'Projects', exact: true })).toContainText('1')
})

test('create, rename and delete a tag', async ({ page }) => {
  await library(page).getByRole('button', { name: 'New tag', exact: true }).click()
  await nameDialog(page, 'New tag', 'garden', 'Create')
  await more(page, '#garden').click()
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  await nameDialog(page, 'Rename tag', 'outdoors', 'Rename')
  await more(page, '#outdoors').click()
  await page.getByRole('menuitem', { name: 'Delete tag…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete the tag “outdoors”?' })
  await expect(dialog).toContainText('Notes keep their text; only the tag is removed.')
  await dialog.getByRole('button', { name: 'Delete tag' }).click()
  await expect(library(page).getByRole('button', { name: '#outdoors', exact: true })).toHaveCount(0)
})

test('a duplicate tag name is refused with its message', async ({ page }) => {
  await library(page).getByRole('button', { name: 'New tag', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New tag' })
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Reading')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('A tag named “Reading” already exists.')
  await expect(dialog).toBeVisible()
})

test('empty the Trash asks first', async ({ page }) => {
  await more(page, 'Trash').click()
  await page.getByRole('menuitem', { name: 'Empty Trash…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Empty the Trash?' })
  await expect(dialog).toContainText("1 note will be deleted for good. This can't be undone.")
  await dialog.getByRole('button', { name: 'Empty Trash' }).click()
  await expect(library(page).getByRole('button', { name: 'Trash', exact: true })).not.toContainText('1')
})

test('dialogs keep focus inside and close on Escape', async ({ page }) => {
  await library(page).getByRole('button', { name: 'New notebook', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New notebook' })
  await expect(dialog.getByRole('textbox', { name: 'Name' })).toBeFocused()
  await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled()
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(list(page)).toBeVisible()
})

test('a row’s context menu pins and trashes', async ({ page }) => {
  const rows = page.getByRole('listbox', { name: 'Notes' })
  await rows.getByRole('option', { name: /^Bread notes/ }).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'More for Bread notes' })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Pin' })).toBeFocused()
  await menu.getByRole('menuitem', { name: 'Pin' }).click()
  await expect(rows.getByRole('option', { name: /^Bread notes, pinned/ })).toHaveCount(1)
  await rows.getByRole('option', { name: /^Bread notes/ }).click({ button: 'right' })
  await expect(page.getByRole('menu', { name: 'More for Bread notes' }).getByRole('menuitem', { name: 'Unpin' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Move to Trash' }).click()
  await expect(rows.getByRole('option', { name: /^Bread notes/ })).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('“Bread notes” moved to the Trash.')
})

test('in the Trash the row menu restores and deletes', async ({ page }) => {
  await page.getByRole('navigation', { name: 'Library' }).getByRole('button', { name: 'Trash', exact: true }).click()
  const rows = page.getByRole('listbox', { name: 'Notes' })
  await rows.getByRole('option', { name: /^Old draft/ }).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'More for Old draft' })
  await expect(menu.getByRole('menuitem')).toHaveText(['Restore note', 'Delete permanently…'])
  await menu.getByRole('menuitem', { name: 'Delete permanently…' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click()
  await expect(rows.getByRole('option')).toHaveCount(0)
})

test('Shift+F10 on a focused row opens the same menu, and Escape returns to the row', async ({ page }) => {
  const rows = page.getByRole('listbox', { name: 'Notes' })
  const row = rows.getByRole('option', { name: /^Groceries/ })
  await row.click()
  await row.focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: 'More for Groceries' })
  await expect(menu.getByRole('menuitem', { name: 'Unpin' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(row).toBeFocused()
})
