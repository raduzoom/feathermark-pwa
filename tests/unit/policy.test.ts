import { expect, test } from 'vitest'
import { contentSecurityPolicy, headersFile, securityHeaders } from '../../scripts/policy.ts'

const POLICY = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

test('the policy is exactly the one in the plan', () => {
  expect(contentSecurityPolicy()).toBe(POLICY)
})

test('the cloud origin is the only extra connection', () => {
  expect(contentSecurityPolicy({ cloudOrigin: 'https://zoomitthemes.go.ro' }))
    .toBe(POLICY.replace("connect-src 'self'", "connect-src 'self' https://zoomitthemes.go.ro"))
})

test.each(['http://zoomitthemes.go.ro', 'https://zoomitthemes.go.ro/v1', 'zoomitthemes.go.ro', 'https://*'])(
  'refuses %s', (origin) => {
    expect(() => contentSecurityPolicy({ cloudOrigin: origin })).toThrow('cloudOrigin must be an https origin')
  })

test('the headers file is the same headers, in Pages form', () => {
  const lines = headersFile().trimEnd().split('\n')
  expect(lines[0]).toBe('/*')
  expect(lines.slice(1)).toEqual(Object.entries(securityHeaders()).map(([k, v]) => `  ${k}: ${v}`))
})
