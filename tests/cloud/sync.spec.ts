// Two devices, one account, syncing both ways through the local Feather Cloud (Phase 20 Task 13). Device A is the
// test's own page; device B is a second browser context from the leak fixture (`leaks.newContext()`), so both are
// watched for leaks. Hiding a tab syncs it at once (`pageHidden`), which is how each side is told to pull.
import { createHash, randomBytes } from 'node:crypto'
import type { BrowserContext, Page } from '@playwright/test'
import { test, expect, type Leaks } from '../e2e/fixtures'
import { paste } from '../e2e/support/paste'
import { deviceName } from '../../src/core/sync/device-name.ts'
import { seedAccount } from './support/seed'
import { accountMenu, logIn, newEmail, PASSWORD, signUp, useCloud, writeNote } from './support/server'

const libraryNav = (page: Page) => page.getByRole('navigation', { name: 'Library' })
const rows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const editor = (page: Page) => page.getByRole('textbox', { name: 'Note' })
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The row of the note titled exactly `title` (a conflict copy's title starts with it too). */
const row = (page: Page, title: string) => rows(page).filter({ hasText: new RegExp(`^${escape(title)}(?! \\(conflict,)`) })
const copies = (page: Page, title: string) => rows(page).filter({ hasText: new RegExp(`^${escape(title)} \\(conflict, `) })
const pushed = (page: Page) => page.waitForResponse((r) => r.url().includes('/v1/sync/push') && r.ok(), { timeout: 15_000 })

const hide = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    delete (document as unknown as Record<string, unknown>).visibilityState
  })

/** Syncs `page` (hiding it) until `check` passes: the other device's change has arrived. */
const pullUntil = (page: Page, check: () => Promise<void>, timeout = 30_000) =>
  expect(async () => {
    await hide(page)
    await check()
  }).toPass({ timeout, intervals: [500, 1_000, 2_000] })

/** Device B: a second browser context, signed in to `email`. */
async function deviceB(leaks: Leaks, email: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await leaks.newContext()
  await useCloud(context, leaks)
  const page = await context.newPage()
  await page.setViewportSize({ width: 1440, height: 900 })
  await logIn(page, email)
  return { context, page }
}

/** The name `page`'s browser gave itself when it signed in ("<browser> on <system>"), as the app works it out. */
const nameOf = (page: Page) =>
  page
    .evaluate(() => {
      const n = navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }>; platform?: string } }
      return { userAgent: n.userAgent, userAgentData: n.userAgentData ? { brands: n.userAgentData.brands, platform: n.userAgentData.platform } : undefined }
    })
    .then(deviceName)

async function openNote(page: Page, r: ReturnType<typeof row>) {
  await r.click()
  await expect(page.getByText('Loading this note…')).toHaveCount(0, { timeout: 15_000 })
}

