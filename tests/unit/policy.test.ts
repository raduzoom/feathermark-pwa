import { expect, test } from 'vitest'
import { cloudOrigin, contentSecurityPolicy, headersFile, securityHeaders } from '../../scripts/policy.ts'

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

test('http://localhost:8420 is allowed, other http origins are not', () => {
  expect(contentSecurityPolicy({ cloudOrigin: 'http://localhost:8420' }))
    .toBe(POLICY.replace("connect-src 'self'", "connect-src 'self' http://localhost:8420"))
  expect(contentSecurityPolicy({ cloudOrigin: 'http://127.0.0.1:8420' })).toContain('http://127.0.0.1:8420')
  for (const o of ['http://example.com', 'http://localhost.evil.com', 'http://192.168.1.5:8420', 'http://localhost:8420/x'])
    expect(() => contentSecurityPolicy({ cloudOrigin: o })).toThrow('cloudOrigin must be')
})

test('cloudOrigin() reads VITE_FEATHER_CLOUD_URL; unset or empty means no accounts', () => {
  expect(cloudOrigin({})).toBeNull()
  expect(cloudOrigin({ VITE_FEATHER_CLOUD_URL: '' })).toBeNull()
  expect(cloudOrigin({ VITE_FEATHER_CLOUD_URL: 'https://zoomitthemes.go.ro' })).toBe('https://zoomitthemes.go.ro')
  expect(cloudOrigin({ VITE_FEATHER_CLOUD_URL: 'http://localhost:8420' })).toBe('http://localhost:8420')
  expect(() => cloudOrigin({ VITE_FEATHER_CLOUD_URL: 'http://example.com' })).toThrow('cloudOrigin must be')
})

test('the headers file carries the cloud origin when given', () => {
  expect(headersFile({ cloudOrigin: 'http://localhost:8420' })).toContain("connect-src 'self' http://localhost:8420;")
})

test('the headers file is the same headers, in Pages form', () => {
  const lines = headersFile().trimEnd().split('\n')
  expect(lines[0]).toBe('/*')
  const n = Object.keys(securityHeaders()).length
  expect(lines.slice(1, 1 + n)).toEqual(Object.entries(securityHeaders()).map(([k, v]) => `  ${k}: ${v}`))
})

test('hashed assets are cached for a year; the page itself keeps Pages’ default (revalidate)', () => {
  const text = headersFile()
  const blocks = text.trimEnd().split(/\n(?=\/)/)
  expect(blocks[0]!.startsWith('/*\n')).toBe(true)
  expect(blocks[0]).not.toContain('Cache-Control')
  expect(blocks[1]).toBe('/assets/*\n  Cache-Control: public, max-age=31536000, immutable')
})
