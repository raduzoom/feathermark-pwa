// Reads the open note's body as the app stores it, through "Download .md" (the editor hides characters in live
// preview and holds LF line breaks, so the page's text is not the note's bytes).
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { noteMore } from './note-more'

export async function downloadedBody(page: Page): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent('download'), (await noteMore(page, 'Download .md')).click()])
  const file = readFileSync(await download.path(), 'utf8')
  // front matter, then exactly one blank line, then the body (data-model.md "Front matter")
  const end = file.indexOf('\n---\n')
  return file.slice(end + '\n---\n'.length + 1)
}
