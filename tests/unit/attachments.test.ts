// Attachments in the in-memory library (data-model.md "Attachment", "Attachment references") and the model's file
// handling for the editor (specs/editor.md "Attachments in the text").
import { expect, test } from 'vitest'
import { attachmentSnippet, MAX_ATTACHMENT_BYTES, sha256Hex } from '../../src/core/library/attachments.ts'
import { Library } from '../../src/core/library/library.ts'
import { seedSampleLibrary } from '../../src/core/library/sample.ts'
import { createAppModel } from '../../src/model/app-model.ts'
import { fakeClock } from './support/clock.ts'
import { fakeTimers } from './support/timers.ts'

const bytes = (s: string) => new TextEncoder().encode(s)

test('addAttachment records size, sha256 and mime', async () => {
  const lib = new Library(fakeClock())
  const sha = await sha256Hex(bytes('abc'))
  expect(sha).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  const a = lib.addAttachment({ bytes: bytes('abc'), filename: 'a.txt', mime: 'text/plain', sha256: sha })
  expect(a).toMatchObject({ filename: 'a.txt', mime: 'text/plain', size: 3, sha256: sha, origin: 'user' })
  expect(a.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  expect(lib.attachment(a.id)).toBe(a)
  expect(lib.attachment('01JC8ZT9HJ2KM3MN4PQ5RS6TV7')).toBe(null)
})

test('the snippet escapes brackets', () => {
  const a = { id: '01JC8ZT9HJ2KM3MN4PQ5RS6TV7', filename: 'a[1].png', mime: 'image/png' }
  expect(attachmentSnippet(a)).toBe('![a\\[1\\].png](feather://attachment/01JC8ZT9HJ2KM3MN4PQ5RS6TV7)')
  expect(attachmentSnippet({ ...a, filename: 'back\\slash.pdf', mime: 'application/pdf' })).toBe('[back\\\\slash.pdf](feather://attachment/01JC8ZT9HJ2KM3MN4PQ5RS6TV7)')
})

test('attachmentsOf ignores code and repeats', async () => {
  const lib = new Library(fakeClock())
  const add = async (name: string) => lib.addAttachment({ bytes: bytes(name), filename: name, mime: 'application/pdf', sha256: await sha256Hex(bytes(name)) })
  const [a, b, c] = [await add('a.pdf'), await add('b.pdf'), await add('c.pdf')]
  const body = `[b](feather://attachment/${b.id}) ![a](feather://attachment/${a.id})\n\n\`[c](feather://attachment/${c.id})\`\n\n\`\`\`\n[c](feather://attachment/${c.id})\n\`\`\`\n\n[again](feather://attachment/${b.id}) [unknown](feather://attachment/01JC8ZT9HJ2KM3MN4PQ5RS6TV7)`
  expect(lib.attachmentsOf(body).map((x) => x.filename)).toEqual(['b.pdf', 'a.pdf'])
})

test('a file over 25 MB is refused with the demo copy', async () => {
  const lib = new Library(fakeClock())
  const m = createAppModel(lib, { clock: fakeClock(), setTimer: fakeTimers() })
  m.newNote()
  const big = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], 'video.mov', { type: 'video/quicktime' })
  const small = new File([bytes('%PDF-1.4')], 'receipt.pdf', { type: 'application/pdf' })
  const snippets = await m.addFiles([big, small])
  expect(snippets).toHaveLength(1)
  expect(snippets[0]).toMatch(/^\[receipt\.pdf\]\(feather:\/\/attachment\/[0-9A-Z]{26}\)$/)
  expect(m.error.value).toBe('“video.mov” is too large for the demo. Files can be up to 25 MB.')
})

test('a feather URL resolves to its file, and an unknown one to null', async () => {
  const lib = new Library(fakeClock())
  const m = createAppModel(lib, { clock: fakeClock(), setTimer: fakeTimers() })
  const [snippet] = await m.addFiles([new File([bytes('png')], 'p.png', { type: 'image/png' })])
  const url = /\((feather:[^)]+)\)/.exec(snippet!)![1]!
  const r = m.attachmentUrl(url)!
  expect(r).toMatchObject({ filename: 'p.png', mime: 'image/png', image: true })
  expect(r.objectUrl).toMatch(/^blob:/)
  expect(m.attachmentUrl(url)!.objectUrl).toBe(r.objectUrl) // made once
  expect(m.attachmentUrl('feather://attachment/01JC8ZT9HJ2KM3MN4PQ5RS6TV7')).toBe(null)
  expect(m.attachmentUrl('https://example.com/x.png')).toBe(null)
})

test('the sample library has the radiation shield image', async () => {
  const lib = new Library(fakeClock())
  seedSampleLibrary(lib, fakeClock())
  const weather = lib.notes({ kind: 'all' }).find((n) => n.title === 'Weather station build')!
  const body = lib.note(weather.id)!.body
  const [shield] = lib.attachmentsOf(body)
  expect(shield).toMatchObject({ filename: 'radiation-shield.png', mime: 'image/png', origin: 'sample' })
  expect(body).toContain(`\n\n![Radiation shield](feather://attachment/${shield!.id})\n\n## Parts`)
  expect(await sha256Hex(shield!.bytes)).toBe(shield!.sha256)
  // a real PNG
  expect([...shield!.bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
})

// Final review: a file that can't be read (a dropped folder) rejected and lost the rest of the batch silently.
test('a file that can’t be read is skipped with a message, and the others are added', async () => {
  const lib = new Library(fakeClock())
  const m = createAppModel(lib, { clock: fakeClock(), setTimer: fakeTimers() })
  const broken = new File([bytes('x')], 'Folder', { type: '' })
  Object.defineProperty(broken, 'arrayBuffer', { value: () => Promise.reject(new DOMException('NotReadableError')) })
  const ok = new File([bytes('%PDF')], 'ok.pdf', { type: 'application/pdf' })
  const snippets = await m.addFiles([broken, ok])
  expect(snippets).toHaveLength(1)
  expect(m.error.value).toBe('“Folder” couldn’t be read.')
})
