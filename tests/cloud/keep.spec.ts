// "Keep my notes on this browser" and one owning tab (Phase 20 Task 10; plan Review Focus 5: two tabs and a kept vault),
// against the local Feather Cloud. The kept copy is IndexedDB "feathermark", holding the sealed vault only.
import type { Page } from '@playwright/test'
import { test, expect } from '../e2e/fixtures'
import { accountMenu, CLOUD, logIn, newEmail, PASSWORD, signUp, useCloud, writeNote } from './support/server'

const TITLE = 'Secret plan'
const BODY = 'the treasure is under the oak'
const KEEP = 'Keep my notes on this browser'

const row = (page: Page, title: string) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option', { name: new RegExp(`^${title}`) })

async function openSettings(page: Page, email: string) {
  await accountMenu(page, email).click()
  await page.getByRole('menuitem', { name: 'Settings…' }).click()
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
}

/** Turns Keep on from Settings › Sync. */
async function keepOn(page: Page, email: string) {
  await openSettings(page, email)
  const box = page.getByRole('checkbox', { name: KEEP })
  await expect(box).not.toBeChecked()
  await expect(page.getByText('Your notes stay here, encrypted, so the next visit opens without downloading them. Only your password can unlock them.')).toBeVisible()
  await box.check()
  await expect(box).toBeChecked()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
}

/** How many items the kept copy holds (-1: no "feathermark" database). Reads without creating it. */
const keptItems = (page: Page) =>
  page.evaluate(async () => {
    if (!(await indexedDB.databases()).some((d) => d.name === 'feathermark')) return -1
    const db = await new Promise<IDBDatabase>((ok, fail) => {
      const r = indexedDB.open('feathermark')
      r.onsuccess = () => ok(r.result)
      r.onerror = () => fail(r.error)
    })
    try {
      if (!db.objectStoreNames.contains('items')) return 0
      return await new Promise<number>((ok) => (db.transaction('items').objectStore('items').count().onsuccess = (e) => ok((e.target as IDBRequest<number>).result)))
    } finally {
      db.close()
    }
  })

const databases = (page: Page) => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))

async function unlock(page: Page) {
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Unlock' }).click()
}

test('a kept library opens offline after a reload', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  leaks.allowKeptVault()
  const email = newEmail()
  await signUp(page, email)
  await keepOn(page, email)
  await writeNote(page, TITLE, BODY)
  // saved after the pass that pushed it
  await expect.poll(() => keptItems(page)).toBeGreaterThan(0)

  // the server is out of reach from here on
  const asked: string[] = []
  await context.route(`${CLOUD}/**`, (route) => {
    asked.push(new URL(route.request().url()).pathname)
    return route.abort()
  })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'FeatherMark is locked' })).toBeVisible()
  await expect(page.getByText(`Signed in as ${email} ·`)).toBeVisible()
  // and the network itself (the page's own files are loaded)
  await context.setOffline(true)
  await unlock(page)
  await expect(row(page, TITLE)).toBeVisible()
  await row(page, TITLE).click()
  await expect(page.getByRole('textbox', { name: 'Note' })).toContainText(BODY)
  await context.setOffline(false)
  // unlocked from the kept copy: no log-in
  expect(asked.filter((p) => p.startsWith('/v1/auth/'))).toEqual([])
})

// final review I3 (and the deferred "demo flashes before unlock"): with a kept copy, opening the app never shows the
// demo before the unlock screen, and a log-in at a bookmarked /login never replaces the copy
test('a reload with a kept copy shows the unlock screen without the demo first, also at /login', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  leaks.allowKeptVault()
  const email = newEmail()
  await signUp(page, email)
  await keepOn(page, email)
  await writeNote(page, TITLE, BODY)
  await expect.poll(() => keptItems(page)).toBeGreaterThan(0)
  // from the next page on: note whether the demo (its "Log in" button) is ever in the page
  await context.addInitScript(() => {
    const w = window as unknown as { __demoShown: boolean }
    w.__demoShown = false
    new MutationObserver(() => {
      if ([...document.querySelectorAll('button')].some((b) => b.textContent === 'Log in' || b.textContent === 'Create account')) w.__demoShown = true
    }).observe(document, { childList: true, subtree: true })
  })
  for (const path of ['/', '/login']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: 'FeatherMark is locked' })).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { __demoShown: boolean }).__demoShown), path).toBe(false)
  }
  await unlock(page)
  await expect(row(page, TITLE)).toBeVisible()
})

