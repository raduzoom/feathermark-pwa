import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { openTags } from './support/tags'

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
  await expect(library(page).getByRole('button', { name: '#hardware', exact: true })).toHaveCount(0)
  await openTags(page)
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
  await openTags(page)
  await library(page).getByRole('button', { name: '#reading', exact: true }).click()
  expect(await titles(page)).toEqual(['Reading list 2027'])
  await library(page).getByRole('button', { name: 'Pinned', exact: true }).click()
  expect(await titles(page)).toEqual(['Welcome to the FeatherMark demo', 'Weather station build', 'Groceries'])
})

test('tags are folded until opened, and open when a tag is the selected view', async ({ page }) => {
  const tags = library(page).getByRole('button', { name: 'Tags', exact: true })
  const reading = library(page).getByRole('button', { name: '#reading', exact: true })
  await expect(tags).toHaveAttribute('aria-expanded', 'false')
  await expect(tags).toContainText('4')
  await expect(reading).toHaveCount(0)
  await tags.click()
  await expect(tags).toHaveAttribute('aria-expanded', 'true')
  await reading.click()
  // folding while a tag is the view keeps the list: the selected tag stays in sight
  await tags.click()
  await expect(tags).toHaveAttribute('aria-expanded', 'true')
  await expect(reading).toHaveAttribute('aria-current', 'page')
  await library(page).getByRole('button', { name: 'All notes', exact: true }).click()
  await expect(tags).toHaveAttribute('aria-expanded', 'false')
  await expect(reading).toHaveCount(0)
})

test('counts, the Tags count and the "+" share one right-hand column', async ({ page }) => {
  const right = async (l: ReturnType<typeof library>) => {
    const b = (await l.boundingBox())!
    return Math.round(b.x + b.width)
  }
  const count = (row: string, n: string) => library(page).getByRole('button', { name: row, exact: true }).getByText(n, { exact: true })
  // the "+" is a 16 px icon centred in a 32 px button: it ends 8 px in from the button's edge
  const plus = (await right(library(page).getByRole('button', { name: 'New notebook', exact: true }))) - 8
  const rows: Array<[string, string]> = [['All notes', '7'], ['Pinned', '3'], ['Personal', '3'], ['Home', '1'], ['Tags', '4'], ['Trash', '1']]
  for (const [row, n] of rows)
    expect(await right(count(row, n)), `${row} count`).toBe(plus)
})

test('"New tag" is inside the open Tags panel, not on the Tags row', async ({ page }) => {
  await expect(library(page).getByRole('button', { name: 'New tag', exact: true })).toHaveCount(0)
  await openTags(page)
  await expect(library(page).getByRole('list', { name: 'Tags' }).getByRole('button', { name: 'New tag', exact: true })).toBeVisible()
})

test('the library ends with the demo card, Trash, then Collapse sidebar', async ({ page }) => {
  const box = async (name: string) => (await library(page).getByRole('button', { name, exact: true }).boundingBox())!
  const nav = (await library(page).boundingBox())!
  const travel = await box('Travel')
  const trash = await box('Trash')
  const collapse = await box('Collapse sidebar')
  const demo = (await library(page).getByRole('link', { name: 'Get FeatherMark' }).boundingBox())!
  expect(demo.y).toBeGreaterThan(travel.y)
  expect(trash.y).toBeGreaterThan(demo.y)
  expect(collapse.y).toBeGreaterThan(trash.y)
  // the scroll area's bottom padding (16 px) is all that's under the last button
  expect(nav.y + nav.height - (collapse.y + collapse.height)).toBeLessThanOrEqual(24)
})

test('rows are grouped under Pinned, Today, Yesterday and Earlier', async ({ page }) => {
  const group = (name: string) => list(page).getByRole('group', { name, exact: true })
  await expect(group('Pinned').getByRole('option')).toHaveCount(3)
  await expect(group('Today')).toHaveCount(0)
  await expect(group('Yesterday').getByRole('option')).toHaveCount(1)
  await expect(group('Earlier').getByRole('option')).toHaveCount(3)
  await page.keyboard.press('Alt+n')
  await page.keyboard.type('Fresh note')
  await expect(group('Today').getByRole('option', { name: /^Fresh note/ })).toHaveCount(1)
  // the Pinned view doesn't put pinned notes first, so it has no Pinned heading
  await library(page).getByRole('button', { name: 'Pinned', exact: true }).click()
  await expect(group('Pinned')).toHaveCount(0)
  await expect(list(page).getByRole('group').getByRole('option')).toHaveCount(3)
})

test('search results and Trash have no groups', async ({ page }) => {
  await page.getByRole('searchbox', { name: 'Search in this view' }).fill('the')
  await expect(list(page).getByRole('option').first()).toBeVisible()
  await expect(list(page).getByRole('group')).toHaveCount(0)
  await page.getByRole('searchbox', { name: 'Search in this view' }).fill('')
  await library(page).getByRole('button', { name: 'Trash', exact: true }).click()
  await expect(list(page).getByRole('option')).toHaveCount(1)
  await expect(list(page).getByRole('group')).toHaveCount(0)
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

test('tag chips keep their place when hovered, chosen or their menu opens, and the menu stays in the library', async ({ page }) => {
  await openTags(page)
  // the foot (demo card, Trash, Collapse sidebar) stays in view, so at 900 px the open chips sit lower in the
  // scrolling part; bring them fully into view first, or the click itself scrolls them
  await library(page).getByRole('button', { name: 'New tag', exact: true }).scrollIntoViewIfNeeded()
  const names = ['#hardware', '#ideas', '#reading', '#to-do']
  // to the pixel: bold and regular text can differ by a sliver of one in Chromium
  const boxes = async () =>
    (await Promise.all(names.map((n) => library(page).getByRole('button', { name: n, exact: true }).boundingBox()))).map((b) => ({
      x: Math.round(b!.x),
      y: Math.round(b!.y),
      width: Math.round(b!.width),
      height: Math.round(b!.height),
    }))
  const before = await boxes()
  const hardware = library(page).getByRole('button', { name: '#hardware', exact: true })
  await hardware.hover()
  expect(await boxes()).toEqual(before)
  await hardware.click()
  expect(await boxes()).toEqual(before)
  await library(page).getByRole('button', { name: 'More for #hardware' }).click()
  const menu = page.getByRole('menu', { name: 'More for #hardware' })
  await expect(menu).toBeVisible()
  expect(await boxes()).toEqual(before)
  const nav = (await library(page).boundingBox())!
  const box = (await menu.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(nav.x)
  expect(box.x + box.width).toBeLessThanOrEqual(nav.x + nav.width)
  expect(box.y).toBeGreaterThanOrEqual(before[0]!.y + before[0]!.height)
})
