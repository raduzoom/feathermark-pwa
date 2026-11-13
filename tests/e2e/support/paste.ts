// Pastes into the focused element the way a browser does: a `paste` ClipboardEvent whose DataTransfer holds the
// data. Works in Chromium and WebKit without clipboard permissions, and never touches the system clipboard.
import type { Page } from '@playwright/test'

export async function paste(page: Page, data: { text?: string; html?: string; files?: Array<{ name: string; type: string; base64: string }> }) {
  await page.evaluate((d) => {
    const dt = new DataTransfer()
    if (d.text !== undefined) dt.setData('text/plain', d.text)
    if (d.html !== undefined) dt.setData('text/html', d.html)
    for (const f of d.files ?? []) {
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))
      dt.items.add(new File([bytes], f.name, { type: f.type }))
    }
    const target = document.activeElement ?? document.body
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, data)
}

/** A new note titled `title` holding exactly `body`, with the body focused and the caret at its end. */
export async function newNoteWith(page: Page, title: string, body: string) {
  await page.keyboard.press('Alt+n')
  await page.keyboard.type(title)
  await page.keyboard.press('Enter')
  await paste(page, { text: body })
}
