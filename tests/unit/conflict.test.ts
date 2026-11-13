// Ported from ConflictRulesTests.swift (sync-protocol.md "Conflict resolution").
import { expect, test } from 'vitest'
import { conflictTitle, resolveName, resolveNote, resolveParent } from '../../src/core/sync/conflict.ts'
import type { Note } from '../../src/core/library/types.ts'

const t0 = 1_762_696_320_123
const A = '01JC8ZR1AB2CD3EF4GH5JK6MN7'
const B = '01JC8ZS4QW8XY2Z3A4B5C6D7E8'
function note(o: { title?: string; body?: string; tags?: string[]; pinned?: boolean } = {}): Note {
  return { id: '01JC8ZQ6V4N1XG2H3K5M7P9R0T', title: o.title ?? 'Groceries', body: o.body ?? 'milk', notebookId: null, tagIds: o.tags ?? [], pinned: o.pinned ?? false, created: t0, modified: t0, trashedAt: null, origin: 'user' }
}
const both = { localDeleted: false, serverDeleted: false }

test('textDiffersMakesACopy', () => {
  expect(resolveNote(note({ body: 'eggs' }), note(), both)).toEqual({ kind: 'copyLocal' })
  expect(resolveNote(note({ title: 'Shopping' }), note(), both)).toEqual({ kind: 'copyLocal' })
})

test('onlyMetadataDiffersMerges', () => {
  const local = note({ tags: [A], pinned: false })
  const server = { ...note({ tags: [B], pinned: true }), trashedAt: t0 + 1 }
  const r = resolveNote(local, server, both)
  expect(r.kind).toBe('mergeMeta')
  if (r.kind !== 'mergeMeta') return
  expect(r.note.tagIds).toEqual([A, B])
  expect(r.note.pinned).toBe(true)
  expect(r.note.trashedAt).toBe(t0 + 1)
  expect(r.note.body).toBe('milk')
})

test('localEditAgainstTombstoneRepushes', () => {
  expect(resolveNote(note({ body: 'edit' }), note(), { localDeleted: false, serverDeleted: true })).toEqual({ kind: 'repushLocal' })
})

test('localDeleteAgainstServerEditKeepsServer', () => {
  expect(resolveNote(note(), note({ body: 'edit' }), { localDeleted: true, serverDeleted: false })).toEqual({ kind: 'keepServer' })
})

test('conflictTitleFormat', () => {
  // 14:32 in Bucharest on 9 Nov 2026 is 12:32 UTC
  const at = new Date(Date.UTC(2026, 10, 9, 12, 32))
  expect(conflictTitle('Groceries', 'MacBook Air', at, 'Europe/Bucharest')).toBe('Groceries (conflict, MacBook Air, 9 Nov 14:32)')
  const empty = conflictTitle('', 'Mac', at, 'Europe/Bucharest')
  expect(empty).toBe(' (conflict, Mac, 9 Nov 14:32)')
  expect(empty).not.toBe('')
  // 24-hour clock, past midnight
  expect(conflictTitle('x', 'Mac', new Date(Date.UTC(2026, 0, 1, 0, 5)), 'UTC')).toBe('x (conflict, Mac, 1 Jan 00:05)')
})

test('namesServerWins', () => {
  expect(resolveName('Trips', 'Travel')).toEqual({ lost: 'Trips' })
  expect(resolveName('Travel', 'Travel')).toEqual({ lost: null })
})

test('parentCycleGoesToTop', () => {
  // locally A is inside B; the server puts B inside A: applying it to B would make a cycle
  expect(resolveParent(A, B, new Map([[A, B], [B, null]]))).toBeNull()
  expect(resolveParent(A, B, new Map([[A, null], [B, null]]))).toBe(A)
  expect(resolveParent(null, B, new Map([[A, B]]))).toBeNull()
  // a notebook as its own parent
  expect(resolveParent(B, B, new Map())).toBeNull()
})
