// Lock and unlock against the local Feather Cloud (Phase 20 Task 9's browser list, run in Task 11 once there was a
// log-in screen; plan Review Focus 2 and 3: closing or hiding the tab with unsynced edits, nothing readable after lock).
import type { Page } from '@playwright/test'
import { test, expect } from '../e2e/fixtures'
import { accountMenu, CLOUD, newEmail, PASSWORD, signUp, useCloud, writeNote } from './support/server'

const TITLE = 'Secret plan'
const BODY = 'the treasure is under the oak'

async function lockNow(page: Page, email: string) {
  await accountMenu(page, email).click()
  await page.getByRole('menuitem', { name: 'Lock now' }).click()
  await expect(page.getByRole('heading', { name: 'FeatherMark is locked' })).toBeVisible()
}

async function unlock(page: Page) {
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Unlock' }).click()
}

const row = (page: Page, title: string) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option', { name: new RegExp(`^${title}`) })

/** Hides the tab the way a browser does: visibilityState "hidden", then the event. */
const hide = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    delete (document as unknown as Record<string, unknown>).visibilityState
  })

test('lock leaves nothing readable', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  // every object URL the page makes, to read back after lock
  await context.addInitScript(() => {
    const made: string[] = []
    ;(window as unknown as { __blobs: string[] }).__blobs = made
    const create = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (o: Blob | MediaSource) => {
      const u = create(o)
      made.push(u)
      return u
    }
  })
  const email = newEmail()
  await signUp(page, email)
  await writeNote(page, TITLE, BODY)
  await expect(row(page, TITLE)).toBeVisible()

  await lockNow(page, email)
  const html = await page.evaluate(() => document.documentElement.outerHTML)
  expect(html).not.toContain(TITLE)
  expect(html).not.toContain(BODY)
  // the editor and search are gone
  await expect(page.getByRole('textbox', { name: 'Note' })).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveCount(0)
  await expect(page.getByRole('searchbox')).toHaveCount(0)
  await expect(page.getByRole('listbox', { name: 'Notes' })).toHaveCount(0)
  // every object URL made, every IndexedDB value and every cached response hold neither string
  const stored = await page.evaluate(async () => {
    const out: string[] = []
    for (const u of (window as unknown as { __blobs: string[] }).__blobs) {
      out.push(await fetch(u).then((r) => r.text(), () => ''))
    }
    for (const info of await indexedDB.databases()) {
      const db = await new Promise<IDBDatabase>((ok, fail) => {
        const r = indexedDB.open(info.name!)
        r.onsuccess = () => ok(r.result)
        r.onerror = () => fail(r.error)
      })
      for (const name of db.objectStoreNames) {
        const all = await new Promise<unknown[]>((ok) => {
          const r = db.transaction(name).objectStore(name).getAll()
          r.onsuccess = () => ok(r.result)
        })
        out.push(JSON.stringify(all))
      }
      db.close()
    }
    if ('caches' in self) {
      for (const k of await caches.keys()) {
        const c = await caches.open(k)
        for (const req of await c.keys()) out.push(await (await c.match(req))!.text())
      }
    }
    return out.join('\n')
  })
  expect(stored).not.toContain(TITLE)
  expect(stored).not.toContain(BODY)

  // and unlocking gives it all back
  await unlock(page)
  await expect(row(page, TITLE)).toBeVisible()
})

