// Ported from BackoffTests.swift (sync-protocol.md "Errors and retries"). Delays are in milliseconds.
import { expect, test } from 'vitest'
import { Backoff } from '../../src/core/sync/backoff.ts'

test('doublesToFiveMinutes', () => {
  const b = new Backoff()
  const delays = Array.from({ length: 10 }, () => b.next(0.5))
  expect(delays).toEqual([2, 4, 8, 16, 32, 64, 128, 256, 300, 300].map((s) => s * 1000))
})

test('jitterIsTwentyPercent', () => {
  expect(new Backoff().next(0)).toBe(1600)
  expect(new Backoff().next(1)).toBe(2400)
})

test('resetStartsOver', () => {
  const b = new Backoff()
  b.next(0.5)
  b.next(0.5)
  b.reset()
  expect(b.next(0.5)).toBe(2000)
})
