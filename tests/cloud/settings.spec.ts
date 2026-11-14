// Settings › Sync, the status line, the demo-notes offer, download everything and loading notes (Phase 20 Task 12),
// against the local Feather Cloud.
import type { Page } from '@playwright/test'
import { test, expect } from '../e2e/fixtures'
import { openTags } from '../e2e/support/tags'
import { noteMore } from '../e2e/support/note-more'
import { sha256Hex } from '../../src/core/library/attachments.ts'
import { RADIATION_SHIELD_PNG_BASE64 } from '../../src/core/library/sample-image.ts'
import { nodeDevice } from './support/seed'
import { accountMenu, CLOUD, logIn, newEmail, PASSWORD, signUp, useCloud, writeNote } from './support/server'

const libraryNav = (page: Page) => page.getByRole('navigation', { name: 'Library' })
const rows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')

async function openSettings(page: Page, email: string) {
  await accountMenu(page, email).click()
  await page.getByRole('menuitem', { name: 'Settings…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  return dialog
}

const hide = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    delete (document as unknown as Record<string, unknown>).visibilityState
  })

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
})

test('the status line, and devices: this browser, and "Sign out" for another', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  await signUp(page, email)
  await expect(page.getByText(/^Synced/).first()).toBeVisible({ timeout: 15_000 })

  const other = await leaks.newContext()
  await useCloud(other, leaks)
  const b = await other.newPage()
  await b.setViewportSize({ width: 1440, height: 900 })
  await logIn(b, email)

  const dialog = await openSettings(page, email)
  await expect(dialog.getByText(email, { exact: true })).toBeVisible()
  await expect(dialog.getByText(/^Synced/)).toBeVisible()
  const devices = dialog.getByRole('list', { name: 'Devices' }).getByRole('listitem')
  await expect(devices).toHaveCount(2)
  // "<browser> on <system>", as this browser named itself when it signed in (both contexts are the same browser)
  const here = dialog.getByText(/^(Chrome|Safari|Firefox|Edge) on (macOS|Windows|Linux|iOS|iPadOS|Android|ChromeOS) \(this browser\)$/)
  await expect(here).toBeVisible()
  const name = (await here.textContent())!.replace(' (this browser)', '')
  const another = devices.filter({ hasNot: page.getByText('(this browser)') })
  await expect(another.getByText(/^Last synced /)).toBeVisible()
  await another.getByRole('button', { name: `Sign out ${name}` }).click()
  const ask = page.getByRole('dialog', { name: `Sign out ${name}?` })
  await expect(ask.getByText('It stops syncing and keeps its notes. It can sign in again with your password.')).toBeVisible()
  await ask.getByRole('button', { name: `Sign out ${name}` }).click()
  await expect(devices).toHaveCount(1)

  // the other device's next sync is refused: it locks, asking to sign in again
  await hide(b)
  await expect(b.getByRole('heading', { name: `Sign in again as ${email}` })).toBeVisible({ timeout: 15_000 })
})

