// The roadmap's speed bars for the editor (Phase 19 exit criteria), on the production build:
// a 50,000-word note opens in under 300 ms; typing in it, median under 8 ms and p99 under 16 ms.
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { bigNote } from './support/big-note'
import { newNoteWith } from './support/paste'

const list = (page: Page) => page.getByRole('listbox', { name: 'Notes' })
const open = (page: Page, title: string) => list(page).getByRole('option', { name: new RegExp(`^${title}`) }).click()

// Tagged @speed: scripts/test_all.sh runs these alone, on one worker.
test.describe.configure({ mode: 'serial', timeout: 120_000 })

/** ms from a row's click to the frame after the note is in the editor. */
async function timeOpen(page: Page, title: string): Promise<number> {
  await page.evaluate(() => {
    performance.clearMarks('feather:note-open')
    const w = window as unknown as { __open: Promise<number> }
    w.__open = new Promise((resolve) => {
      let t0 = 0
      document.addEventListener('click', () => (t0 = performance.now()), { capture: true, once: true })
      new PerformanceObserver((list, obs) => {
        if (!list.getEntriesByName('feather:note-open').length) return
        obs.disconnect()
        requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - t0), 0))
      }).observe({ entryTypes: ['mark'] })
    })
  })
  await open(page, title)
  return page.evaluate(() => (window as unknown as { __open: Promise<number> }).__open)
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const p99 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.99) - 1)]!

test('a 50,000-word note opens in under 300 ms', { tag: '@speed' }, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await newNoteWith(page, 'Big note', bigNote())
  const times: number[] = []
  for (let i = 0; i < 5; i++) {
    await open(page, 'Groceries')
    times.push(await timeOpen(page, 'Big note'))
  }
  const shown = times.map((t) => t.toFixed(0)).join(', ')
  test.info().annotations.push({ type: 'open (ms)', description: shown })
  console.log(`SPEED ${test.info().project.name} open 50k words (ms): ${shown}`)
  expect(median(times)).toBeLessThan(300)
})

test('typing in a 50,000-word note: median under 8 ms, p99 under 16 ms', { tag: '@speed' }, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await newNoteWith(page, 'Big note', bigNote())
  // the caret in the middle of the note
  await page.evaluate(() => {
    const content = document.querySelector('#note-body') as HTMLElement & { cmView?: unknown }
    content.focus()
  })
  await page.keyboard.press('ControlOrMeta+Home')
  for (let i = 0; i < 40; i++) await page.keyboard.press('PageDown')
  await page.evaluate(() => {
    const w = window as unknown as { __samples: number[] }
    w.__samples = []
    let t0 = 0
    window.addEventListener('keydown', () => (t0 = performance.now()), { capture: true })
    document.querySelector('#note-body')!.addEventListener('input', () =>
      setTimeout(() => {
        void document.body.offsetHeight // style and layout
        w.__samples.push(performance.now() - t0)
      }, 0),
    )
  })
  for (let i = 0; i < 200; i++) await page.keyboard.type(i % 20 === 19 ? ' ' : 'a', { delay: 0 })
  const samples = await page.evaluate(() => (window as unknown as { __samples: number[] }).__samples)
  const shown = `median ${median(samples).toFixed(2)}, p99 ${p99(samples).toFixed(2)}, n ${samples.length}`
  test.info().annotations.push({ type: 'keystroke (ms)', description: shown })
  console.log(`SPEED ${test.info().project.name} keystroke: ${shown}`)
  expect(samples.length).toBeGreaterThanOrEqual(190)
  expect(median(samples)).toBeLessThan(8)
  expect(p99(samples)).toBeLessThan(16)
})

test('a 2 MB line opens', { tag: '@speed' }, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await newNoteWith(page, 'Long line', 'word **b** _i_ [l](u) '.repeat(Math.ceil(2_000_000 / 22)))
  await open(page, 'Groceries')
  const t = await timeOpen(page, 'Long line')
  test.info().annotations.push({ type: 'open 2 MB line (ms)', description: t.toFixed(0) })
  console.log(`SPEED ${test.info().project.name} open 2 MB line (ms): ${t.toFixed(0)}`)
  expect(t).toBeLessThan(1000)
  await page.getByRole('textbox', { name: 'Note' }).focus()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.type('x')
  await expect(page.locator('#note-body .cm-line').first()).toContainText('xword')
})
