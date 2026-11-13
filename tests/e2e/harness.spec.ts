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

test('a second context from leaks.newContext() is watched too: violations, foreign requests and storage', async ({ leaks }) => {
  const other = await leaks.newContext()
  const page = await other.newPage()
  await page.goto('/')
  // a policy violation, a request to another host, and something stored, all in the second context only
  await page.evaluate(() => document.body.setAttribute('style', 'outline: 3px solid red'))
  await page.evaluate(() => fetch('https://example.invalid/').catch(() => undefined))
  await page.evaluate(() => localStorage.setItem('left', 'behind'))
  await expect.poll(async () => (await leaks.problems()).join('\n')).toMatch(/style-src/)
  const problems = (await leaks.problems()).join('\n')
  expect(problems).toMatch(/connect-src|request to another origin: https:\/\/example\.invalid/)
  expect(problems).toMatch(/localStorage: 1 item/)
  leaks.forgive()
})

test('leaks.allowKeptVault() lets the "feathermark" database through, and no other', async ({ page, leaks }) => {
  await page.goto('/')
  const make = (name: string) =>
    page.evaluate(
      (n) =>
        new Promise<void>((ok) => {
          const r = indexedDB.open(n)
          r.onsuccess = () => (r.result.close(), ok())
        }),
      name,
    )
  await make('feathermark')
  expect((await leaks.problems()).join('\n')).toMatch(/IndexedDB: feathermark/)
  leaks.allowKeptVault()
  expect(await leaks.problems()).toEqual([])
  await make('something-else')
  expect((await leaks.problems()).join('\n')).toMatch(/IndexedDB: something-else$/m)
  leaks.forgive()
})
