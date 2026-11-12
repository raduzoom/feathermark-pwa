import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

const library = (page: Page) => page.getByRole('navigation', { name: 'Library' })
const notes = (page: Page) => page.getByRole('region', { name: 'Notes' })

test('the page is FeatherMark', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle('FeatherMark')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('heading', { level: 1, name: 'FeatherMark' })).toBeVisible()
})

test('three columns at desktop width', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(library(page)).toBeVisible()
  await expect(notes(page)).toBeVisible()
  await expect(page.getByRole('main')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open library' })).toHaveCount(0)
  expect((await library(page).boundingBox())!.width).toBe(232)
  expect((await page.getByRole('banner').boundingBox())!.height).toBe(56)
  expect((await notes(page).boundingBox())!.width).toBeLessThanOrEqual(340)
  expect(await library(page).evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('24px')
})

test('the library is a drawer at tablet width', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 })
  await page.goto('/')
  const open = page.getByRole('button', { name: 'Open library' })
  await expect(library(page)).toBeHidden()
  await expect(page.getByRole('button', { name: 'New note', exact: true })).toHaveCount(1)
  await expect(open).toHaveAttribute('aria-expanded', 'false')
  await open.click()
  await expect(library(page)).toBeVisible()
  await expect(open).toHaveAttribute('aria-expanded', 'true')
  expect(await library(page).evaluate((el) => el.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(library(page)).toBeHidden()
  await expect(open).toBeFocused()
})

test('the open drawer keeps keyboard and screen reader inside it', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open library' }).click()
  await expect(library(page)).toBeVisible()
  // What's behind the scrim is inert: out of the accessibility tree and out of focus order (HTML `inert`;
  // Playwright's role queries don't apply inert, so check the attribute's reach directly).
  const behind = await page.evaluate(() =>
    [...document.querySelectorAll('button, main, section, header')]
      .filter((el) => !document.getElementById('library')!.contains(el) && (el as HTMLElement).offsetParent !== null)
      .map((el) => ({ el: el.tagName + (el.textContent ? ` "${el.textContent.trim()}"` : ''), inert: !!el.closest('[inert]') })),
  )
  expect(behind.length).toBeGreaterThan(0)
  expect(behind.filter((b) => !b.inert)).toEqual([])
  for (const key of ['Tab', 'Tab', 'Shift+Tab']) {
    await page.keyboard.press(key)
    const outside = await page.evaluate(() => {
      const active = document.activeElement
      return !!active && active !== document.body && !document.getElementById('library')!.contains(active)
    })
    expect(outside, `focus left the drawer after ${key}`).toBe(false)
  }
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => document.querySelectorAll('[inert]').length)).toBe(0)
})

test('widening the window past the drawer width closes it', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open library' }).click()
  await expect(library(page)).toBeVisible()
  await page.setViewportSize({ width: 1180, height: 820 })
  const newNote = page.getByRole('button', { name: 'New note', exact: true })
  await expect(newNote).toBeVisible()
  await newNote.click({ timeout: 2000 })
  expect(await page.evaluate(() => !!document.elementFromPoint(900, 400)?.closest('main'))).toBe(true)
})

test('one column at phone width, nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(notes(page)).toBeVisible()
  await expect(page.getByRole('main')).toBeHidden()
  const newNote = page.getByRole('button', { name: 'New note', exact: true })
  await expect(newNote).toHaveCount(1)
  expect((await newNote.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  expect((await page.getByRole('button', { name: 'Open library' }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})

for (const [scheme, colour] of [['light', 'rgb(241, 226, 213)'], ['dark', 'rgb(17, 23, 29)']] as const) {
  test(`the page background in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto('/')
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(colour)
  })
}
