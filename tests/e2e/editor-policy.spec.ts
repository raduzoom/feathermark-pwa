import { test, expect } from './fixtures'

// CodeMirror injects its base theme and sets attributes at run time; the fixture fails this test on any
// policy violation, so it proves the editor runs under the policy unchanged.
test('an editor mounts, takes typing and breaks no policy', async ({ page }) => {
  await page.goto('/')
  await page.keyboard.press('Alt+n')
  await page.keyboard.press('Enter')
  const body = page.getByRole('textbox', { name: 'Note' })
  await expect(body).toHaveAttribute('contenteditable', 'true')
  await page.keyboard.type('hello')
  await expect(body).toContainText('hello')
  // CodeMirror's own theme took effect (a refused stylesheet would leave the browser defaults).
  expect(await body.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('break-spaces')
  expect(await page.locator('.cm-editor').evaluate((el) => getComputedStyle(el).display)).toBe('flex')
  expect(await page.evaluate(() => document.querySelectorAll('style').length)).toBe(0)
})
