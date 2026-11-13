import { describe, expect, test } from 'vitest'
import { frontMatter, libraryZip, noteFileName, noteMarkdown, sanitizeFileName } from '../../src/core/library/export.ts'
import { Library } from '../../src/core/library/library.ts'
import { fakeClock } from './support/clock.ts'
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

describe('libraryZip: the whole library as a Markdown folder (data-model.md "Export")', () => {
  const clock = fakeClock()
  const bytes = (s: string) => new TextEncoder().encode(s)
  const text = (b: Uint8Array) => new TextDecoder().decode(b)

  function example() {
    const lib = new Library(clock)
    const home = lib.createNotebook('Home', null)
    const recipes = lib.createNotebook('Recipes', home.id)
    lib.createNotebook('Work', null)
    const shopping = lib.createTag('shopping')
    lib.createNote({ title: 'Inbox', body: 'root' })
    clock.advance(1)
    lib.createNote({ title: 'Pasta', body: 'one', notebookId: recipes.id })
    clock.advance(1)
    lib.createNote({ title: 'Pasta', body: 'two', notebookId: recipes.id })
    const jpg = lib.addAttachment({ bytes: bytes('JPG'), filename: 'receipt.jpg', mime: 'image/jpeg', sha256: 'a' })
    const pdf = lib.addAttachment({ bytes: bytes('PDF'), filename: 'list.pdf', mime: 'application/pdf', sha256: 'b' })
    clock.advance(1)
    lib.createNote({
      title: 'Groceries',
      body: `- [ ] Milk\n![](feather://attachment/${jpg.id})\n[list](feather://attachment/${pdf.id})\n\`feather://attachment/${pdf.id}\`\n`,
      notebookId: home.id,
      tagIds: [shopping.id],
    })
    const gone = lib.createNote({ title: 'Old', body: 'trashed' })
    lib.trashNote(gone.id)
    return lib
  }

  test('notebook folders, numbered names, _attachments, empty folders; the Trash left out', () => {
    const entries = libraryZip(example())
    expect(entries.map((e) => e.path)).toEqual([
      'FeatherMark Export/',
      'FeatherMark Export/Home/',
      'FeatherMark Export/Home/Recipes/',
      'FeatherMark Export/Home/Recipes/Pasta.md',
      'FeatherMark Export/Home/Recipes/Pasta (2).md',
      'FeatherMark Export/Home/Groceries.md',
      'FeatherMark Export/Home/_attachments/Groceries/receipt.jpg',
      'FeatherMark Export/Home/_attachments/Groceries/list.pdf',
      'FeatherMark Export/Work/',
      'FeatherMark Export/Inbox.md',
    ])
    const byPath = new Map(entries.map((e) => [e.path, e.bytes]))
    expect(text(byPath.get('FeatherMark Export/Home/Recipes/Pasta.md')!)).toMatch(/\n\none$/)
    expect(text(byPath.get('FeatherMark Export/Home/Recipes/Pasta (2).md')!)).toMatch(/\n\ntwo$/)
    const groceries = text(byPath.get('FeatherMark Export/Home/Groceries.md')!)
    expect(groceries).toContain('tags: [shopping]')
    expect(groceries).toContain('![](_attachments/Groceries/receipt.jpg)\n[list](_attachments/Groceries/list.pdf)\n`feather://attachment/')
    expect(text(byPath.get('FeatherMark Export/Home/_attachments/Groceries/receipt.jpg')!)).toBe('JPG')
    expect([...byPath.keys()].some((p) => p.includes('Old'))).toBe(false)
  })

  test('a notebook folder named like _attachments, or like another, gets a number', () => {
    const lib = new Library(clock)
    lib.createNotebook('_attachments', null)
    lib.createNotebook('a/b', null)
    lib.createNotebook('a-b', null)
    const paths = libraryZip(lib).map((e) => e.path)
    expect(paths[0]).toBe('FeatherMark Export/')
    expect([...paths].sort()).toEqual(['FeatherMark Export/', 'FeatherMark Export/_attachments (2)/', 'FeatherMark Export/a-b (2)/', 'FeatherMark Export/a-b/'])
  })
})
