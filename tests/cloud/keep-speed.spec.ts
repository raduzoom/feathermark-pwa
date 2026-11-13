// "Keep my notes on this browser" at steady state (Phase 20 Task 10, fix round 2): with every note body loaded and
// saves running, typing holds the Phase 19 editor bars (median under 8 ms, p99 under 16 ms per keystroke), and no
// save blocks the main thread for over 50 ms. Also how long one save takes after an edit. Tagged @speed:
// scripts/test_all.sh runs it alone, on one worker. Prints SPEED lines.
//
// 200 notes: written when 1,000 never reached steady state (each arriving body stalled the list, fixed in Task 12;
// loading 1,000 is load-speed.spec.ts). What is measured here is Keep's own cost, which needs every body in.
import type { Page } from '@playwright/test'
import { test, expect } from '../e2e/fixtures'
import { paste } from '../e2e/support/paste'
import { seedAccount } from './support/seed'
import { accountMenu, logIn, newEmail, useCloud } from './support/server'

test.describe.configure({ mode: 'serial', timeout: 600_000 })

const NOTES = 200
const FILES = 4
const FILE_BYTES = 1_000_000

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const p99 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.99) - 1)]!

type Span = { start: number; end: number }
/** Every kept-copy save so far (performance.measure 'feather:kept-save', which records no text). */
const saves = (page: Page) =>
  page.evaluate(() => performance.getEntriesByName('feather:kept-save').map((e) => ({ start: e.startTime, end: e.startTime + e.duration })))

const hide = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    delete (document as unknown as Record<string, unknown>).visibilityState
  })

/** Starts watching the main thread: every gap over 50 ms between turns of a 0 ms timer loop, and (where the engine
 *  reports them) every long task. */
const watchMainThread = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __blocked: Array<{ start: number; end: number }> }
    w.__blocked = []
    let last = performance.now()
    const tick = () => {
      const now = performance.now()
      if (now - last > 50) w.__blocked.push({ start: last, end: now })
      last = now
      setTimeout(tick, 0)
    }
    setTimeout(tick, 0)
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__blocked.push({ start: e.startTime, end: e.startTime + e.duration })
      }).observe({ type: 'longtask', buffered: false })
    } catch {
      // WebKit reports no long tasks: the timer loop covers it
    }
  })

/** Types 8 bursts of 26 keys in the open note, hiding the tab before each (a kept save at once); returns each
 *  keystroke's ms from keydown to style and layout after the editor's input. */
async function typeInBursts(page: Page): Promise<number[]> {
  await page.evaluate(() => {
    const w = window as unknown as { __samples: number[]; __watching?: boolean }
    w.__samples = []
    if (w.__watching) return
    w.__watching = true
    let t0 = 0
    window.addEventListener('keydown', () => (t0 = performance.now()), { capture: true })
    document.addEventListener(
      'input',
      () =>
        setTimeout(() => {
          void document.body.offsetHeight // style and layout
          w.__samples.push(performance.now() - t0)
        }, 0),
      { capture: true },
    )
  })
  for (let burst = 0; burst < 8; burst++) {
    await page.keyboard.type('x')
    await hide(page)
    for (let i = 0; i < 25; i++) await page.keyboard.type(i % 8 === 7 ? ' ' : 'a', { delay: 0 })
  }
  // every key landed in the note (none lost to a save or a redraw)
  const burst = 'x' + Array.from({ length: 25 }, (_, i) => (i % 8 === 7 ? ' ' : 'a')).join('')
  await expect.poll(async () => ((await page.getByRole('textbox', { name: 'Note' }).textContent()) ?? '').split(burst).length - 1).toBe(8)
  // the last samples are taken in a timer after their input: let them in (a save may hold the thread a moment)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __samples: number[] }).__samples.length)).toBeGreaterThanOrEqual(208)
  return page.evaluate(() => (window as unknown as { __samples: number[] }).__samples)
}

