import { test, expect, storageReport } from './fixtures'

test('an inline script is blocked and recorded', async ({ page, leaks }) => {
  leaks.expectViolation(/script-src/)
  await page.goto('/')
  const ran = await page.evaluate(() => {
    const s = document.createElement('script')
    s.textContent = 'window.__inline = 1'
    document.head.append(s)
    return '__inline' in window
  })
  expect(ran).toBe(false)
})

test('an inline style is blocked and recorded', async ({ page, leaks }) => {
  leaks.expectViolation(/style-src/)
  await page.goto('/')
  await page.evaluate(() => document.body.setAttribute('style', 'outline: 3px solid red'))
  expect(await page.evaluate(() => getComputedStyle(document.body).outlineStyle)).toBe('none')
})

test('a request to another host is blocked and recorded', async ({ page, leaks }) => {
  leaks.expectViolation(/connect-src/)
  leaks.allowForeignRequest(/example\.invalid/)
  await page.goto('/')
  const failed = await page.evaluate(() => fetch('https://example.invalid/').then(() => false, () => true))
  expect(failed).toBe(true)
})

test('the storage report sees what a page writes', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.setItem('x', '1'))
  expect((await storageReport(page)).localStorage).toBe(1)
  await page.evaluate(() => localStorage.clear())
})
