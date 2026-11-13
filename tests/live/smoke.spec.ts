// The published demo, checked from outside: FEATHER_LIVE_URL=https://app.feathermark.com pnpm e2e:live
// It runs the same leak fixture as every browser test: no policy violation, no request to another host,
// nothing stored. Read-only: it only uses the demo, which keeps nothing.
import { readFileSync } from 'node:fs'
import { contentSecurityPolicy } from '../../scripts/policy.ts'
import { test, expect } from '../e2e/fixtures'

test('the live demo loads, sends the policy, edits and downloads, and leaks nothing', async ({ page }) => {
  const response = await page.goto('/')
  expect(response!.status()).toBe(200)
  expect(response!.headers()['content-security-policy']).toBe(contentSecurityPolicy())
  await expect(page.getByText("This is a demo. Notes here aren't saved.")).toBeVisible()
  await page.keyboard.press('Alt+n')
  await page.keyboard.type('Live check')
  await page.keyboard.press('Enter')
  await page.keyboard.type('word')
  await page.keyboard.press('Shift+Home')
  await page.keyboard.press('ControlOrMeta+b')
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('toolbar', { name: 'Note' }).getByRole('button', { name: 'Download .md' }).click()])
  expect(readFileSync((await download.path())!, 'utf8').endsWith('\n---\n\n**word**')).toBe(true)
})

test('a hashed asset is cached for a year', async ({ page, request }) => {
  await page.goto('/')
  const script = await page.locator('script[src^="/assets/"]').first().getAttribute('src')
  const r = await request.get(script!)
  expect(r.headers()['cache-control']).toBe('public, max-age=31536000, immutable')
})