async function openSettings(page: Page, email: string) {
  await accountMenu(page, email).click()
  await page.getByRole('menuitem', { name: 'Settings…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  return dialog
}

async function nameDialog(page: Page, title: string, name: string, confirm: string) {
  const dialog = page.getByRole('dialog', { name: title })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name)
  await dialog.getByRole('button', { name: confirm, exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

/** Every byte of a download. */
async function downloaded(page: Page, chip: ReturnType<Page['getByRole']>): Promise<Buffer> {
  const [download] = await Promise.all([page.waitForEvent('download'), chip.click()])
  const chunks: Buffer[] = []
  for await (const c of (await download.createReadStream())!) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
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

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
})

test("a note, a notebook, a tag and an attachment made in A appear in B, and B's edits come back to A", async ({ page: a, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  await signUp(a, email)

  // A: a notebook, a note filed in it, a tag on the note, and an attachment in its text
  await libraryNav(a).getByRole('button', { name: 'New notebook', exact: true }).click()
  await nameDialog(a, 'New notebook', 'Garden', 'Create')
  await libraryNav(a).getByRole('button', { name: 'Garden', exact: true }).click()
  await a.keyboard.press('Alt+n')
  await a.keyboard.type('Seeds')
  await a.keyboard.press('Enter')
  await a.keyboard.type('plant in spring')
  await a.keyboard.press('Enter')
  await a.keyboard.press('Enter')
  await paste(a, { files: [{ name: 'packet.pdf', type: 'application/pdf', base64: Buffer.from('%PDF-1.4\n%seeds\n').toString('base64') }] })
  await expect(editor(a)).toContainText('packet.pdf')
  await a.getByRole('toolbar', { name: 'Note' }).getByRole('button', { name: 'Tags' }).click()
  await a.getByRole('menuitem', { name: 'New tag…' }).click()
  await nameDialog(a, 'New tag', 'outdoors', 'Create')
  await expect(libraryNav(a).getByRole('button', { name: '#outdoors', exact: true })).toBeVisible()
  const sent = pushed(a)
  await hide(a)
  await sent

  // B: all of it
  const { page: b } = await deviceB(leaks, email)
  await pullUntil(b, () => expect(row(b, 'Seeds')).toHaveCount(1, { timeout: 2_000 }))
  await expect(libraryNav(b).getByRole('button', { name: 'Garden', exact: true })).toBeVisible()
  await expect(libraryNav(b).getByRole('button', { name: '#outdoors', exact: true })).toBeVisible()
  await libraryNav(b).getByRole('button', { name: 'Garden', exact: true }).click()
  await expect(rows(b)).toHaveCount(1)
  await libraryNav(b).getByRole('button', { name: '#outdoors', exact: true }).click()
  await expect(rows(b)).toHaveCount(1)
  await openNote(b, row(b, 'Seeds'))
  await expect(editor(b)).toContainText('plant in spring')
  await expect(b.getByRole('link', { name: 'packet.pdf, attachment' })).toBeVisible({ timeout: 15_000 })

  // B edits the note and writes one of its own; both come back to A
  await editor(b).click()
  await b.keyboard.press('ControlOrMeta+Home')
  await b.keyboard.press('End')
  await b.keyboard.type(', watered on B')
  // from All notes, so the new note is in no notebook and has no tag
  await libraryNav(b).getByRole('button', { name: 'All notes', exact: true }).click()
  await b.getByRole('button', { name: /^Account, / }).focus()
  await b.keyboard.press('Alt+n')
  await b.keyboard.type('From B')
  await b.keyboard.press('Enter')
  await b.keyboard.type('written on the second device')
  const sentB = pushed(b)
  await hide(b)
  await sentB

  await libraryNav(a).getByRole('button', { name: 'All notes', exact: true }).click()
  await pullUntil(a, async () => {
    await expect(row(a, 'From B')).toHaveCount(1, { timeout: 2_000 })
    await expect(editor(a)).toContainText('plant in spring, watered on B', { timeout: 2_000 })
  })
  await openNote(a, row(a, 'From B'))
  await expect(editor(a)).toHaveText('written on the second device')
  // the attachment, the notebook and the tag are still there on A
  await openNote(a, row(a, 'Seeds'))
  await a.keyboard.press('ControlOrMeta+Home')
  await expect(a.getByRole('link', { name: 'packet.pdf, attachment' })).toBeVisible()
  await libraryNav(a).getByRole('button', { name: '#outdoors', exact: true }).click()
  await expect(rows(a)).toHaveCount(1)
  await libraryNav(a).getByRole('button', { name: 'Garden', exact: true }).click()
  await expect(rows(a)).toHaveCount(1)
})

test('a forced conflict keeps both texts', async ({ page: a, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  await signUp(a, email)
  await writeNote(a, 'Groceries', 'list:')
  const { context: bContext, page: b } = await deviceB(leaks, email)
  await openNote(b, row(b, 'Groceries'))
  await expect(editor(b)).toHaveText('list:')
  const bDevice = await nameOf(b)

  // both offline: A types "apples", B types "pears", into the same note
  await context.setOffline(true)
  await bContext.setOffline(true)
  try {
    await editor(a).click()
    await a.keyboard.press('ControlOrMeta+End')
    await a.keyboard.type(' apples')
    await editor(b).click()
    await b.keyboard.press('ControlOrMeta+End')
    await b.keyboard.type(' pears')
    await a.waitForTimeout(700) // past the 500 ms save

    // A comes online and syncs first
    const sentA = pushed(a)
    await context.setOffline(false)
    await hide(a)
    await sentA
  } finally {
    await context.setOffline(false)
    await bContext.setOffline(false)
  }
  // then B: its text loses the race and is kept as a conflict copy
  await pullUntil(b, () => expect(copies(b, 'Groceries')).toHaveCount(1, { timeout: 2_000 }))
  // and A gets the copy
  await pullUntil(a, () => expect(copies(a, 'Groceries')).toHaveCount(1, { timeout: 2_000 }))

  const title = new RegExp(`^Groceries \\(conflict, ${escape(bDevice)}, \\d{1,2} [A-Z][a-z]{2} \\d{2}:\\d{2}\\)$`)
  for (const page of [a, b]) {
    // a further pass changes nothing: still one copy
    await hide(page)
    await page.waitForTimeout(1_000)
    await expect(rows(page)).toHaveCount(2)
    await expect(copies(page, 'Groceries')).toHaveCount(1)
    await openNote(page, row(page, 'Groceries'))
    await expect(editor(page)).toHaveText('list: apples')
    await openNote(page, copies(page, 'Groceries'))
    await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue(title)
    await expect(editor(page)).toHaveText('list: pears')
  }
})

test("typing while the other device's edit arrives", async ({ page: a, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  await signUp(a, email)
  await writeNote(a, 'Plan', 'first paragraph\n\nsecond paragraph')
  const { page: b } = await deviceB(leaks, email)
  await openNote(b, row(b, 'Plan'))
  await expect(editor(b)).toContainText('second paragraph')

  // B types at the end of the second paragraph, one key at a time; A edits the first meanwhile
  await editor(b).click()
  await b.keyboard.press('ControlOrMeta+End')
  await editor(a).click()
  await a.keyboard.press('ControlOrMeta+Home')
  await a.keyboard.press('End')
  // each key B types appears once in TYPED, and nowhere else in either text
  const TYPED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let typed = 0
  let typedAtPull = -1
  const typing = (async () => {
    for (const c of TYPED) {
      await b.keyboard.type(c)
      typed++
      await b.waitForTimeout(120)
    }
  })()
  const remote = (async () => {
    await a.waitForTimeout(600)
    await a.keyboard.type(' edited on a')
    const sent = pushed(a)
    await hide(a)
    await sent
    // B pulls A's change while it types
    const pulled = b.waitForResponse((r) => r.url().includes('/v1/sync/pull') && r.ok(), { timeout: 15_000 })
    await hide(b)
    await pulled
    typedAtPull = typed
  })()
  await Promise.all([typing, remote])
  // A's change arrived in the middle of the typing
  expect(typedAtPull).toBeGreaterThan(0)
  expect(typedAtPull).toBeLessThan(TYPED.length)
  expect(await b.evaluate(() => document.activeElement?.closest('[role=textbox]')?.getAttribute('aria-label'))).toBe('Note')

  // settle: B pushes what it holds, A pulls it all
  // (B may have pushed it all already, in the pass that pulled A's change: then hiding it pushes nothing)
  await pullUntil(a, async () => {
    await hide(b)
    const texts = await bodies(a)
    expect(texts.join('\n')).toContain(TYPED.at(-1))
  })
  await hide(b)
  await b.waitForTimeout(1_000)

  for (const page of [a, b]) {
    const texts = await bodies(page)
    // A's edit is in the note
    expect(texts[0], `${page === a ? 'A' : 'B'}: the note`).toContain('first paragraph edited on a')
    // every key typed in B is somewhere: in the note or in a conflict copy, each body holding a run of them in order
    const runs = texts.map((t) => [...t].filter((c) => TYPED.includes(c)).join(''))
    for (const r of runs) expect(TYPED, `${page === a ? 'A' : 'B'}: typed keys in order`).toContain(r)
    const seen = new Set(runs.join(''))
    expect([...TYPED].filter((c) => !seen.has(c)), `${page === a ? 'A' : 'B'}: keys lost`).toEqual([])
  }
  const final = await bodies(a)
  expect(final).toEqual(await bodies(b))
  console.log(`typing while the edit arrives (${test.info().project.name}): ${final.length - 1} conflict cop${final.length === 2 ? 'y' : 'ies'}, A's change pulled after ${typedAtPull} of ${TYPED.length} keys`)
})

/** The texts of the note "Plan" and of its conflict copies (the note first, copies by title). */
async function bodies(page: Page): Promise<string[]> {
  const out: string[] = []
  await openNote(page, row(page, 'Plan'))
  out.push((await editor(page).textContent()) ?? '')
  const titles = (await copies(page, 'Plan').allTextContents()).sort()
  for (let i = 0; i < titles.length; i++) {
    const copy = copies(page, 'Plan').nth(i)
    await openNote(page, copy)
    out.push((await editor(page).textContent()) ?? '')
  }
  return [out[0]!, ...out.slice(1).sort()]
}

test('a revoked session keeps unsynced edits and pushes them after signing in again', async ({ page: a, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  await signUp(a, email)
  await writeNote(a, 'Journal', 'day one')
  const { page: b } = await deviceB(leaks, email)

  // A, offline, edits
  await context.setOffline(true)
  try {
    await editor(a).click()
    await a.keyboard.press('ControlOrMeta+End')
    await a.keyboard.type(', written offline')
    await hide(a)
    await expect(a.getByText(/^Offline/).first()).toBeVisible({ timeout: 15_000 })

    // B signs A out from Settings › Sync
    const dialog = await openSettings(b, email)
    const devices = dialog.getByRole('list', { name: 'Devices' }).getByRole('listitem')
    await expect(devices).toHaveCount(2)
    const other = devices.filter({ hasNot: b.getByText('(this browser)') })
    const signOut = other.getByRole('button', { name: /^Sign out / })
    const name = ((await signOut.getAttribute('aria-label')) ?? (await signOut.textContent()) ?? '').replace(/^Sign out /, '')
    await signOut.click()
    await b.getByRole('dialog', { name: `Sign out ${name}?` }).getByRole('button', { name: `Sign out ${name}` }).click()
    await expect(devices).toHaveCount(1)
    await dialog.getByRole('button', { name: 'Done' }).click()
  } finally {
    await context.setOffline(false)
  }

  // A online: refused, it asks to sign in again, and the password brings it back with the edit
  await pullUntil(a, () => expect(a.getByRole('heading', { name: `Sign in again as ${email}` })).toBeVisible({ timeout: 2_000 }))
  await a.getByLabel('Password').fill(PASSWORD)
  await a.getByRole('button', { name: 'Unlock' }).click()
  await expect(accountMenu(a, email)).toBeVisible({ timeout: 15_000 })
  await openNote(a, row(a, 'Journal'))
  await expect(editor(a)).toHaveText('day one, written offline')

  // the edit reaches B
  await openNote(b, row(b, 'Journal'))
  await pullUntil(b, () => expect(editor(b)).toHaveText('day one, written offline', { timeout: 2_000 }), 45_000)
})

test('an attachment survives the round trip byte for byte', async ({ page: a, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  await signUp(a, email)
  // 256 KB of random bytes: every byte value, nothing compressible
  const bytes = randomBytes(256 * 1024)
  await a.getByRole('button', { name: /^Account, / }).focus()
  await a.keyboard.press('Alt+n')
  await a.keyboard.type('Field data')
  await a.keyboard.press('Enter')
  await a.keyboard.type('Readings:')
  await a.keyboard.press('Enter')
  await paste(a, { files: [{ name: 'readings.bin', type: 'application/octet-stream', base64: bytes.toString('base64') }] })
  await expect(editor(a)).toContainText('readings.bin')
  const sent = pushed(a)
  await hide(a)
  await sent

  const { page: b } = await deviceB(leaks, email)
  await openNote(b, row(b, 'Field data'))
  const chip = b.getByRole('link', { name: 'readings.bin, attachment' })
  await expect(chip).toBeVisible({ timeout: 15_000 })
  const got = await downloaded(b, chip)
  expect(got.length).toBe(bytes.length)
  expect(sha256(got)).toBe(sha256(bytes))
})

// Unlock, meaning Argon2id plus opening the kept vault: Keep on with all 1,000 bodies in, reload, then unlock, timed
// from the click on "Unlock" to the list of 1,000 on screen. Three runs per engine. Tagged @speed: scripts/test_all.sh
// runs it alone, on one worker. Prints SPEED lines.
test.describe('speed', () => {
  test.describe.configure({ timeout: 600_000 })
  const NOTES = 1000

  test(`${NOTES} notes: unlock under 2 s`, { tag: '@speed' }, async ({ page, context, leaks }) => {
    await useCloud(context, leaks)
    leaks.allowKeptVault()
    const email = newEmail()
    await seedAccount(email, { notes: NOTES, files: 0, fileBytes: 0 })

    await logIn(page, email)
    await expect(rows(page)).toHaveCount(NOTES, { timeout: 120_000 })
    await expect
      .poll(() => page.evaluate(() => performance.getEntriesByName('feather:bodies-loaded').length), { timeout: 300_000, intervals: [1_000] })
      .toBeGreaterThan(0)
    const dialog = await openSettings(page, email)
    await dialog.getByRole('checkbox', { name: 'Keep my notes on this browser' }).check()
    await expect(dialog.getByRole('checkbox', { name: 'Keep my notes on this browser' })).toBeChecked()
    await dialog.getByRole('button', { name: 'Done' }).click()
    // the copy is sealed when Keep turns on (not with a kept-save mark): wait until it holds every note
    await expect.poll(() => keptItems(page), { timeout: 120_000, intervals: [1_000] })
      .toBeGreaterThanOrEqual(NOTES)

    // unlocking reads the kept copy: no body is downloaded again
    let blobs = 0
    page.on('request', (r) => void (r.url().includes('/v1/blobs/') && blobs++))
    const runs: number[] = []
    for (let run = 0; run < 3; run++) {
      await page.reload()
      await expect(page.getByRole('heading', { name: 'FeatherMark is locked' })).toBeVisible({ timeout: 30_000 })
      await page.getByLabel('Password').fill(PASSWORD)
      // from the click (seen in the page) to the frame with every row in it
      await page.evaluate(() => {
        const w = window as unknown as { __clicked: number }
        addEventListener('click', () => (w.__clicked = performance.now()), { capture: true, once: true })
      })
      await page.getByRole('button', { name: 'Unlock' }).click()
      const shown = await page.waitForFunction(
        (n) => (document.querySelectorAll('[role=listbox][aria-label=Notes] [role=option]').length >= n ? performance.now() : 0),
        NOTES,
        { polling: 'raf', timeout: 60_000 },
      )
      const ms = ((await shown.jsonValue()) as number) - (await page.evaluate(() => (window as unknown as { __clicked: number }).__clicked))
      runs.push(ms)
      await expect(accountMenu(page, email)).toBeVisible()
      // let the pass after unlocking finish before the next reload
      await expect(page.getByText(/^Synced/).first()).toBeVisible({ timeout: 30_000 })
    }

    const name = test.info().project.name
    console.log(`SPEED ${name} unlock ${NOTES} notes, kept (Argon2id + opening the vault, to the list of ${NOTES}): ${runs.map((r) => r.toFixed(0)).join(', ')} ms`)
    console.log(`SPEED ${name} unlock ${NOTES} notes: bodies downloaded after the reloads: ${blobs}`)
    expect(blobs).toBe(0)
    for (const r of runs) expect(r).toBeLessThan(2_000)
  })
})
