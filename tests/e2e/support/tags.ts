import type { Page } from '@playwright/test'

/** Unfolds the library's Tags section (folded at load) unless it is open already. */
export async function openTags(page: Page): Promise<void> {
  const tags = page.getByRole('navigation', { name: 'Library' }).getByRole('button', { name: 'Tags', exact: true })
  if ((await tags.getAttribute('aria-expanded')) !== 'true') await tags.click()
}
