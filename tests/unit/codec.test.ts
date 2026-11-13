import { describe, expect, test } from 'vitest'
import { fromHex, toHex } from '../../src/core/bytes.ts'
import { open, seal } from '../../src/core/crypto/envelope.ts'
import { itemKey } from '../../src/core/crypto/kdf.ts'
import { CodecError, MAX_META, metaJson, readMeta, type AttachmentMeta, type ItemType } from '../../src/core/sync/codec.ts'
import type { Note } from '../../src/core/library/types.ts'
import { loadVectors } from './vectors.ts'

type Case = {
  name: string
  type: ItemType
  id: string
  meta_plain: Record<string, unknown>
  meta_nonce_prefix: string
  meta_envelope: string
}
const file = loadVectors<Case>('items.json') as ReturnType<typeof loadVectors<Case>> & { master_key: string }
const master = fromHex(file.master_key)
const cases = file.cases
const text = new TextEncoder()
const dec = new TextDecoder()
const caseByName = (n: string) => cases.find((c) => c.name === n)!
const plainOf = (c: Case) => open(fromHex(c.meta_envelope), 'metadata', c.id, itemKey(master, c.id))
const expectedJson = (c: Case) => JSON.stringify(Object.fromEntries(Object.entries(c.meta_plain).sort(([a], [b]) => (a < b ? -1 : 1))))

/** The item a case decodes to, as the plain object metaJson takes back. */
function itemOf(d: ReturnType<typeof readMeta>): Note | AttachmentMeta | Record<string, unknown> {
  if (d.type === 'note') return d.note
  if (d.type === 'notebook') return d.notebook
  if (d.type === 'tag') return d.tag
  return d.attachment
}

describe('items.json', () => {
  test.each(cases)('$name opens to the expected metadata JSON', (c) => {
    expect(dec.decode(plainOf(c))).toBe(expectedJson(c))
  })

  test.each(cases)('$name decodes to the expected fields', (c) => {
    const d = readMeta(c.type, c.id, plainOf(c))
    const m = c.meta_plain
    expect(d.type).toBe(c.type)
    expect(d.metaVersion).toBe(m.v)
    if (d.type === 'note') {
      expect(d.note).toMatchObject({ id: c.id, title: m.title, notebookId: m.notebook_id, tagIds: m.tag_ids, pinned: m.pinned, created: m.created, modified: m.modified, trashedAt: m.trashed_at, body: '' })
    } else if (d.type === 'notebook') {
      expect(d.notebook).toMatchObject({ id: c.id, name: m.name, parentId: m.parent_id, created: m.created, modified: m.modified })
    } else if (d.type === 'tag') {
      expect(d.tag).toMatchObject({ id: c.id, name: m.name, created: m.created, modified: m.modified })
    } else {
      expect(d.attachment).toMatchObject({ id: c.id, filename: m.filename, mime: m.mime, size: m.size, sha256: m.sha256, created: m.created })
    }
  })

  test.each(cases.filter((c) => c.meta_envelope && readMeta(c.type, c.id, plainOf(c)).metaVersion === 1))('$name re-encodes to the same envelope bytes', (c) => {
    const d = readMeta(c.type, c.id, plainOf(c))
    const plain = metaJson(itemOf(d) as Note, c.type, d.extra)
    const sealed = seal(plain, 'metadata', c.id, itemKey(master, c.id), fromHex(c.meta_nonce_prefix))
    expect(toHex(sealed)).toBe(c.meta_envelope)
  })
})

test('unknown fields round-trip', () => {
  const c = caseByName('note_unknown_field')
  const d = readMeta('note', c.id, plainOf(c))
  expect(d.extra).toEqual({ color: 'mint' })
  expect(dec.decode(metaJson(d.type === 'note' ? d.note : ({} as Note), 'note', d.extra))).toContain('"color":"mint"')
})

test('known types have no extra when there are no unknown fields', () => {
  const c = caseByName('tag')
  expect(readMeta('tag', c.id, plainOf(c)).extra).toBeNull()
})

test('v 2 is read-only: it reads with metaVersion 2', () => {
  const c = caseByName('note_future_version')
  const d = readMeta('note', c.id, plainOf(c))
  expect(d.metaVersion).toBe(2)
  expect(d.extra).toEqual({ mood: 'calm' })
})

test('metadata over 64 KiB is refused', () => {
  const note: Note = { id: caseByName('note_in_trash').id, title: 'x'.repeat(70_000), body: '', notebookId: null, tagIds: [], pinned: false, created: 1, modified: 1, trashedAt: null, origin: 'user' }
  expect(() => metaJson(note, 'note', null)).toThrow(CodecError)
  try {
    metaJson(note, 'note', null)
  } catch (e) {
    expect((e as CodecError).kind).toBe('metadataTooLarge')
  }
  expect(() => readMeta('note', note.id, text.encode(JSON.stringify({ v: 1, title: note.title })))).toThrow(CodecError)
  expect(MAX_META).toBe(65_536)
})

test('a JSON boolean is not a number', () => {
  const id = caseByName('tag').id
  const d = readMeta('tag', id, text.encode('{"v":1,"name":"t","created":true,"modified":false}'))
  expect(d.type === 'tag' && d.tag.created).toBe(0)
  expect(d.type === 'tag' && d.tag.modified).toBe(0)
})

test('malformed metadata is refused', () => {
  const id = caseByName('tag').id
  for (const bad of ['not json', '[]', '{"name":"x"}', '{"v":"1"}', '{"v":true}']) {
    try {
      readMeta('tag', id, text.encode(bad))
      expect.unreachable(bad)
    } catch (e) {
      expect((e as CodecError).kind).toBe('malformedMetadata')
    }
  }
})

test('keys are sorted, tag_ids are sorted, no notebook is null, JSON is compact', () => {
  const note: Note = { id: caseByName('note_in_trash').id, title: 'é/😀', body: 'ignored', notebookId: null, tagIds: ['B', 'A', 'C'], pinned: true, created: 5, modified: 6, trashedAt: null, origin: 'user' }
  expect(dec.decode(metaJson(note, 'note', { zeta: { b: 1, a: [2] }, alpha: 1 }))).toBe(
    '{"alpha":1,"created":5,"modified":6,"notebook_id":null,"pinned":true,"tag_ids":["A","B","C"],"title":"é/😀","trashed_at":null,"v":1,"zeta":{"a":[2],"b":1}}',
  )
})

test('known fields win over extra of the same name', () => {
  const tag = { id: caseByName('tag').id, name: 'n', created: 1, modified: 2, origin: 'user' as const }
  expect(dec.decode(metaJson(tag, 'tag', { name: 'other', v: 9 }))).toBe('{"created":1,"modified":2,"name":"n","v":1}')
})
