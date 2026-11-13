// The sync status lines and Feather Cloud sizes and times, ported from SyncStatusText.swift and CloudFormat.swift
// (ui-copy.md "Sync status lines", "Feather Cloud states"; "this Mac" is "this browser" on the web).
import { describe, expect, test } from 'vitest'
import type { CloudPlan } from '../../src/core/sync/api.ts'
import { cloudAgo, cloudSize, cloudUsage, settingsLine, syncStatusText } from '../../src/model/sync-text.ts'

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)
const MIN = 60_000
const DAY = 86_400_000
const MB = 1_048_576
const GB = 1_073_741_824
const plan = (o: Partial<CloudPlan> = {}): CloudPlan => ({ state: 'active', reason: null, trialEndsAt: null, quotaBytes: GB, usedBytes: 120 * MB, ...o })
const text = (status: Parameters<typeof syncStatusText>[0]['status'], o: { plan?: CloudPlan | null; billingEnabled?: boolean } = {}) =>
  syncStatusText({ status, plan: o.plan ?? null, billingEnabled: o.billingEnabled ?? true, now: NOW })

describe('SyncStatusText', () => {
  test('synced, with how long ago', () => {
    expect(text({ kind: 'idle', lastSynced: NOW - 2 * MIN })).toEqual({ title: 'Synced', detail: '2 min ago', action: null })
    expect(text({ kind: 'idle', lastSynced: null })).toEqual({ title: 'Synced', detail: null, action: null })
  })

  test('syncing counts what it pushes', () => {
    expect(text({ kind: 'syncing', done: 12, total: 40 })).toEqual({ title: 'Syncing… 12 of 40', detail: null, action: null })
  })

  test('loading counts the note bodies', () => {
    expect(text({ kind: 'loading', done: 120, total: 400 })).toEqual({ title: 'Loading notes… 120 of 400', detail: null, action: null })
  })

  test('offline', () => {
    expect(text({ kind: 'offline' })).toEqual({ title: 'Offline', detail: "Changes sync when you're back online.", action: null })
  })

  test("couldn't sync, with the reason and Try again", () => {
    expect(text({ kind: 'error', message: "The server didn't respond." })).toEqual({ title: "Couldn't sync", detail: "The server didn't respond.", action: 'Try again' })
  })

  test('read-only, from the status or the plan', () => {
    const ro = { title: 'Read-only sync', detail: 'Notes still arrive. Changes here stay on this browser.', action: null }
    expect(text({ kind: 'readOnly' })).toEqual(ro)
    expect(text({ kind: 'idle', lastSynced: NOW }, { plan: plan({ state: 'read_only' }) })).toEqual(ro)
  })

  test('storage full', () => {
    expect(text({ kind: 'quotaFull' })).toEqual({ title: 'Storage full', detail: 'New changes stay on this browser.', action: null })
  })

  test('a trial says the days left and the storage used, only where the server bills', () => {
    const trial = plan({ state: 'trial', trialEndsAt: new Date(NOW + 8.5 * DAY).toISOString() })
    expect(text({ kind: 'idle', lastSynced: NOW - 2 * MIN }, { plan: trial })).toEqual({ title: 'Trial: 9 days left', detail: '120 MB of 1 GB · synced 2 min ago', action: null })
    expect(text({ kind: 'idle', lastSynced: null }, { plan: { ...trial, trialEndsAt: new Date(NOW + DAY).toISOString() } }).title).toBe('Trial: 1 day left')
    expect(text({ kind: 'idle', lastSynced: NOW - 2 * MIN }, { plan: trial, billingEnabled: false })).toEqual({ title: 'Synced', detail: '2 min ago', action: null })
  })

  test('the one line in Settings › Sync', () => {
    expect(settingsLine(text({ kind: 'idle', lastSynced: NOW - 2 * MIN }))).toBe('Synced 2 min ago')
    expect(settingsLine(text({ kind: 'syncing', done: 1, total: 2 }))).toBe('Syncing… 1 of 2')
  })
})

describe('CloudFormat', () => {
  test('sizes in MB or GB, one decimal under 10 unless whole', () => {
    expect(cloudSize(120 * MB)).toBe('120 MB')
    expect(cloudSize(GB)).toBe('1 GB')
    expect(cloudSize(2.4 * GB)).toBe('2.4 GB')
    expect(cloudSize(10 * GB)).toBe('10 GB')
    expect(cloudSize(1.5 * MB)).toBe('1.5 MB')
    expect(cloudSize(0)).toBe('0 MB')
    expect(cloudSize(12.6 * GB)).toBe('13 GB')
  })

  test('usage', () => {
    expect(cloudUsage(120 * MB, GB)).toBe('120 MB of 1 GB used')
  })

  test('how long ago', () => {
    expect(cloudAgo(NOW - 30_000, NOW)).toBe('just now')
    expect(cloudAgo(NOW + 5_000, NOW)).toBe('just now')
    expect(cloudAgo(NOW - 2 * MIN, NOW)).toBe('2 min ago')
    expect(cloudAgo(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago')
    expect(cloudAgo(NOW - 30 * 3_600_000, NOW)).toBe('yesterday')
    expect(cloudAgo(Date.UTC(2026, 10, 9, 12), NOW, { timeZone: 'UTC' })).toBe('9 Nov')
  })
})
