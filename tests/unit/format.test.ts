import { expect, test } from 'vitest'
import { LibraryError } from '../../src/core/library/types.ts'
import {
  deleteNotebookConfirmation,
  deletePermanentlyConfirmation,
  deleteTagConfirmation,
  editedLine,
  emptyTrashConfirmation,
  errorMessage,
  listDate,
  noteCount,
  noteMeta,
  plainPreview,
  rowGroup,
  trashMeta,
} from '../../src/model/format.ts'

const opts = { locale: 'en-GB', timeZone: 'UTC' }
const now = Date.UTC(2026, 10, 12, 15, 0)
const at = (d: number, h = 10, m = 42, y = 2026, mo = 10) => Date.UTC(y, mo, d, h, m)

test('listDate', () => {
  expect(listDate(at(12), now, opts)).toBe('Today, 10:42')
  expect(listDate(at(11), now, opts)).toBe('Yesterday')
  expect(listDate(at(7), now, opts)).toBe('7 Nov')
  expect(listDate(at(2, 10, 42, 2025), now, opts)).toBe('2 Nov 2025')
})

test('editedLine', () => {
  expect(editedLine(at(12), now, opts)).toBe('Edited today at 10:42')
  expect(editedLine(at(11, 9, 0), now, opts)).toBe('Edited yesterday at 09:00')
  expect(editedLine(at(7), now, opts)).toBe('Edited 7 Nov')
})

test('trashMeta', () => {
  expect(trashMeta(at(3), 30, now, opts)).toBe('Deleted 3 Nov · removed in 21 days')
  expect(trashMeta(now - 30 * 86_400_000 + 3_600_000, 30, now, opts)).toBe('Deleted 13 Oct · removed in 1 day')
  expect(trashMeta(now - 31 * 86_400_000, 30, now, opts)).toBe('Deleted 12 Oct · removed today')
  expect(trashMeta(at(12), 30, now, opts)).toBe('Deleted today · removed in 30 days')
  expect(trashMeta(at(11), 30, now, opts)).toBe('Deleted yesterday · removed in 29 days')
})

test('noteMeta', () => {
  const s = { modified: at(12) } as Parameters<typeof noteMeta>[0]
  expect(noteMeta(s, 'Home', now, opts)).toBe('Today, 10:42 · Home')
  expect(noteMeta(s, null, now, opts)).toBe('Today, 10:42')
})

test('confirmations use the Apple wording in sentence case', () => {
  expect(deleteNotebookConfirmation('Projects', 2, 3)).toEqual({
    title: 'Delete “Projects”?',
    message: 'Its 2 sub-notebooks are deleted too, and its 3 notes move to the Trash.',
    button: 'Delete notebook',
  })
  expect(deleteNotebookConfirmation('Travel', 0, 1).message).toBe('Its 1 note moves to the Trash.')
  expect(deleteNotebookConfirmation('Empty', 0, 0).message).toBe("It's empty.")
  expect(deleteTagConfirmation('to-do')).toEqual({
    title: 'Delete the tag “to-do”?',
    message: 'Notes keep their text; only the tag is removed.',
    button: 'Delete tag',
  })
  expect(emptyTrashConfirmation(1)).toEqual({ title: 'Empty the Trash?', message: "1 note will be deleted for good. This can't be undone.", button: 'Empty Trash' })
  expect(deletePermanentlyConfirmation('  ')).toEqual({ title: 'Delete “Untitled” permanently?', message: "This can't be undone.", button: 'Delete permanently' })
})

test('errors use the Apple wording', () => {
  expect(errorMessage(new LibraryError('duplicateTagName', 'travel'), 'Travel')).toBe('A tag named “Travel” already exists.')
  expect(errorMessage(new LibraryError('notebookCycle'))).toBe("A notebook can't go inside its own sub-notebook.")
  expect(errorMessage(new LibraryError('invalidName'))).toBe("Names can't be empty.")
  expect(errorMessage(new LibraryError('notFound'))).toBe('That item no longer exists.')
  expect(errorMessage(new Error('boom'))).toBe('Something went wrong: boom')
})

