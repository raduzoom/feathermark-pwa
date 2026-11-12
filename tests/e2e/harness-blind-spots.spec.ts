// Each test breaks a rule somewhere the harness once could not see, then checks the harness lists it.
// leaks.forgive() lets these deliberate leaks through teardown; no other test may call it.
import { test, expect } from './fixtures'
import { securityHeaders } from '../../scripts/policy.ts'

test('a violation inside a worker is listed', async ({ page, leaks }) => {
  await page.route('**/__probe/worker.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      headers: securityHeaders(),
      // The pause lets the harness attach to the worker first; the crypto worker only acts on messages.
      body: "setTimeout(() => fetch('https://example.invalid/w').catch(() => {}), 500)",
    }),
  )
  await page.goto('/')
  await page.evaluate(() => void new Worker('/__probe/worker.js'))
  await expect.poll(() => leaks.problems(), { timeout: 5000 }).toContainEqual(expect.stringMatching(/connect-src/))
  leaks.forgive()
})

test('a violation in a second page is listed', async ({ page, context, leaks }) => {
  await page.goto('/')
  const other = await context.newPage()
  await other.goto('/')
  await other.evaluate(() => document.body.setAttribute('style', 'color: red'))
  await expect.poll(() => leaks.problems()).toContainEqual(expect.stringMatching(/style-src/))
  leaks.forgive()
})

test('an undeclared violation before a reload is listed', async ({ page, leaks }) => {
  leaks.expectViolation(/style-src/)
  await page.goto('/')
  await page.evaluate(() => {
    const s = document.createElement('script')
    s.textContent = '1'
    document.head.append(s)
  })
  await page.reload()
  await page.evaluate(() => document.body.setAttribute('style', 'color: red'))
  await expect.poll(() => leaks.problems()).toContainEqual(expect.stringMatching(/script-src/))
  leaks.forgive()
})

test('storage written before the page closes is listed', async ({ page, leaks }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.setItem('x', '1'))
  await page.close()
  expect(await leaks.problems()).toContainEqual(expect.stringMatching(/localStorage/))
  leaks.forgive()
})

test('storage written before navigating away is listed', async ({ page, leaks }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.setItem('x', '1'))
  await page.goto('about:blank')
  expect(await leaks.problems()).toContainEqual(expect.stringMatching(/localStorage/))
  leaks.forgive()
})

test('a cookie is listed', async ({ page, context, leaks, baseURL }) => {
  await page.goto('/')
  await context.addCookies([{ name: 'c', value: '1', url: baseURL! }])
  expect(await leaks.problems()).toContainEqual(expect.stringMatching(/cookie/))
  leaks.forgive()
})

test('a clean second page lists nothing', async ({ page, context, leaks }) => {
  await page.goto('/')
  const other = await context.newPage()
  await other.goto('/')
  await expect(other.getByRole('heading', { name: 'FeatherMark' })).toBeVisible()
  expect(await leaks.problems()).toEqual([])
})
