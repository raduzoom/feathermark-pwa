import { expect, test } from 'vitest'
import { frontMatter, noteFileName, noteMarkdown, sanitizeFileName } from '../../src/core/library/export.ts'
import type { Note } from '../../src/core/library/types.ts'

const note = (o: Partial<Note> = {}): Note => ({
  id: '01JC8ZV2VW3XY4ZA5BC6DE7FG8',
  title: 'Groceries',
  body: '- [ ] Milk\n',
  notebookId: null,
  tagIds: [],
  pinned: false,
  created: Date.UTC(2025, 10, 9, 13, 52, 0, 123),
  modified: Date.UTC(2025, 10, 9, 14, 52, 35, 1),
  trashedAt: null,
  origin: 'user',
  ...o,
})

test('front matter matches the data-model example', () => {
  expect(frontMatter(note(), ['shopping', 'home'])).toBe(
    '---\nfeather_id: 01JC8ZV2VW3XY4ZA5BC6DE7FG8\ntitle: Groceries\ncreated: 2025-11-09T13:52:00.123Z\nmodified: 2025-11-09T14:52:35.001Z\ntags: [home, shopping]\npinned: false\n---\n\n',
  )
})

test('front matter quotes what YAML needs', () => {
  const t = (title: string) => frontMatter(note({ title }), []).split('\n')[2]
  expect(t('- list')).toBe('title: "- list"')
  expect(t('a: b')).toBe('title: "a: b"')
  expect(t('yes')).toBe('title: "yes"')
  expect(t('12')).toBe('title: "12"')
  expect(t('trailing ')).toBe('title: "trailing "')
  expect(t('')).toBe('title: ""')
  expect(t('say "hi"\tnow')).toBe('title: "say \\"hi\\"\\tnow"')
  expect(t('1:1 with Mara')).toBe('title: 1:1 with Mara')
  expect(t('Lisbon, spring trip')).toBe('title: Lisbon, spring trip')
})

test('timestamps are UTC with milliseconds', () => {
  expect(frontMatter(note({ created: 0, modified: 5 }), [])).toContain('created: 1970-01-01T00:00:00.000Z\nmodified: 1970-01-01T00:00:00.005Z')
})

test('tags are listed by name order and quoted when needed', () => {
  expect(frontMatter(note(), ['b, c', 'a', 'Note 10', 'note 2'])).toContain('tags: [a, "b, c", note 2, Note 10]')
})

test('the body follows one blank line, byte for byte', () => {
  const body = 'line\r\nCafé\t \n'
  const md = noteMarkdown(note({ body }), [])
  expect(md.endsWith('---\n\n' + body)).toBe(true)
})

test('file names replace forbidden characters, trim, avoid reserved names and cut at 200 bytes', () => {
  expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j')
  expect(sanitizeFileName('  .hidden. ')).toBe('hidden')
  expect(sanitizeFileName('CON')).toBe('CON-')
  expect(sanitizeFileName('lpt1.txt')).toBe('lpt1.txt-')
  expect(sanitizeFileName('')).toBe('Untitled')
  const long = sanitizeFileName('é'.repeat(150))
  expect(new TextEncoder().encode(long).length).toBe(200)
  expect(noteFileName(note({ title: '  ' }))).toBe('Untitled.md')
  expect(noteFileName(note({ title: 'Lisbon: spring' }))).toBe('Lisbon- spring.md')
})
