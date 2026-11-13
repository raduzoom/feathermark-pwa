// A note downloaded with its attachments (data-model.md "Export to a Markdown folder"), ported from
// ExportTests.swift (apple d49c0a6): links rewritten to relative, percent-encoded paths, names numbered.
import { expect, test } from 'vitest'
import { noteDownload } from '../../src/core/library/export.ts'
import { Library } from '../../src/core/library/library.ts'
import { percentEncodePathComponent } from '../../src/core/library/links.ts'
import { fakeClock } from './support/clock.ts'

const bytes = (s: string) => new TextEncoder().encode(s)
const add = (lib: Library, data: string, filename: string, mime = 'application/octet-stream') => lib.addAttachment({ bytes: bytes(data), filename, mime, sha256: '0'.repeat(64) })
const files = (d: ReturnType<typeof noteDownload>) => (d.kind === 'zip' ? d.entries.map((e) => e.path) : [])
const md = (d: ReturnType<typeof noteDownload>) => {
  if (d.kind === 'md') return d.text
  return new TextDecoder().decode(d.entries[0]!.bytes)
}

test('exportMatchesSpecExample: links become relative paths and the files go beside the note', () => {
  const lib = new Library(fakeClock())
  const jpg = add(lib, 'jpeg', 'receipt.jpg', 'image/jpeg')
  const pdf = add(lib, 'pdf', 'list.pdf', 'application/pdf')
  const note = lib.createNote({ title: 'Groceries', body: `- [ ] Milk\n![](feather://attachment/${jpg.id})\n[list](feather://attachment/${pdf.id})\n` })
  const d = noteDownload(note, [], (b) => lib.attachmentsOf(b))
  expect(d.kind).toBe('zip')
  expect(d.fileName).toBe('Groceries.zip')
  expect(files(d)).toEqual(['Groceries.md', '_attachments/Groceries/receipt.jpg', '_attachments/Groceries/list.pdf'])
  expect(md(d).endsWith('\n---\n\n- [ ] Milk\n![](_attachments/Groceries/receipt.jpg)\n[list](_attachments/Groceries/list.pdf)\n')).toBe(true)
  expect(d.kind === 'zip' && new TextDecoder().decode(d.entries[1]!.bytes)).toBe('jpeg')
})

test('attachmentPathsArePercentEncoded, and an unknown id stays as written', () => {
  const lib = new Library(fakeClock())
  const a = add(lib, '\u0001', 'floor plan.png', 'image/png')
  const note = lib.createNote({ title: 'My Note', body: `![](feather://attachment/${a.id}) [x](feather://attachment/01JC8ZT9HJ2KM3MN4PQ5RS6TV7)` })
  const text = md(noteDownload(note, [], (b) => lib.attachmentsOf(b)))
  expect(text).toContain('![](_attachments/My%20Note/floor%20plan.png)')
  expect(text).toContain('[x](feather://attachment/01JC8ZT9HJ2KM3MN4PQ5RS6TV7)')
  expect(percentEncodePathComponent('a(b)[c]#?/é~!$&\'*+,;=:@ %')).toBe("a%28b%29%5Bc%5D%23%3F%2F%C3%A9~!$&'*+,;=:@%20%25")
})

test('sameNameAttachmentsInOneNoteGetNumbered', () => {
  const lib = new Library(fakeClock())
  const a = add(lib, '1', 'scan.pdf')
  const b = add(lib, '2', 'Scan.pdf')
  const note = lib.createNote({ title: 'n', body: `[a](feather://attachment/${a.id}) [b](feather://attachment/${b.id}) [a](feather://attachment/${a.id})` })
  const d = noteDownload(note, [], (x) => lib.attachmentsOf(x))
  expect(files(d)).toEqual(['n.md', '_attachments/n/scan.pdf', '_attachments/n/Scan (2).pdf'])
  expect(md(d)).toContain(`[a](_attachments/n/scan.pdf) [b](_attachments/n/Scan%20%282%29.pdf) [a](_attachments/n/scan.pdf)`)
})

test('links in code stay as written, and a note without attachments is a plain .md', () => {
  const lib = new Library(fakeClock())
  const a = add(lib, 'x', 'x.pdf')
  const body = `\`[c](feather://attachment/${a.id})\`\n\n\`\`\`\n[c](feather://attachment/${a.id})\n\`\`\`\n`
  const note = lib.createNote({ title: 'Code', body })
  const d = noteDownload(note, [], (x) => lib.attachmentsOf(x))
  expect(d.kind).toBe('md')
  expect(d.fileName).toBe('Code.md')
  expect(md(d).endsWith('\n---\n\n' + body)).toBe(true)
})
