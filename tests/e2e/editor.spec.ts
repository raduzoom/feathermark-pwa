// The note editor in the app: exact bytes, live preview at the caret, the Mac's commands and shortcuts, paste,
// composition, links, raw mode (specs/editor.md).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { noteMore } from './support/note-more'
import { downloadedBody } from './support/note-text'
import { newNoteWith, paste } from './support/paste'

const list = (page: Page) => page.getByRole('listbox', { name: 'Notes' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note' })
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Note' })
const open = (page: Page, title: string) => list(page).getByRole('option', { name: new RegExp(`^${title}`) }).click()
const firstLine = (page: Page) => page.locator('#note-body .cm-line').first()
const corpusDir = join(process.env.FEATHER_TEST_VECTORS ?? join(import.meta.dirname, '../../../universal/test-vectors'), 'editor/corpus')

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
})

test('opening and closing every corpus note changes no byte', async ({ context }) => {
  // a page and two downloads through the More menu per note: longer than one test's 30 s in WebKit on a busy machine
  test.setTimeout(90_000)
  for (const name of readdirSync(corpusDir).filter((f) => f.endsWith('.md'))) {
    // a page of its own per note: Chromium blocks a page's 11th download, and each note downloads twice
    const page = await context.newPage()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    const text = readFileSync(join(corpusDir, name), 'utf8')
    await newNoteWith(page, name, text)
    expect(await downloadedBody(page), `${name} as pasted`).toBe(text)
    await open(page, 'Groceries')
    await open(page, name)
    await body(page).click()
    expect(await downloadedBody(page), `${name} after opening it again`).toBe(text)
    await page.close()
  }
})

test('markers hide and show with the caret', async ({ page }) => {
  await newNoteWith(page, 'Heading', '')
  await page.keyboard.type('# Title')
  await page.keyboard.press('Enter')
  await page.keyboard.type('next')
  await expect(firstLine(page)).toHaveText('Title')
  await page.keyboard.press('ArrowUp')
  await expect(firstLine(page)).toHaveText('# Title')
})

test('markers hide while the editor is not focused', async ({ page }) => {
  await newNoteWith(page, 'Unfocused', '# Title\n\nsee **bold** here')
  await page.keyboard.press('ControlOrMeta+Home')
  await expect(firstLine(page)).toHaveText('# Title')
  // focus leaves for the list: no caret, so the heading's "# " hides
  await list(page).getByRole('option', { name: /^Unfocused/ }).focus()
  await expect(firstLine(page)).toHaveText('Title')
  // a note opened from the list shows no markers either
  await open(page, 'Groceries')
  await open(page, 'Unfocused')
  await expect(firstLine(page)).toHaveText('Title')
  // focus back: the caret's line shows them again
  await body(page).focus()
  await page.keyboard.press('ControlOrMeta+Home')
  await expect(firstLine(page)).toHaveText('# Title')
})

test('Return continues a list', async ({ page }) => {
  await newNoteWith(page, 'List', '- one')
  await page.keyboard.press('Enter')
  await page.keyboard.type('two')
  expect(await downloadedBody(page)).toBe('- one\n- two')
})

test('undo after a command restores the bytes', async ({ page }) => {
  await newNoteWith(page, 'CRLF list', '- one\r\n- two')
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  expect(await downloadedBody(page)).toBe('- one\r\n- \r\n- two')
  await body(page).focus()
  await page.keyboard.press('ControlOrMeta+z')
  expect(await downloadedBody(page)).toBe('- one\r\n- two')
})

test('the inline shortcuts toggle formats', async ({ page }) => {
  await newNoteWith(page, 'Formats', 'word')
  await page.keyboard.press('Shift+Home')
  await page.keyboard.press('ControlOrMeta+b')
  expect(await downloadedBody(page)).toBe('**word**')
  await body(page).focus()
  await page.keyboard.press('ControlOrMeta+b')
  expect(await downloadedBody(page)).toBe('word')
  await body(page).focus()
  await page.keyboard.press('ControlOrMeta+i')
  expect(await downloadedBody(page)).toBe('*word*')
  await body(page).focus()
  await page.keyboard.press('ControlOrMeta+i')
  await page.keyboard.press('ControlOrMeta+e')
  expect(await downloadedBody(page)).toBe('`word`')
  await body(page).focus()
  await page.keyboard.press('ControlOrMeta+e')
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('e.com')
  await expect(page.getByRole('dialog', { name: 'Quick actions' })).toHaveCount(0)
  expect(await downloadedBody(page)).toBe('[word](e.com)')
  // in the note list, Ctrl/⌘+K opens quick actions
  await open(page, 'Groceries')
  await list(page).getByRole('option', { name: /^Groceries/ }).focus()
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByRole('combobox', { name: 'Search all notes' })).toBeFocused()
})

