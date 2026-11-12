import { readFileSync } from 'node:fs'
import { test, expect } from './fixtures'
import { headersFile, securityHeaders } from '../../scripts/policy.ts'

test('the page is served with the policy', async ({ page }) => {
  const response = await page.goto('/')
  for (const [name, value] of Object.entries(securityHeaders())) {
    expect(response!.headers()[name.toLowerCase()]).toBe(value)
  }
})

test('headers file matches the preview headers', () => {
  expect(readFileSync('dist/_headers', 'utf8')).toBe(headersFile())
})