test('sync conflicts list a rename that lost, and Show opens it', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  const mac = await nodeDevice(email)
  const nb = mac.library.createNotebook('Trips', null)
  await mac.sync()
  await logIn(page, email)
  await expect(libraryNav(page).getByRole('button', { name: 'Trips', exact: true })).toBeVisible({ timeout: 15_000 })

  // offline here: the rename waits; meanwhile the Mac renames it too, and gets there first
  const offline = (route: { abort: () => Promise<void> }) => route.abort()
  await context.route(`${CLOUD}/**`, offline)
  await libraryNav(page).getByRole('button', { name: 'More for Trips', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  const rename = page.getByRole('dialog', { name: 'Rename notebook' })
  await rename.getByRole('textbox', { name: 'Name' }).fill('Journeys')
  await rename.getByRole('button', { name: 'Rename', exact: true }).click()
  mac.library.renameNotebook(nb.id, 'Travel')
  await mac.sync()
  await context.unroute(`${CLOUD}/**`, offline)
  await hide(page)
  await expect(libraryNav(page).getByRole('button', { name: 'Travel', exact: true })).toBeVisible({ timeout: 15_000 })

  const dialog = await openSettings(page, email)
  await expect(dialog.getByText('When two devices change a note at once, Feather keeps both. Nothing is overwritten.')).toBeVisible()
  const conflict = dialog.getByRole('list', { name: 'Sync conflicts' }).getByRole('listitem')
  await expect(conflict).toHaveCount(1)
  await expect(conflict.getByText(/^Journeys \(renamed on \w+ on \w+\)$/)).toBeVisible()
  await conflict.getByRole('button', { name: 'Show Journeys' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Travel', level: 2 })).toBeVisible()
})

test('"Change password…" asks for the current one and keeps this tab signed in', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  await signUp(page, email)
  const next = 'another long passphrase'
  let dialog = await openSettings(page, email)
  await dialog.getByRole('button', { name: 'Change password…' }).click()
  await dialog.getByLabel('Current password').fill('not my password at all')
  await dialog.getByLabel('New password').fill(next)
  await dialog.getByRole('button', { name: 'Change password', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText("That password doesn't match. Forgot it? Sign in with your recovery key instead.", { timeout: 15_000 })
  await dialog.getByLabel('Current password').fill(PASSWORD)
  await dialog.getByRole('button', { name: 'Change password', exact: true }).click()
  await expect(dialog.getByRole('status')).toBeVisible({ timeout: 15_000 })
  await dialog.getByRole('button', { name: 'Done' }).click()

  // still signed in and syncing with the new token
  await writeNote(page, 'After the change', 'still syncing')
  await expect(accountMenu(page, email)).toBeVisible()
  // and the new password unlocks
  await accountMenu(page, email).click()
  await page.getByRole('menuitem', { name: 'Lock now' }).click()
  await page.getByLabel('Password').fill(next)
  await page.getByRole('button', { name: 'Unlock' }).click()
  await expect(accountMenu(page, email)).toBeVisible({ timeout: 15_000 })
  await expect(rows(page).filter({ hasText: 'After the change' })).toHaveCount(1)
  dialog = await openSettings(page, email)
  await expect(dialog.getByText(/\(this browser\)$/)).toBeVisible()
})

test('"Delete account…" asks for the password and returns to the demo', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  await signUp(page, email)
  const dialog = await openSettings(page, email)
  await dialog.getByRole('button', { name: 'Delete account…' }).click()
  await dialog.getByLabel('Password').fill('not my password at all')
  await dialog.getByRole('button', { name: 'Delete account', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText("That password doesn't match. Forgot it? Sign in with your recovery key instead.", { timeout: 15_000 })
  await dialog.getByLabel('Password').fill(PASSWORD)
  await dialog.getByRole('button', { name: 'Delete account', exact: true }).click()
  await expect(page.getByText("This is a demo. Notes here aren't saved.")).toBeVisible({ timeout: 15_000 })
  // gone: logging in again is refused
  await page.getByRole('button', { name: 'Log in' }).click()
  await page.getByRole('textbox', { name: 'Email' }).fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 15_000 })
})

/** In the demo: a note filed in the sample notebook "Personal", and one tagged with the sample tag "ideas". */
async function writeTwoDemoNotes(page: Page) {
  await page.goto('/')
  await libraryNav(page).getByRole('button', { name: 'Personal', exact: true }).click()
  await page.keyboard.press('Alt+n')
  await page.keyboard.type('Filed in a sample')
  await openTags(page)
  await libraryNav(page).getByRole('button', { name: '#ideas', exact: true }).click()
  await page.keyboard.press('Alt+n')
  await page.keyboard.type('Tagged with a sample')
  await expect(rows(page).filter({ hasText: 'Tagged with a sample' })).toHaveCount(1)
}

async function logInFromDemo(page: Page, email: string) {
  // from the demo line, so the page (and the notes written in it) stays
  await page.getByRole('button', { name: 'Log in' }).click()
  await page.getByRole('textbox', { name: 'Email' }).fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(accountMenu(page, email)).toBeVisible({ timeout: 15_000 })
}

test('"Add notes" brings the 2 notes written in the demo: at the root and untagged, never a sample', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  await (await nodeDevice(email)).sync()
  await writeTwoDemoNotes(page)
  await logInFromDemo(page, email)
  const offer = page.getByRole('dialog', { name: 'Add the 2 notes you wrote here to your account?' })
  await expect(offer).toBeVisible()
  const pushed = page.waitForResponse((r) => r.url().includes('/v1/sync/push') && r.ok(), { timeout: 15_000 })
  await offer.getByRole('button', { name: 'Add notes' }).click()
  await expect(offer).toBeHidden()
  await expect(rows(page)).toHaveCount(2)
  await pushed

  // on another device: both, and nothing of the samples
  const other = await leaks.newContext()
  await useCloud(other, leaks)
  const b = await other.newPage()
  await b.setViewportSize({ width: 1440, height: 900 })
  await logIn(b, email)
  await expect(rows(b)).toHaveCount(2, { timeout: 15_000 })
  await expect(rows(b).filter({ hasText: 'Filed in a sample' })).toHaveCount(1)
  await expect(rows(b).filter({ hasText: 'Tagged with a sample' })).toHaveCount(1)
  await expect(libraryNav(b).getByRole('button', { name: 'Personal', exact: true })).toHaveCount(0)
  await openTags(b)
  await expect(libraryNav(b).getByRole('button', { name: '#ideas', exact: true })).toHaveCount(0)
  await rows(b).filter({ hasText: 'Filed in a sample' }).click()
  await expect(b.locator('.crumb')).toHaveText('')
})

test('"Don\'t add" leaves the demo notes out', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  await (await nodeDevice(email)).sync()
  await writeTwoDemoNotes(page)
  await logInFromDemo(page, email)
  const offer = page.getByRole('dialog', { name: 'Add the 2 notes you wrote here to your account?' })
  await offer.getByRole('button', { name: "Don't add" }).click()
  await expect(offer).toBeHidden()
  // a whole pass later (hiding the tab syncs at once), still nothing
  const pulled = page.waitForResponse((r) => r.url().includes('/v1/sync/pull') && r.ok(), { timeout: 15_000 })
  await hide(page)
  await pulled
  await expect(rows(page)).toHaveCount(0)
})

test('the offer comes after the first sync, so a tag the account already has is used, not made twice', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  const mac = await nodeDevice(email)
  mac.library.createTag('work')
  await mac.sync()

  await page.goto('/')
  await libraryNav(page).getByRole('button', { name: 'New tag', exact: true }).click()
  const named = page.getByRole('dialog', { name: 'New tag' })
  await named.getByRole('textbox', { name: 'Name' }).fill('Work')
  await named.getByRole('button', { name: 'Create', exact: true }).click()
  await openTags(page)
  await libraryNav(page).getByRole('button', { name: '#Work', exact: true }).click()
  await page.keyboard.press('Alt+n')
  await page.keyboard.type('Tagged by me')
  await expect(rows(page).filter({ hasText: 'Tagged by me' })).toHaveCount(1)

  // the first pull is held back: no offer until it has come
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  await context.route(`${CLOUD}/v1/sync/pull**`, async (route) => {
    await held
    await route.fallback()
  })
  await logInFromDemo(page, email)
  const offer = page.getByRole('dialog', { name: 'Add the note you wrote here to your account?' })
  await openTags(page)
  await expect(libraryNav(page).getByRole('button', { name: '#work', exact: true })).toHaveCount(0)
  await page.waitForTimeout(500)
  await expect(offer).toHaveCount(0)
  release()
  await expect(offer).toBeVisible({ timeout: 15_000 })
  await offer.getByRole('button', { name: 'Add notes' }).click()
  await expect(rows(page)).toHaveCount(1)
  // one tag, the account's
  await expect(libraryNav(page).getByRole('button', { name: /^#work$/i })).toHaveCount(1)
  await expect(libraryNav(page).getByRole('button', { name: '#work', exact: true })).toBeVisible()
})

test("the offline banner (Keep off): shows while offline, goes when the connection is back; not with Keep on", async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  leaks.allowKeptVault()
  const email = newEmail()
  await signUp(page, email)
  const banner = page.getByText("You're offline. Changes are only in this tab until the connection is back.")
  await expect(banner).toHaveCount(0)

  await context.setOffline(true)
  try {
    await hide(page)
    await expect(banner).toBeVisible({ timeout: 15_000 })
  } finally {
    await context.setOffline(false)
  }
  await expect(banner).toBeHidden({ timeout: 15_000 })

  // with Keep on, the notes are kept on this browser: no banner
  const dialog = await openSettings(page, email)
  await dialog.getByRole('checkbox', { name: 'Keep my notes on this browser' }).check()
  await expect(dialog.getByRole('checkbox', { name: 'Keep my notes on this browser' })).toBeChecked()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await context.setOffline(true)
  try {
    await hide(page)
    await expect(page.getByText('Offline', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(banner).toHaveCount(0)
  } finally {
    await context.setOffline(false)
  }
})

test('a note whose body has not arrived says "Loading this note…" and is read-only until it does; pictures from another device appear', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  const mac = await nodeDevice(email)
  const png = Uint8Array.from(Buffer.from(RADIATION_SHIELD_PNG_BASE64, 'base64'))
  const shield = mac.library.addAttachment({ bytes: png, filename: 'shield.png', mime: 'image/png', sha256: await sha256Hex(png) })
  mac.library.createNote({ title: 'From the Mac', body: `written on the Mac\n\n![Shield](feather://attachment/${shield.id})\n` })
  await mac.sync()

  // the bodies wait until the test lets them through
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  await context.route(`${CLOUD}/v1/blobs/**`, async (route) => {
    await held
    await route.fallback()
  })
  await logIn(page, email)
  await rows(page).filter({ hasText: 'From the Mac' }).click()
  await expect(page.getByText('Loading this note…')).toBeVisible()
  const editor = page.getByRole('textbox', { name: 'Note' })
  await expect(editor).toHaveAttribute('contenteditable', 'false')
  await editor.click()
  await page.keyboard.type('typed over the placeholder')
  await expect(editor).not.toContainText('typed over')
  // nor saved as an empty file
  // the menu item is disabled: neither a click nor Enter downloads, and the menu stays open
  const downloads: string[] = []
  page.on('download', (d) => downloads.push(d.suggestedFilename()))
  const downloadMd = await noteMore(page, 'Download .md')
  await expect(downloadMd).toHaveAttribute('aria-disabled', 'true')
  await downloadMd.click()
  await downloadMd.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu', { name: 'More' })).toBeVisible()
  expect(downloads).toEqual([])
  await page.keyboard.press('Escape')

  release()
  await expect(page.getByText('Loading this note…')).toBeHidden({ timeout: 15_000 })
  await expect(editor).toContainText('written on the Mac')
  await expect(editor).toHaveAttribute('contenteditable', 'true')
  await expect(await noteMore(page, 'Download .md')).not.toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('img', { name: 'Shield' })).toBeVisible({ timeout: 15_000 })
})

test('"Download all notes (.zip)" saves the library as a zip', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  await signUp(page, email)
  await writeNote(page, 'Groceries', 'milk')
  const dialog = await openSettings(page, email)
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download all notes (.zip)' }).click()])
  expect(download.suggestedFilename()).toBe('FeatherMark Export.zip')
  const bytes = await (async () => {
    const chunks: Buffer[] = []
    for await (const c of (await download.createReadStream())!) chunks.push(c as Buffer)
    return Buffer.concat(chunks)
  })()
  expect(bytes.includes(Buffer.from('FeatherMark Export/Groceries.md'))).toBe(true)
})