test('rowGroup: pinned first only where the view puts pinned notes first', () => {
  expect(rowGroup({ modified: at(12), pinned: true }, true, now, opts)).toBe('Pinned')
  expect(rowGroup({ modified: at(12), pinned: true }, false, now, opts)).toBe('Today')
  expect(rowGroup({ modified: at(7), pinned: true }, false, now, opts)).toBe('Earlier')
})

test('rowGroup: Today, Yesterday and Earlier by the day of modified', () => {
  expect(rowGroup({ modified: at(12), pinned: false }, true, now, opts)).toBe('Today')
  expect(rowGroup({ modified: at(11), pinned: false }, true, now, opts)).toBe('Yesterday')
  expect(rowGroup({ modified: at(10), pinned: false }, true, now, opts)).toBe('Earlier')
  expect(rowGroup({ modified: at(12, 10, 42, 2025), pinned: false }, true, now, opts)).toBe('Earlier')
})

test('rowGroup: the edges are local midnights', () => {
  expect(rowGroup({ modified: Date.UTC(2026, 10, 12, 0, 0), pinned: false }, true, now, opts)).toBe('Today')
  expect(rowGroup({ modified: Date.UTC(2026, 10, 11, 23, 59, 59, 999), pinned: false }, true, now, opts)).toBe('Yesterday')
  expect(rowGroup({ modified: Date.UTC(2026, 10, 11, 0, 0), pinned: false }, true, now, opts)).toBe('Yesterday')
  expect(rowGroup({ modified: Date.UTC(2026, 10, 10, 23, 59, 59, 999), pinned: false }, true, now, opts)).toBe('Earlier')
  // in Tokyo (UTC+9) now is 00:00 on 13 Nov, so 12 Nov 15:00 UTC is today there and 12 Nov 14:59 UTC yesterday
  const tokyo = { locale: 'en-GB', timeZone: 'Asia/Tokyo' }
  expect(rowGroup({ modified: now, pinned: false }, true, now, tokyo)).toBe('Today')
  expect(rowGroup({ modified: now - 60_000, pinned: false }, true, now, tokyo)).toBe('Yesterday')
})

test('noteCount', () => {
  expect(noteCount(1)).toBe('1 note')
  expect(noteCount(7)).toBe('7 notes')
  expect(noteCount(0)).toBe('0 notes')
})

test('plainPreview drops Markdown marks from a row preview, for display only', () => {
  expect(plainPreview('- [ ] Oat milk - [ ] Lemons - [x] Rye flour')).toBe('Oat milk, Lemons, Rye flour')
  expect(plainPreview('## Agenda 1. Release dates 2. Hiring for the spring > Keep the scope small enough to ship.')).toBe(
    'Agenda 1. Release dates 2. Hiring for the spring, Keep the scope small enough to ship.',
  )
  expect(plainPreview('Goal: reliable readings **through winter**. The sensor')).toBe('Goal: reliable readings through winter. The sensor')
  expect(plainPreview('Starter fed at 8, ready by 2. - 500 g flour')).toBe('Starter fed at 8, ready by 2. 500 g flour')
  expect(plainPreview('See the [tram map](https://www.carris.pt) before going.')).toBe('See the tram map before going.')
  expect(plainPreview('![Radiation shield](attachments/a.png) Mounted *north* with `code`')).toBe('Radiation shield Mounted north with code')
  expect(plainPreview('- [ ] *The Overstory* - [ ] *Braiding Sweetgrass* - [x] *Piranesi*')).toBe('The Overstory, Braiding Sweetgrass, Piranesi')
  // text that only looks like a mark stays
  expect(plainPreview('Tram 28 from Martim Moniz; 3 * 4 = 12; snake_case_name')).toBe('Tram 28 from Martim Moniz; 3 * 4 = 12; snake_case_name')
  expect(plainPreview('```swift let x = 1 ``` after')).toBe('let x = 1 after')
  expect(plainPreview('')).toBe('')
})