// final review I2: a dialog open when the tab locks by itself (30 minutes idle) must not come back on the unlock
// screen with a name in it, nor after unlocking
test('a dialog open at an idle lock is closed, not shown on the unlock screen', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  await page.clock.install()
  const email = newEmail()
  await signUp(page, email)
  await writeNote(page, TITLE, BODY)
  const NOTEBOOK = 'Hidden expedition'
  const libraryNav = page.getByRole('navigation', { name: 'Library' })
  await libraryNav.getByRole('button', { name: 'New notebook', exact: true }).click()
  const create = page.getByRole('dialog', { name: 'New notebook' })
  await create.getByRole('textbox', { name: 'Name' }).fill(NOTEBOOK)
  await create.getByRole('button', { name: 'Create', exact: true }).click()
  await libraryNav.getByRole('button', { name: `More for ${NOTEBOOK}`, exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete notebook…' }).click()
  await expect(page.getByRole('dialog', { name: `Delete “${NOTEBOOK}”?` })).toBeVisible()

  await page.clock.fastForward('31:00')
  await expect(page.getByRole('heading', { name: 'FeatherMark is locked' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const html = await page.evaluate(() => document.documentElement.outerHTML)
  expect(html).not.toContain(NOTEBOOK)
  expect(html).not.toContain(TITLE)

  // nor does it come back after unlocking
  await unlock(page)
  await expect(row(page, TITLE)).toBeVisible()
  await expect(libraryNav.getByRole('button', { name: NOTEBOOK, exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('unlock opens without a request to the server', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  // every fetch the page makes, and whether the notes were on screen at that moment
  await context.addInitScript(() => {
    const log: Array<{ path: string; shown: boolean }> = []
    ;(window as unknown as { __fetched: typeof log }).__fetched = log
    const real = window.fetch.bind(window)
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href)
      log.push({ path: url.pathname, shown: document.querySelector('[role="listbox"][aria-label="Notes"] [role="option"]') !== null })
      return real(input, init)
    }
  })
  const email = newEmail()
  await signUp(page, email)
  await writeNote(page, TITLE, BODY)
  await lockNow(page, email)
  const from = await page.evaluate(() => (window as unknown as { __fetched: unknown[] }).__fetched.length)
  // the server is out of reach from here on: unlock decrypts what the tab kept
  const asked: string[] = []
  await context.route(`${CLOUD}/**`, (route) => {
    asked.push(new URL(route.request().url()).pathname)
    return route.abort()
  })
  await unlock(page)
  await expect(row(page, TITLE)).toBeVisible()
  // the notes showed with no answer from the server (any request after unlock is the sync it starts, which failed)
  await row(page, TITLE).click()
  await expect(page.getByRole('textbox', { name: 'Note' })).toContainText(BODY)
  expect(asked.filter((p) => p.startsWith('/v1/auth/'))).toEqual([])
  // nothing was pulled or downloaded before the notes showed: the sync unlock starts comes after
  const fetched = await page.evaluate((n) => (window as unknown as { __fetched: Array<{ path: string; shown: boolean }> }).__fetched.slice(n), from)
  const early = fetched.filter((f) => !f.shown && (f.path.startsWith('/v1/sync/pull') || f.path.startsWith('/v1/blobs/')))
  expect(early).toEqual([])
  // (and the log saw the sync that did start, so it was watching)
  expect(fetched.some((f) => f.path.startsWith('/v1/sync/'))).toBe(true)
})

test('hiding the tab pushes at once', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  await signUp(page, email)
  await writeNote(page, TITLE, BODY)
  await page.getByRole('textbox', { name: 'Note' }).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' and more')
  const pushed = page.waitForRequest((r) => r.url().includes('/v1/sync/push'), { timeout: 1_000 })
  await hide(page)
  // well before the 2 s the tab otherwise waits after a change
  await pushed
})

test('closing with unsynced changes asks first; with everything synced it does not', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  await signUp(page, email)
  await writeNote(page, TITLE, BODY)

  // everything synced (writeNote waited for the push): closes without asking
  await page.waitForTimeout(300)
  const dialogs: string[] = []
  page.on('dialog', (d) => {
    dialogs.push(d.type())
    void d.dismiss()
  })
  await page.close({ runBeforeUnload: true })
  await expect.poll(() => page.isClosed()).toBe(true)
  expect(dialogs).toEqual([])

  // a second tab, signed in, with the server out of reach: an edit can't sync, and closing asks
  const b = await context.newPage()
  await b.goto('/login')
  await b.getByRole('textbox', { name: 'Email' }).fill(email)
  await b.getByLabel('Password').fill(PASSWORD)
  await b.getByRole('button', { name: 'Log in' }).click()
  await expect(accountMenu(b, email)).toBeVisible({ timeout: 15_000 })
  await expect(row(b, TITLE)).toBeVisible({ timeout: 15_000 })
  await context.route(`${CLOUD}/v1/sync/**`, (route) => route.abort())
  await b.keyboard.press('Alt+n')
  await b.getByRole('textbox', { name: 'Title' }).fill('Not synced yet')
  await b.getByRole('textbox', { name: 'Note' }).click()
  await b.keyboard.type('typed offline')
  const asked = new Promise<string>((resolve) =>
    b.once('dialog', (d) => {
      resolve(d.type())
      void d.dismiss()
    }),
  )
  await b.close({ runBeforeUnload: true })
  expect(await asked).toBe('beforeunload')
  expect(b.isClosed()).toBe(false)
  await b.close()
})

test('sign-out removes the kept copy', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  await signUp(page, email)
  await accountMenu(page, email).click()
  await page.getByRole('menuitem', { name: 'Settings…' }).click()
  await page.getByRole('checkbox', { name: 'Keep my notes on this browser' }).check()
  await page.getByRole('button', { name: 'Done' }).click()
  await writeNote(page, TITLE, BODY)
  const kept = () => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))
  await expect.poll(kept).toContain('feathermark')

  await accountMenu(page, email).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByText("This is a demo. Notes here aren't saved.")).toBeVisible()
  await expect.poll(kept).not.toContain('feathermark')
  // and a reload is the demo (the fixture also checks nothing is left in the browser)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'FeatherMark is locked' })).toHaveCount(0)
})

test('the unlock screen shows "Build <id>", and no shortcut acts behind it', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  await signUp(page, email)
  await lockNow(page, email)
  // VITE_FEATHER_BUILD_ID is unset in the test build: "dev"
  await expect(page.getByText('Build dev', { exact: true })).toBeVisible()
  await expect(page.getByText('No account? Try the demo.')).toBeVisible()
  await expect(page.getByText(`Signed in as ${email} ·`)).toBeVisible()
  const acted = await page.evaluate(() =>
    [
      new KeyboardEvent('keydown', { code: 'KeyN', key: 'n', altKey: true, bubbles: true, cancelable: true }),
      new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', ctrlKey: true, bubbles: true, cancelable: true }),
    ].map((e) => (document.dispatchEvent(e), e.defaultPrevented)),
  )
  expect(acted).toEqual([false, false])
  await unlock(page)
  await expect(accountMenu(page, email)).toBeVisible()
  // the shortcuts are back with the notes
  await page.keyboard.press('Alt+n')
  await expect(page.getByRole('textbox', { name: 'Title' })).toBeFocused()
})
