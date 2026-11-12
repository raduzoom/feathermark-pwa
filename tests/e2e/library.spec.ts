import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

const library = (page: Page) => page.getByRole('navigation', { name: 'Library' })
const list = (page: Page) => page.getByRole('listbox', { name: 'Notes' })
const titles = async (page: Page) => (await list(page).getByRole('option').allInnerTexts()).map((t) => t.split('\n')[0]!.trim())

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
})

test('the demo opens with the sample library', async ({ page }) => {
  for (const [view, count] of [['All notes', '7'], ['Recent', null], ['Pinned', '3'], ['Trash', '1']] as const) {
    const button = library(page).getByRole('button', { name: view, exact: true })
    await expect(button).toBeVisible()
    if (count) await expect(button).toContainText(count)
  }
  for (const nb of ['Personal', 'Projects', 'Home', 'Work', 'Travel']) await expect(library(page).getByRole('button', { name: nb, exact: true })).toBeVisible()
  for (const tag of ['#hardware', '#ideas', '#reading', '#to-do']) await expect(library(page).getByRole('button', { name: tag, exact: true })).toBeVisible()
  expect(await titles(page)).toEqual([
    'Welcome to the FeatherMark demo',
    'Weather station build',
    'Groceries',
    'Reading list 2027',
    'Lisbon, spring trip',
    '1:1 with Mara',
    'Bread notes',
  ])
  await expect(list(page).getByRole('option').first()).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Welcome to the FeatherMark demo')
  await expect(page.getByRole('heading', { level: 2, name: 'All notes' })).toBeVisible()
})

test('choosing a view or notebook lists its notes in order', async ({ page }) => {
  await library(page).getByRole('button', { name: 'Projects', exact: true }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible()
  expect(await titles(page)).toEqual(['Weather station build', '1:1 with Mara'])
  await expect(library(page).getByRole('button', { name: 'Projects', exact: true })).toHaveAttribute('aria-current', 'page')
  await library(page).getByRole('button', { name: '#reading', exact: true }).click()
  expect(await titles(page)).toEqual(['Reading list 2027'])
  await library(page).getByRole('button', { name: 'Pinned', exact: true }).click()
  expect(await titles(page)).toEqual(['Welcome to the FeatherMark demo', 'Weather station build', 'Groceries'])
})

test('the keyboard moves through the list', async ({ page }) => {
  await list(page).getByRole('option').first().focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Weather station build')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Weather station build')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: 'Note' })).toBeFocused()
})

test('the Trash shows deleted notes with their removal date', async ({ page }) => {
  await library(page).getByRole('button', { name: 'Trash', exact: true }).click()
  const row = list(page).getByRole('option', { name: /Old draft/ })
  await expect(row).toContainText('Deleted today · removed in 30 days')
})
