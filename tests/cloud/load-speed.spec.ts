// Loading a library of 1,000 notes (web design "Loading a library"; Phase 20 Task 12): the list shows from the
// metadata, the bodies arrive in the background, and the tab stays responsive while they do. Times, from the click on
// "Log in": the list of 1,000, and every body in (the body loader marks 'feather:bodies-loaded', which records no
// text). Keystrokes are timed in a new note while the bodies arrive and again once they are all in; the Phase 19
// editor bars (median under 8 ms, p99 under 16 ms) are asserted for both. Tagged @speed: scripts/test_all.sh
// runs it alone, on one worker. Prints SPEED lines.
import type { Page } from '@playwright/test'
import { test, expect } from '../e2e/fixtures'
import { seedAccount } from './support/seed'
import { accountMenu, newEmail, PASSWORD, useCloud } from './support/server'

test.describe.configure({ mode: 'serial', timeout: 900_000 })

const NOTES = 1000
/** How long every body may take to arrive (FEATHER_LOAD_LIMIT_MS shortens it, to measure a slow build's rate). */
const LIMIT = Number(process.env.FEATHER_LOAD_LIMIT_MS ?? 120_000)

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const p99 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.99) - 1)]!

type Sample = { at: number; ms: number }

/** Times every keystroke from keydown to style and layout after the editor's input; `at` is when it was typed. */
const watchKeys = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __samples: Array<{ at: number; ms: number }> }
    w.__samples = []
    let t0 = 0
    window.addEventListener('keydown', () => (t0 = performance.now()), { capture: true })
    document.addEventListener(
      'input',
      () =>
        setTimeout(() => {
          void document.body.offsetHeight
          w.__samples.push({ at: t0, ms: performance.now() - t0 })
        }, 0),
      { capture: true },
    )
  })

const samples = (page: Page): Promise<Sample[]> => page.evaluate(() => (window as unknown as { __samples: Sample[] }).__samples)
const bodiesLoadedAt = (page: Page): Promise<number | null> =>
  page.evaluate(() => performance.getEntriesByName('feather:bodies-loaded')[0]?.startTime ?? null)

async function typeBurst(page: Page, keys: number): Promise<void> {
  for (let i = 0; i < keys; i++) await page.keyboard.type(i % 8 === 7 ? ' ' : 'a', { delay: 0 })
}

test(`${NOTES} notes: the list, every body, and typing while they arrive`, { tag: '@speed' }, async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  await seedAccount(email, { notes: NOTES, files: 0, fileBytes: 0 })

  let blobs = 0
  page.on('response', (r) => {
    if (r.url().includes('/v1/blobs/') && r.ok()) blobs++
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/login')
  await page.getByRole('textbox', { name: 'Email' }).fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await watchKeys(page)
  const start = await page.evaluate(() => performance.now())
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(accountMenu(page, email)).toBeVisible({ timeout: 30_000 })

  // a note of one's own, typed into while the bodies arrive
  await accountMenu(page, email).focus()
  await page.keyboard.press('Alt+n')
  await page.keyboard.type('Typing')
  await page.keyboard.press('Enter')
  const rows = page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
  await expect(rows).toHaveCount(NOTES + 1, { timeout: LIMIT })
  const listAt = await page.evaluate(() => performance.now())
  const blobsAtList = blobs

  // bursts of typing until every body is in (or the limit)
  const deadline = Date.now() + LIMIT
  while ((await bodiesLoadedAt(page)) === null && Date.now() < deadline) await typeBurst(page, 26)
  const loadedAt = await bodiesLoadedAt(page)
  const now = await page.evaluate(() => performance.now())
  const during = (await samples(page)).filter((s) => loadedAt === null || s.at < loadedAt).map((s) => s.ms)

  // once every body is in
  await page.evaluate(() => ((window as unknown as { __samples: Sample[] }).__samples = []))
  if (loadedAt !== null) for (let i = 0; i < 8; i++) await typeBurst(page, 26)
  const after = (await samples(page)).map((s) => s.ms)

  const name = test.info().project.name
  const s = (ms: number) => (ms / 1000).toFixed(1)
  const stats = (xs: number[]) => (xs.length ? `median ${median(xs).toFixed(2)}, p99 ${p99(xs).toFixed(2)}, n ${xs.length}` : 'n 0')
  console.log(`SPEED ${name} load ${NOTES} notes: list of ${NOTES} after ${s(listAt - start)} s (${blobsAtList} bodies by then)`)
  console.log(
    loadedAt === null
      ? `SPEED ${name} load ${NOTES} notes: bodies NOT all in after ${s(now - start)} s: ${blobs} of ${NOTES} (${(blobs / ((now - start) / 1000)).toFixed(1)}/s)`
      : `SPEED ${name} load ${NOTES} notes: every body in after ${s(loadedAt - start)} s (${(NOTES / ((loadedAt - start) / 1000)).toFixed(1)}/s)`,
  )
  console.log(`SPEED ${name} keystroke while bodies arrive: ${stats(during)}`)
  console.log(`SPEED ${name} keystroke after the load: ${stats(after)}`)
  expect(loadedAt, 'every body arrived').not.toBeNull()
  // the bars hold while the bodies arrive too (before Task 12: p99 about 160 ms in Chromium, 765 ms in WebKit)
  expect(during.length).toBeGreaterThanOrEqual(26)
  expect(median(during)).toBeLessThan(8)
  expect(p99(during)).toBeLessThan(16)
  expect(after.length).toBeGreaterThanOrEqual(190)
  expect(median(after)).toBeLessThan(8)
  expect(p99(after)).toBeLessThan(16)
})
