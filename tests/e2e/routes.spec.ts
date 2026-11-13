// Every path shows the app: /login is the demo until accounts arrive (Phase 20), and an unknown path is too.
// The preview server and Cloudflare Pages both answer an unknown path with index.html.
import { test, expect } from './fixtures'

for (const path of ['/login', '/no/such/page']) {
  test(`${path} shows the demo`, async ({ page }) => {
    const response = await page.goto(path)
    expect(response!.status()).toBe(200)
    await expect(page.getByText("This is a demo. Notes here aren't saved.")).toBeVisible()
    await expect(page.getByRole('listbox', { name: 'Notes' }).getByRole('option').first()).toBeVisible()
  })
}