test(`${NOTES} notes kept, every body in: typing while saves run holds the editor bars`, { tag: '@speed' }, async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  leaks.allowKeptVault()
  const email = newEmail()
  await seedAccount(email, { notes: NOTES - 1, files: 0, fileBytes: 0 })

  await page.setViewportSize({ width: 1440, height: 900 })
  await logIn(page, email)
  const rows = page.getByRole('listbox', { name: 'Notes' })
  await expect(rows.getByRole('option')).toHaveCount(NOTES - 1, { timeout: 120_000 })
  // steady state: the body loader has every body (it marks 'feather:bodies-loaded', which records no text)
  await expect
    .poll(() => page.evaluate(() => performance.getEntriesByName('feather:bodies-loaded').length), { timeout: 300_000, intervals: [1_000] })
    .toBeGreaterThan(0)

  // the photos, added here, so their content is in the library whole (another device's load only when shown)
  await page.getByRole('button', { name: /^Account, / }).focus()
  await page.keyboard.press('Alt+n')
  await page.keyboard.type('Photos')
  await page.keyboard.press('Enter')
  const files = Array.from({ length: FILES }, (_, i) => ({ name: `photo-${i}.png`, type: 'image/png', base64: Buffer.alloc(FILE_BYTES, i + 1).toString('base64') }))
  await paste(page, { files })
  for (const f of files) await expect(page.locator('#note-body')).toContainText(f.name, { timeout: 30_000 })

  // Keep on: the first save seals everything
  await accountMenu(page, email).click()
  await page.getByRole('menuitem', { name: 'Settings…' }).click()
  await page.getByRole('checkbox', { name: 'Keep my notes on this browser' }).check()
  await page.getByRole('button', { name: 'Done' }).click()
  await hide(page)
  await expect.poll(() => saves(page).then((s) => s.length), { timeout: 120_000 }).toBeGreaterThanOrEqual(1)
  const first = (await saves(page))[0]!

  // one edit in a seeded note, then one save
  await rows.getByRole('option', { name: /^Note 0100/ }).click()
  await expect(page.getByRole('textbox', { name: 'Note' })).toContainText('100 the quick', { timeout: 30_000 })
  await page.getByRole('textbox', { name: 'Note' }).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' edited')
  let before = (await saves(page)).length
  await hide(page)
  await expect.poll(() => saves(page).then((s) => s.length), { timeout: 60_000 }).toBeGreaterThan(before)
  const afterEdit = (await saves(page)).at(-1)!

  // The server out of reach from here: a pass then fails at once, so what runs on the main thread is typing and saving
  await context.route('http://localhost:8420/**', (route) => route.abort())

  // 1. Saves alone, the main thread watched: a key, then quiet (no typing, no test script in the page) while the pass
  // 2 s later fails and saves. A block over 50 ms during one of these saves is the save's.
  await watchMainThread(page)
  before = (await saves(page)).length
  for (let i = 0; i < 5; i++) {
    await page.keyboard.type('y')
    await page.waitForTimeout(3_000)
  }
  const quiet: Span[] = (await saves(page)).slice(before)
  const blocked: Span[] = await page.evaluate(() => (window as unknown as { __blocked: Span[] }).__blocked)
  const inSaves = blocked.filter((b) => quiet.some((s) => b.start < s.end && b.end > s.start))

  // 2. Typing in bursts, a save started before each burst (hiding the tab saves at once)
  before = (await saves(page)).length
  const samples = await typeInBursts(page)
  // every burst hid the tab, which starts a save: wait for them, not just the first (a fast run ends typing first)
  await expect.poll(() => saves(page).then((s) => s.length), { timeout: 60_000 }).toBeGreaterThanOrEqual(before + 4)
  const during: Span[] = (await saves(page)).slice(before)

  const name = test.info().project.name
  const ms = (xs: number[]) => xs.map((x) => x.toFixed(0)).join(', ')
  console.log(`SPEED ${name} kept save, ${NOTES} notes + ${FILES} × ${FILE_BYTES / 1e6} MB: first after turning Keep on ${(first.end - first.start).toFixed(0)} ms; after one edit ${(afterEdit.end - afterEdit.start).toFixed(0)} ms`)
  console.log(`SPEED ${name} kept saves alone (ms): ${ms(quiet.map((s) => s.end - s.start))}; main thread blocked over 50 ms during them: ${inSaves.length ? ms(inSaves.map((b) => b.end - b.start)) : 'never'} (${blocked.length} block(s) in all)`)
  console.log(`SPEED ${name} kept saves while typing (ms): ${ms(during.map((s) => s.end - s.start))}`)
  console.log(`SPEED ${name} keystroke while saving: median ${median(samples).toFixed(2)}, p99 ${p99(samples).toFixed(2)}, n ${samples.length}`)
  expect(quiet.length).toBeGreaterThanOrEqual(4)
  expect(during.length).toBeGreaterThanOrEqual(4)
  expect(samples.length).toBeGreaterThanOrEqual(190)
  expect(median(samples)).toBeLessThan(8)
  expect(p99(samples)).toBeLessThan(16)
  expect(inSaves).toEqual([])
})
