// Which screen a path shows (web design "The demo": returning users go straight to /login).
import { expect, test } from 'vitest'
import { parseRoute } from '../../src/model/route.ts'

test('with accounts on: /login logs in, /login?create creates an account, anything else is the app', () => {
  expect(parseRoute('/login', '', true)).toBe('login')
  expect(parseRoute('/login/', '', true)).toBe('login')
  expect(parseRoute('/login', '?create', true)).toBe('create')
  expect(parseRoute('/login', '?create=1&x', true)).toBe('create')
  expect(parseRoute('/login', '?other', true)).toBe('login')
  expect(parseRoute('/', '', true)).toBe('app')
  expect(parseRoute('/no/such/page', '?create', true)).toBe('app')
  expect(parseRoute('/loginx', '', true)).toBe('app')
})

test('without accounts every path is the app (the plain demo)', () => {
  expect(parseRoute('/login', '', false)).toBe('app')
  expect(parseRoute('/login', '?create', false)).toBe('app')
})
