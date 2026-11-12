import { expect, test } from 'vitest'
import { isUlid, newUlid, ulidTime } from '../../src/core/ulid.ts'
import { fakeClock } from './support/clock.ts'

test('newUlid makes a valid id that sorts by time', () => {
  const clock = fakeClock()
  const a = newUlid(clock)
  clock.advance(1)
  const b = newUlid(clock)
  expect(isUlid(a) && isUlid(b)).toBe(true)
  expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  expect(ulidTime(a)).toBe(clock() - 1)
  expect(a < b).toBe(true)
})

test('isUlid accepts lowercase and rejects I L O U and a first character above 7', () => {
  const id = newUlid(fakeClock())
  expect(isUlid(id.toLowerCase())).toBe(true)
  for (const bad of ['I', 'L', 'O', 'U']) expect(isUlid(id.slice(0, 25) + bad)).toBe(false)
  expect(isUlid('8' + id.slice(1))).toBe(false)
  expect(isUlid(id.slice(1))).toBe(false)
})
