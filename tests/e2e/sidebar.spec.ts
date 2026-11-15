// The library column shrinks to a rail of icons and back (from 1000 px; below that it is the drawer).
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

const library = (page: Page) => page.getByRole('navigation', { name: 'Library' })
const notes = (page: Page) => page.getByRole('region', { name: 'Notes' })
const width = async (page: Page) => (await library(page).boundingBox())!.width

test('the sidebar shrinks to a rail of icons and expands again', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  expect(await width(page)).toBe(232)
  const listBefore = (await notes(page).boundingBox())!.x

  await library(page).getByRole('button', { name: 'Collapse sidebar' }).click()
  expect(await width(page)).toBe(72)
  // the sheet takes the room the library gave up
  expect((await notes(page).boundingBox())!.x).toBe(listBefore - (232 - 72))

  // every view keeps its button and its name, drawn as an icon alone
  for (const name of ['New note', 'All notes', 'Recent', 'Pinned', 'Trash']) {
    const button = library(page).getByRole('button', { name, exact: true })
    await expect(button).toBeVisible()
    expect((await button.boundingBox())!.width).toBe(40)
    await expect(button).toHaveAttribute('title', name)
  }
  // top-level notebooks stay as their dots; sub-notebooks, headings, counts and tags are out of the rail
  await expect(library(page).getByRole('button', { name: 'Personal', exact: true })).toBeVisible()
  await expect(library(page).getByRole('button', { name: 'Home', exact: true })).toBeHidden()
  await expect(library(page).getByRole('button', { name: 'Tags', exact: true })).toBeHidden()
  await expect(library(page).getByRole('button', { name: 'New notebook', exact: true })).toBeHidden()
  await expect(library(page).getByText('7', { exact: true })).toBeHidden()
  // the app's name is still the page's heading, and search is still one click away
  await expect(page.getByRole('heading', { level: 1, name: 'FeatherMark' })).toBeAttached()
  await expect(page.getByRole('button', { name: 'Search and quick actions' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Get FeatherMark' })).toBeVisible()
  // nothing in the rail is wider than the rail
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440)

  await library(page).getByRole('button', { name: 'Recent', exact: true }).click()
  await expect(notes(page).getByRole('heading', { name: 'Recent' })).toBeVisible()

  await library(page).getByRole('button', { name: 'Expand sidebar' }).click()
  expect(await width(page)).toBe(232)
  await expect(library(page).getByRole('button', { name: 'Home', exact: true })).toBeVisible()
  await expect(library(page).getByRole('button', { name: 'Collapse sidebar' })).toBeVisible()
  // no tooltip while the name is on screen (Preact leaves an empty title behind)
  expect((await library(page).getByRole('button', { name: 'All notes', exact: true }).getAttribute('title')) ?? '').toBe('')
})

test('the rail keeps the keyboard: an icon takes focus and Enter picks it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await library(page).getByRole('button', { name: 'Collapse sidebar' }).click()
  // Safari's Tab skips buttons unless the system setting is on, so focus is set directly
  await library(page).getByRole('button', { name: 'Recent', exact: true }).focus()
  await expect(library(page).getByRole('button', { name: 'Recent', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(notes(page).getByRole('heading', { name: 'Recent' })).toBeVisible()
})

test('below 1000 px the library is the drawer, with nothing to collapse', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open library' }).click()
  await expect(library(page).getByRole('button', { name: 'All notes', exact: true })).toBeVisible()
  await expect(library(page).getByRole('button', { name: 'Collapse sidebar' })).toBeHidden()
})

test('a rail left on becomes the full drawer when the window narrows', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await library(page).getByRole('button', { name: 'Collapse sidebar' }).click()
  await page.setViewportSize({ width: 800, height: 900 })
  await page.getByRole('button', { name: 'Open library' }).click()
  await expect(library(page).getByRole('button', { name: 'Home', exact: true })).toBeVisible()
  await expect(library(page).getByRole('button', { name: 'Tags', exact: true })).toBeVisible()
})
