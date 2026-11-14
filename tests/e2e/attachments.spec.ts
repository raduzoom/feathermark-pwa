// Attachments in the demo: the sample image, paste and drop, chips, missing attachments, opening a file.
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { RADIATION_SHIELD_PNG_BASE64 } from '../../src/core/library/sample-image.ts'
import { test, expect } from './fixtures'
import { noteMore } from './support/note-more'
import { newNoteWith, paste } from './support/paste'

const list = (page: Page) => page.getByRole('listbox', { name: 'Notes' })
const open = (page: Page, title: string) => list(page).getByRole('option', { name: new RegExp(`^${title}`) }).click()
// a real PNG: the sample picture
const PNG = RADIATION_SHIELD_PNG_BASE64
const PDF = btoa('%PDF-1.4\n%demo\n')

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
})

test('the sample note shows its image', async ({ page }) => {
  await open(page, 'Weather station build')
  const img = page.getByRole('img', { name: 'Radiation shield' })
  await expect(img).toBeVisible()
  expect(await img.getAttribute('src')).toMatch(/^blob:http:\/\/localhost:8431\//)
  expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(640)
})

test('pasting an image file attaches it', async ({ page }) => {
  await newNoteWith(page, 'Pasted image', 'Above\n\n') // a blank line above: an image sharing a paragraph with text is a chip
  await paste(page, { files: [{ name: 'dot.png', type: 'image/png', base64: PNG }] })
  await expect(page.getByRole('img', { name: 'dot.png' })).toBeVisible()
})

test('dropping a file attaches it and never navigates', async ({ page }) => {
  await newNoteWith(page, 'Dropped', 'Receipt:')
  const url = page.url()
  const line = page.locator('#note-body .cm-line').first()
  const box = (await line.boundingBox())!
  await page.evaluate(
    ({ x, y, pdf }) => {
      const dt = new DataTransfer()
      dt.items.add(new File([Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0))], 'receipt.pdf', { type: 'application/pdf' }))
      const target = document.elementFromPoint(x, y)!
      for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }))
    },
    { x: box.x + box.width - 4, y: box.y + box.height / 2, pdf: PDF },
  )
  await page.keyboard.press('ControlOrMeta+Home') // the caret away, so the link shows as a chip
  await expect(page.getByRole('link', { name: 'receipt.pdf, attachment' })).toBeVisible()
  expect(page.url()).toBe(url)
})

test('a file dropped outside the editor is ignored, not opened', async ({ page }) => {
  const url = page.url()
  const prevented = await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'x.txt', { type: 'text/plain' }))
    const e = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
    document.body.dispatchEvent(e)
    return e.defaultPrevented
  })
  expect(prevented).toBe(true)
  expect(page.url()).toBe(url)
})

test('a missing attachment shows a missing chip', async ({ page }) => {
  await newNoteWith(page, 'Missing', 'See [old.pdf](feather://attachment/01JC8ZT9HJ2KM3MN4PQ5RS6TV7)\n\nend')
  await expect(page.getByRole('link', { name: 'old.pdf, missing attachment' })).toBeVisible()
})

test('clicking a chip downloads the file', async ({ page }) => {
  await newNoteWith(page, 'Chip', 'File:')
  await page.keyboard.press('Enter')
  await paste(page, { files: [{ name: 'receipt.pdf', type: 'application/pdf', base64: PDF }] })
  await page.keyboard.press('ControlOrMeta+Home')
  const chip = page.getByRole('link', { name: 'receipt.pdf, attachment' })
  const [download] = await Promise.all([page.waitForEvent('download'), chip.click()])
  expect(download.suggestedFilename()).toBe('receipt.pdf')
})

test('a note with an image downloads as a zip', async ({ page }) => {
  await open(page, 'Weather station build')
  const [download] = await Promise.all([page.waitForEvent('download'), (await noteMore(page, 'Download .md')).click()])
  expect(download.suggestedFilename()).toBe('Weather station build.zip')
  const zip = readFileSync((await download.path())!)
  const text = zip.toString('latin1')
  expect(text).toContain('Weather station build.md')
  expect(text).toContain('_attachments/Weather station build/radiation-shield.png')
  expect(text).toContain('![Radiation shield](_attachments/Weather%20station%20build/radiation-shield.png)')
})

// Final review: one shared anchor meant the second of two quick pastes was stored but never inserted.
test('two pastes in quick succession both land', async ({ page }) => {
  await newNoteWith(page, 'Two pastes', 'Files:\n\n')
  await page.evaluate((pdf) => {
    const file = (name: string) => new File([Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0))], name, { type: 'application/pdf' })
    for (const name of ['one.pdf', 'two.pdf']) {
      const dt = new DataTransfer()
      dt.items.add(file(name))
      document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }
  }, PDF)
  await page.keyboard.press('ControlOrMeta+Home')
  await expect(page.getByRole('link', { name: 'one.pdf, attachment' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'two.pdf, attachment' })).toBeVisible()
})

// Final review: text copied with a picture of it (cells from a spreadsheet) attached the picture and lost the text.
test('pasting text that comes with a picture pastes the text', async ({ page }) => {
  await newNoteWith(page, 'Cells', '')
  await paste(page, { text: 'a\tb', html: '<table><tr><td>a</td><td>b</td></tr></table>', files: [{ name: 'image.png', type: 'image/png', base64: PNG }] })
  await expect(page.locator('#note-body .cm-line').first()).toHaveText('a\tb')
  await expect(page.getByRole('img')).toHaveCount(0)
})
