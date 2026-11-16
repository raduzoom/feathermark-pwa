// The main screen at a common laptop size (1024 x 768): the sidebar shows what it holds, and the note toolbar stays
// on one row, with Tags and Move under More when the note area is narrow.
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

const library = (page: Page) => page.getByRole('navigation', { name: 'Library' })
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Note' })

test('at 1024 x 768 the demo card is compact and every top-level notebook shows', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.goto('/')
  const link = (await library(page).getByRole('link', { name: 'Get FeatherMark' }).boundingBox())!
  const text = (await page.getByText("This is a demo. Notes here aren't saved.").boundingBox())!
  // two lines of sentence and the link's line under it (about 66 px), not a boxed card with a full-height button (~116)
  expect(link.y + link.height - text.y).toBeLessThanOrEqual(72)
  const scroll = await page.evaluate(() => {
    const s = document.querySelector('.library-scroll')!.getBoundingClientRect()
    return { top: s.top, bottom: s.bottom }
  })
  for (const name of ['Personal', 'Projects', 'Travel']) {
    const b = (await library(page).getByRole('button', { name, exact: true }).boundingBox())!
    expect(b.y + b.height).toBeLessThanOrEqual(scroll.bottom)
  }
})

test('at 1024 x 768 the note toolbar is one row, with Tags and Move under More', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.goto('/')
  await expect(toolbar(page).getByRole('button', { name: 'Tags', exact: true })).toHaveCount(0)
  await expect(toolbar(page).getByRole('button', { name: 'Move', exact: true })).toHaveCount(0)
  const tops = await toolbar(page).evaluate((el) => [...el.children].map((c) => Math.round(c.getBoundingClientRect().top)))
  expect(new Set(tops).size).toBe(1)

  await toolbar(page).getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Move', exact: true }).click()
  await page.getByRole('menuitemradio', { name: 'Travel' }).click()
  await expect(page.getByText('Travel', { exact: true }).first()).toBeVisible()

  await toolbar(page).getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Tags', exact: true }).click()
  await page.getByRole('menuitemcheckbox', { name: 'ideas' }).click()
  await expect(page.getByRole('menuitemcheckbox', { name: 'ideas' })).toHaveAttribute('aria-checked', 'true')
})

test('at 1440 x 900 Tags and Move stay in the toolbar and More holds only the rare actions', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(toolbar(page).getByRole('button', { name: 'Tags', exact: true })).toBeVisible()
  await expect(toolbar(page).getByRole('button', { name: 'Move', exact: true })).toBeVisible()
  await toolbar(page).getByRole('button', { name: 'More', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Tags', exact: true })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Download .md' })).toBeVisible()
})