test("a second tab can't write until it takes over", async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  leaks.allowKeptVault()
  const email = newEmail()
  await signUp(page, email)
  await keepOn(page, email)
  await writeNote(page, TITLE, BODY)
  await expect.poll(() => keptItems(page)).toBeGreaterThan(0)

  // a second tab of the same browser
  const second = await context.newPage()
  await second.goto('/')
  await expect(second.getByRole('heading', { name: 'FeatherMark is open in another tab.' })).toBeVisible()
  await expect(second.getByRole('textbox', { name: 'Note' })).toHaveCount(0)
  await expect(second.getByLabel('Password')).toHaveCount(0)

  await second.getByRole('button', { name: 'Use it here' }).click()
  // the first tab stops writing at once
  await expect(page.getByText('FeatherMark is now open in another tab.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Use it here' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Note' })).not.toBeEditable()
  await expect(page.getByRole('textbox', { name: 'Title' })).not.toBeEditable()
  await page.keyboard.press('Alt+n')
  await expect(page.getByRole('listbox', { name: 'Notes' }).getByRole('option')).toHaveCount(1)

  // the second unlocks the kept copy, and its edit syncs
  await expect(second.getByRole('heading', { name: 'FeatherMark is locked' })).toBeVisible()
  await unlock(second)
  await expect(row(second, TITLE)).toBeVisible()
  await row(second, TITLE).click()
  await second.getByRole('textbox', { name: 'Note' }).click()
  await second.keyboard.press('ControlOrMeta+End')
  const pushed = second.waitForResponse((r) => r.url().includes('/v1/sync/push') && r.ok(), { timeout: 15_000 })
  await second.keyboard.type(', by the river')
  await pushed

  // another device sees it
  const other = await leaks.newContext()
  await useCloud(other, leaks)
  const device = await other.newPage()
  await logIn(device, email)
  await expect(row(device, TITLE)).toBeVisible({ timeout: 15_000 })
  // opened again until the body is there (the editor shows a body that arrives after the note opened from Task 12 on)
  const nav = device.getByRole('navigation', { name: 'Library' })
  await expect(async () => {
    await nav.getByRole('button', { name: 'Trash', exact: true }).click()
    await nav.getByRole('button', { name: /^All notes/ }).click()
    await row(device, TITLE).click()
    await expect(device.getByRole('textbox', { name: 'Note' })).toContainText(`${BODY}, by the river`, { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
})

test('turning Keep off removes the copy', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  await signUp(page, email)
  await keepOn(page, email)
  await writeNote(page, TITLE, BODY)
  await expect.poll(() => keptItems(page)).toBeGreaterThan(0)

  await openSettings(page, email)
  // the box stays ticked until the answer
  await page.getByRole('checkbox', { name: KEEP }).click()
  const ask = page.getByRole('dialog', { name: 'Remove the copy of your notes from this browser?' })
  await expect(ask).toBeVisible()
  await expect(ask.getByText('They stay in your account.')).toBeVisible()
  await ask.getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByRole('checkbox', { name: KEEP })).not.toBeChecked()
  await expect.poll(() => databases(page)).not.toContain('feathermark')
  await page.getByRole('button', { name: 'Done' }).click()
  // the notes stay, in the account; the fixture checks nothing is left in the browser
  await expect(row(page, TITLE)).toBeVisible()
})

/** Hides the tab the way a browser does: visibilityState "hidden", then the event. */
const hide = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    delete (document as unknown as Record<string, unknown>).visibilityState
  })

/** Whether closing the tab now would ask first (the app's beforeunload handler cancels the event). */
const asksOnClose = (page: Page) =>
  page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true })
    dispatchEvent(e)
    return e.defaultPrevented
  })

test('typing just before closing is kept: closing asks until hiding the tab has kept it', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  leaks.allowKeptVault()
  const email = newEmail()
  await signUp(page, email)
  await keepOn(page, email)
  await writeNote(page, TITLE, BODY)
  await expect.poll(() => keptItems(page)).toBeGreaterThan(0)
  // the server out of reach: only the kept copy can hold what is typed now
  await context.route(`${CLOUD}/**`, (route) => route.abort())
  await page.getByRole('textbox', { name: 'Note' }).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(', typed just before closing')
  expect(await asksOnClose(page)).toBe(true)
  await hide(page)
  await expect.poll(() => asksOnClose(page)).toBe(false)
  await page.reload()
  await unlock(page)
  await row(page, TITLE).click()
  await expect(page.getByRole('textbox', { name: 'Note' })).toContainText(`${BODY}, typed just before closing`)
})

test("a tab that lost the library can't sign out; the owner's sign-out leaves no database", async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  await signUp(page, email)
  await keepOn(page, email)
  await writeNote(page, TITLE, BODY)
  await expect.poll(() => keptItems(page)).toBeGreaterThan(0)
  const second = await context.newPage()
  await second.goto('/')
  await second.getByRole('button', { name: 'Use it here' }).click()
  await unlock(second)
  await expect(row(second, TITLE)).toBeVisible()

  await expect(page.getByText('FeatherMark is now open in another tab.')).toBeVisible()
  await accountMenu(page, email).click()
  await expect(page.getByRole('menuitem', { name: 'Lock now' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Settings…' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await accountMenu(second, email).click()
  await second.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(second.getByText("This is a demo. Notes here aren't saved.")).toBeVisible()
  await expect.poll(() => databases(second)).not.toContain('feathermark')
  // the first tab, hidden and then left alone, writes nothing back (the fixture checks storage at the end too)
  await hide(page)
  await page.waitForTimeout(1_000)
  expect(await databases(page)).not.toContain('feathermark')
})
