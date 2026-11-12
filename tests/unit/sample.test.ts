import { expect, test } from 'vitest'
import { Library } from '../../src/core/library/library.ts'
import { seedSampleLibrary } from '../../src/core/library/sample.ts'
import { DAY, fakeClock } from './support/clock.ts'

function seeded() {
  const clock = fakeClock()
  const lib = new Library(clock)
  seedSampleLibrary(lib, clock)
  return { lib, clock }
}

test('the sample library matches the iPhone demo plus the welcome note', () => {
  const { lib, clock } = seeded()
  const nbs = lib.notebooks()
  const name = (id: string | null) => (id ? nbs.find((n) => n.id === id)!.name : null)
  expect(nbs.map((n) => [n.name, name(n.parentId)])).toEqual([
    ['Home', 'Projects'],
    ['Personal', null],
    ['Projects', null],
    ['Travel', null],
    ['Work', 'Projects'],
  ])
  expect(lib.tags().map((t) => t.name)).toEqual(['hardware', 'ideas', 'reading', 'to-do'])
  const all = lib.notes({ kind: 'all' })
  expect(all.map((n) => [n.title, n.pinned])).toEqual([
    ['Welcome to the FeatherMark demo', true],
    ['Weather station build', true],
    ['Groceries', true],
    ['Reading list 2027', false],
    ['Lisbon, spring trip', false],
    ['1:1 with Mara', false],
    ['Bread notes', false],
  ])
  expect(lib.notes({ kind: 'trash' }).map((n) => n.title)).toEqual(['Old draft'])
  const byTitle = (t: string) => lib.note(all.find((n) => n.title === t)!.id)!
  expect(clock() - byTitle('Bread notes').modified).toBe(8 * DAY)
  expect(clock() - byTitle('Groceries').modified).toBe(180 * 60_000)
  expect(name(byTitle('Weather station build').notebookId)).toBe('Home')
  expect(byTitle('Weather station build').body).not.toContain('feather://')
  expect(byTitle('Reading list 2027').body).toBe('- [ ] *The Overstory*\n- [ ] *Braiding Sweetgrass*\n- [x] *Piranesi*')
  expect(byTitle('Welcome to the FeatherMark demo').notebookId).toBeNull()
})

test('every sample item is marked as a sample', () => {
  const { lib } = seeded()
  expect(lib.notebooks().every((n) => n.origin === 'sample')).toBe(true)
  expect(lib.tags().every((t) => t.origin === 'sample')).toBe(true)
  const notes = [...lib.notes({ kind: 'all' }), ...lib.notes({ kind: 'trash' })]
  expect(notes.every((n) => n.origin === 'sample')).toBe(true)
})

test('seeding a library that has notes does nothing', () => {
  const clock = fakeClock()
  const lib = new Library(clock)
  lib.createNote({ title: 'mine' })
  seedSampleLibrary(lib, clock)
  expect(lib.notes({ kind: 'all' }).map((n) => n.title)).toEqual(['mine'])
  expect(lib.notebooks()).toEqual([])
})
