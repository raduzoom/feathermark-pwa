// Another device's edit to the note open here (Task 12 fix round 1): the editor shows the new text at once and stays
// editable, and what is typed next goes on top of it, never over it.
import type { Page } from '@playwright/test'
import { test, expect } from '../e2e/fixtures'
import { nodeDevice } from './support/seed'
import { logIn, newEmail, useCloud } from './support/server'

const hide = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    delete (document as unknown as Record<string, unknown>).visibilityState
  })

test("another device's edit to the open note shows at once, editable, and typing goes on top of it", async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  const mac = await nodeDevice(email)
  const id = mac.library.createNote({ title: 'Groceries', body: 'milk' }).id
  await mac.sync()

  await page.setViewportSize({ width: 1440, height: 900 })
  await logIn(page, email)
  await page.getByRole('listbox', { name: 'Notes' }).getByRole('option').filter({ hasText: 'Groceries' }).click()
  const editor = page.getByRole('textbox', { name: 'Note' })
  await expect(editor).toHaveText('milk', { timeout: 15_000 })

  mac.library.updateNote(id, { body: 'milk, bread' })
  await mac.sync()
  await hide(page)
  await expect(editor).toHaveText('milk, bread', { timeout: 15_000 })
  await expect(page.getByText('Loading this note…')).toHaveCount(0)
  await expect(editor).toHaveAttribute('contenteditable', 'true')

  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  const pushed = page.waitForResponse((r) => r.url().includes('/v1/sync/push') && r.ok(), { timeout: 15_000 })
  await page.keyboard.type(', eggs')
  await pushed
  await mac.sync()
  expect(mac.library.note(id)?.body).toBe('milk, bread, eggs')
})

test("another device's edit landing during an IME composition: the composed text survives, and so does theirs", async ({ page, context, leaks, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP composition is Chromium-only; WebKit is checked by hand')
  await useCloud(context, leaks)
  const email = newEmail()
  const mac = await nodeDevice(email)
  const id = mac.library.createNote({ title: 'Groceries', body: 'milk' }).id
  await mac.sync()

  await page.setViewportSize({ width: 1440, height: 900 })
  await logIn(page, email)
  await page.getByRole('listbox', { name: 'Notes' }).getByRole('option').filter({ hasText: 'Groceries' }).click()
  const editor = page.getByRole('textbox', { name: 'Note' })
  await expect(editor).toHaveText('milk', { timeout: 15_000 })
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')

  // composing, not committed yet
  const cdp = await context.newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 })
  // the Mac's edit lands meanwhile
  mac.library.updateNote(id, { body: 'milk, bread' })
  await mac.sync()
  const pulled = page.waitForResponse((r) => r.url().includes('/v1/sync/pull') && r.ok(), { timeout: 15_000 })
  await hide(page)
  await pulled
  await page.waitForTimeout(500)
  // the composition ends
  await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 })
  await cdp.send('Input.insertText', { text: '日本' })

  // both texts reach the server: the Mac's on the note, the one composed here in a conflict copy
  await expect
    .poll(
      async () => {
        await mac.sync()
        const bodies = mac.library.notes({ kind: 'all' }).map((s) => mac.library.note(s.id)!.body)
        return { groceries: mac.library.note(id)?.body, composed: bodies.some((b) => b.includes('milk日本')) }
      },
      { timeout: 20_000, intervals: [1_000] },
    )
    .toEqual({ groceries: 'milk, bread', composed: true })
  await expect(editor).toHaveText('milk, bread')
})

// final review (deferred T12 minor): the editor holds its saves while a composition is open over another device's
// text; if the composition's end is never seen, typing after it must still be saved, not held for good
test('a composition whose end is never seen does not leave later typing unsaved', async ({ page, context, leaks, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP composition is Chromium-only')
  await useCloud(context, leaks)
  const email = newEmail()
  const mac = await nodeDevice(email)
  const id = mac.library.createNote({ title: 'Groceries', body: 'milk' }).id
  await mac.sync()

  await page.setViewportSize({ width: 1440, height: 900 })
  await logIn(page, email)
  await page.getByRole('listbox', { name: 'Notes' }).getByRole('option').filter({ hasText: 'Groceries' }).click()
  const editor = page.getByRole('textbox', { name: 'Note' })
  await expect(editor).toHaveText('milk', { timeout: 15_000 })
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')

  const cdp = await context.newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 })
  mac.library.updateNote(id, { body: 'milk, bread' })
  await mac.sync()
  const pulled = page.waitForResponse((r) => r.url().includes('/v1/sync/pull') && r.ok(), { timeout: 15_000 })
  await hide(page)
  await pulled
  await page.waitForTimeout(500)
  // the composition ends, but its compositionend never reaches the page (as some IMEs and engines do)
  await page.evaluate(() => window.addEventListener('compositionend', (e) => e.stopImmediatePropagation(), true))
  await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 })
  await cdp.send('Input.insertText', { text: '日本' })
  // then plain typing
  await page.keyboard.type(' tea')

  // every character typed here reaches the server: in the note or in a conflict copy
  await expect
    .poll(
      async () => {
        await hide(page)
        await mac.sync()
        return mac.library.notes({ kind: 'all' }).map((s) => mac.library.note(s.id)!.body).some((b) => b.includes('日本') && b.includes('tea'))
      },
      { timeout: 20_000, intervals: [1_000] },
    )
    .toBe(true)
  expect(mac.library.note(id)?.body.startsWith('milk, bread')).toBe(true)
})