test('a checkbox toggles on click', async ({ page }) => {
  await open(page, 'Groceries')
  await page.getByRole('checkbox', { name: 'To do' }).first().click()
  expect(await downloadedBody(page)).toBe('- [x] Oat milk\n- [ ] Lemons\n- [x] Rye flour')
})

test('paste keeps plain text and the note’s line endings', async ({ page }) => {
  await newNoteWith(page, 'Pasted', 'a\r\nb')
  await page.keyboard.press('Enter')
  await paste(page, { text: 'x\ny', html: '<b>x</b><br>y' })
  expect(await downloadedBody(page)).toBe('a\r\nb\r\nx\r\ny')
})

test('composition inside bold keeps the text', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP composition is Chromium-only; WebKit is checked by hand')
  await newNoteWith(page, 'IME', '**abc**')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 })
  await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 })
  await cdp.send('Input.insertText', { text: '日本' })
  expect(await downloadedBody(page)).toBe('**ab日本c**')
})

test('clicking a link keeps the demo', async ({ page, leaks }) => {
  leaks.allowForeignRequest(/^https:\/\/example\.com\//)
  await page.context().route('https://example.com/**', (r) => r.fulfill({ body: 'ok', contentType: 'text/plain' }))
  await newNoteWith(page, 'Links', 'see [the site](https://example.com/) here\n\nend')
  await body(page).getByText('the site').click()
  expect(page.url()).toMatch(/^http:\/\/localhost:8431\//)
  await expect(list(page).getByRole('option', { name: /^Links/ })).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+End')
  const [popup] = await Promise.all([page.waitForEvent('popup'), body(page).getByText('the site').click({ modifiers: ['ControlOrMeta'] })])
  await expect.poll(() => popup.url()).toBe('https://example.com/')
  await popup.close()
  await expect(list(page).getByRole('option', { name: /^Links/ })).toHaveCount(1)
})

test('Markdown shows the raw text', async ({ page }) => {
  await newNoteWith(page, 'Raw', '# Title\n\nbody')
  await expect(firstLine(page)).toHaveText('Title')
  const view = toolbar(page).getByRole('group', { name: 'View' })
  const button = view.getByRole('button', { name: 'Markdown' })
  await expect(view.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true')
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(firstLine(page)).toHaveText('# Title')
  // pressing it again keeps Markdown; Preview goes back
  await button.click()
  await expect(firstLine(page)).toHaveText('# Title')
  await view.getByRole('button', { name: 'Preview' }).click()
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await expect(firstLine(page)).toHaveText('Title')
})

test('the Trash shows a read-only editor', async ({ page }) => {
  await open(page, 'Groceries')
  await (await noteMore(page, 'Move to Trash')).click()
  await page.getByRole('navigation', { name: 'Library' }).getByRole('button', { name: 'Trash', exact: true }).click()
  await open(page, 'Groceries')
  await expect(body(page)).toHaveAttribute('aria-readonly', 'true')
  await expect(body(page)).toHaveAttribute('contenteditable', 'false')
})

test('Tab indents a list item, and Escape then Tab leaves the editor', async ({ page }) => {
  await newNoteWith(page, 'Indent', '- one\n- two')
  await page.keyboard.press('Tab')
  expect(await downloadedBody(page)).toBe('- one\n  - two')
  await body(page).focus()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Tab')
  await expect(body(page)).not.toBeFocused()
})

// Final review: a CRLF note became LF when its last line break was removed and brought back.
test('a CRLF note stays CRLF when its only line break is deleted and undone', async ({ page }) => {
  await newNoteWith(page, 'CRLF join', 'a\r\nb')
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Home')
  await page.keyboard.press('Backspace')
  expect(await downloadedBody(page)).toBe('ab')
  await body(page).focus()
  await page.keyboard.press('ControlOrMeta+z')
  expect(await downloadedBody(page)).toBe('a\r\nb')
})

// Final review: no keyboard route to tick a to-do or open a link (the "- [ ] " marker is hidden and atomic).
test('Ctrl/⌘+Enter ticks the to-do on the caret’s line, and opens the link at the caret', async ({ page, leaks }) => {
  await open(page, 'Groceries')
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('ControlOrMeta+Enter')
  expect(await downloadedBody(page)).toBe('- [x] Oat milk\n- [ ] Lemons\n- [x] Rye flour')
  await body(page).focus()
  await page.keyboard.press('ControlOrMeta+z')
  expect(await downloadedBody(page)).toBe('- [ ] Oat milk\n- [ ] Lemons\n- [x] Rye flour')

  leaks.allowForeignRequest(/^https:\/\/example\.com\//)
  await page.context().route('https://example.com/**', (r) => r.fulfill({ body: 'ok', contentType: 'text/plain' }))
  await newNoteWith(page, 'Key link', 'see [the site](https://example.com/) here')
  await page.keyboard.press('Home')
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight')
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.keyboard.press('ControlOrMeta+Enter')])
  await expect.poll(() => popup.url()).toBe('https://example.com/')
  await popup.close()
})
