// Runs against the build with VITE_FEATHER_CLOUD_URL set (the `cloud` project in playwright.config.ts).
import { test, expect } from '../e2e/fixtures'

test('with accounts on, the demo line offers Log in and Create account, not Get FeatherMark', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText("This is a demo. Notes here aren't saved.")).toBeVisible()
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Get FeatherMark' })).toHaveCount(0)
})

test('the demo makes no request to Feather Cloud until Log in or Create account is used', async ({ page, leaks }) => {
  const cloud: string[] = []
  page.on('request', (r) => {
    if (new URL(r.url()).origin === 'http://localhost:8420') cloud.push(r.url())
  })
  await page.goto('/')
  await page.getByRole('option', { name: /^Groceries/ }).click()
  await page.getByRole('textbox', { name: 'Note' }).fill('typing in the demo')
  await page.waitForTimeout(500)
  expect(cloud).toEqual([])
  expect(await leaks.problems()).toEqual([])
})

test('the policy lets the page connect to Feather Cloud and nowhere else', async ({ page }) => {
  const response = await page.goto('/')
  const csp = (await response!.allHeaders())['content-security-policy']
  expect(csp).toContain("connect-src 'self' http://localhost:8420;")
})
