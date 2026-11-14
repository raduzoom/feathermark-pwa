import type { Locator, Page } from '@playwright/test'

/** Opens the note toolbar's "More" menu and returns its item named `item` ("Download .md", "Move to Trash"). */
export async function noteMore(page: Page, item: string): Promise<Locator> {
  await page.getByRole('toolbar', { name: 'Note' }).getByRole('button', { name: 'More', exact: true }).click()
  return page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: item })
}
