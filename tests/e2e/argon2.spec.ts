import { writeFileSync } from 'node:fs'
import { test, expect } from './fixtures'

const IMPLS = ['hash-wasm', 'argon2id-simd', 'argon2id-nosimd']

test('the diagnosis times a JavaScript loop and Argon2id at four memory sizes', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  await page.goto('/spike/argon2.html')
  await page.locator('#diagnose').click()
  await expect(page.locator('#diagnosis')).toHaveAttribute('data-done', 'true', { timeout: 100_000 })
  const rows = page.locator('#diagnosis-results tr[data-step]')
  await expect(rows).toHaveCount(5)
  const steps = await rows.evaluateAll((trs) => trs.map((tr) => (tr as HTMLElement).dataset.step))
  expect(steps).toEqual(['js-loop', 'argon2id-8MiB', 'argon2id-32MiB', 'argon2id-128MiB', 'argon2id-256MiB'])
  for (const row of await rows.all()) await expect(row).toHaveAttribute('data-ok', 'true')
  const ms = (await rows.locator('.ms').allTextContents()).map(Number)
  writeFileSync(testInfo.outputPath('diagnosis.json'), JSON.stringify({ engine: testInfo.project.name, steps, ms }))
})

test('every Argon2id build reproduces the vectors in a worker, under the policy', async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  await page.goto('/spike/argon2.html')
  await page.locator('#run').click()
  await expect(page.locator('#summary')).toHaveAttribute('data-done', 'true', { timeout: 220_000 })
  const timings: Record<string, number[]> = {}
  for (const impl of IMPLS) {
    const rows = page.locator(`#results tr[data-impl="${impl}"][data-case]`)
    await expect(rows).toHaveCount(3)
    for (const row of await rows.all()) await expect(row).toHaveAttribute('data-match', 'true')
    timings[impl] = (await rows.locator('.ms').allTextContents()).map(Number)
    expect(Math.max(...timings[impl]!)).toBeLessThan(15_000)
  }
  writeFileSync(testInfo.outputPath('argon2-timings.json'), JSON.stringify({ engine: testInfo.project.name, timings }))
})
