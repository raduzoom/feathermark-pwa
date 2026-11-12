// Screenshots to compare with the web boards by eye. No assertions beyond loading.
import type { Page } from '@playwright/test'
import { test, type Leaks } from './fixtures'

const sizes = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 800, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]

// Playwright's WebKit screenshot injects an empty inline <style> of its own, which the policy blocks.
// Only these picture-taking tests declare it, and only in WebKit; every other test still fails on it.
async function shoot(page: Page, leaks: Leaks, engine: string, path: string) {
  if (engine === 'webkit') leaks.expectViolation(/^style-src-elem inline$/)
  await page.screenshot({ path, caret: 'initial' })
}

for (const scheme of ['light', 'dark'] as const) {
  for (const size of sizes) {
    test(`screen ${size.name} ${scheme}`, async ({ page, leaks }, info) => {
      await page.setViewportSize(size)
      await page.emulateMedia({ colorScheme: scheme })
      await page.goto('/')
      await shoot(page, leaks, info.project.name, `test-results/screens/${info.project.name}-${size.width}-${scheme}.png`)
    })
  }
}

test('screen tablet with the drawer open', async ({ page, leaks }, info) => {
  await page.setViewportSize({ width: 800, height: 900 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open library' }).click()
  await page.waitForTimeout(400)
  await shoot(page, leaks, info.project.name, `test-results/screens/${info.project.name}-800-drawer.png`)
})
