import { writeFileSync } from 'node:fs'
import { test, expect } from './fixtures'

type Row = { file: string; where: string; passed: number; failed: number; failures: string[] }

// The page (spike/vectors.html, spike builds only) runs every crypto vector file in a worker: the pure functions in a
// test worker, and the account chain through the app's crypto worker and its client (createCryptoClient).
test('every crypto vector passes in a worker, under the policy', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  await page.goto('/spike/vectors.html')
  await page.getByRole('button', { name: 'Run vectors' }).click()
  await expect(page.locator('#summary')).toHaveAttribute('data-done', 'true', { timeout: 100_000 })
  const rows: Row[] = JSON.parse((await page.locator('#report').textContent()) ?? '[]')
  writeFileSync(testInfo.outputPath('crypto-vectors.json'), JSON.stringify({ engine: testInfo.project.name, rows }))
  expect(rows.map((r) => `${r.where} ${r.file}`).sort()).toEqual(
    [
      'functions derive.json',
      'functions envelope.json',
      'functions recovery.json',
      'functions wrap.json',
      'crypto worker argon2id.json',
      'crypto worker envelope.json',
      'crypto worker recovery.json',
      'crypto worker wrap.json',
    ].sort(),
  )
  for (const r of rows) {
    expect(r.failures, `${r.where} ${r.file}`).toEqual([])
    expect(r.failed).toBe(0)
    expect(r.passed).toBeGreaterThan(0)
  }
})

// The app's crypto worker: a second session from logging in opens what the first sealed, and the master key
// never reaches the page.
test('signing up then logging in gives the same master key', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/spike/vectors.html')
  await page.getByRole('button', { name: 'Sign up then log in' }).click()
  await expect(page.locator('#account')).toHaveAttribute('data-done', 'true', { timeout: 50_000 })
  const result = JSON.parse((await page.locator('#account-report').textContent()) ?? '{}')
  expect(result).toEqual({
    opened: ['a note title', 'a note body'],
    recoveryOpened: ['a note title', 'a note body'],
    newPasswordOpened: ['a note title', 'a note body'],
    wrongPassword: 'authentication',
    typo: 'typo',
    afterForget: 'rejected',
    keyBytesSeen: false,
  })
})
