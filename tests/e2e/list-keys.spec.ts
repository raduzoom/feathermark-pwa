import { test, expect } from './fixtures'
test('fast arrow keys move one row each', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.getByRole('listbox', { name: 'Notes' }).getByRole('option').first().focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Groceries')
})
