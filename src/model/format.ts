// Every user-visible string built from data (FeatherAppModel Formatting.swift), in the web's sentence case.
import { displayTitle } from '../core/library/names.ts'
import { LibraryError, type NoteSummary } from '../core/library/types.ts'

export type FormatOpts = { locale?: string; timeZone?: string }
const DAY = 86_400_000

// Intl.DateTimeFormat is slow to make (a list of 1,000 rows made about 14,000 of them per redraw); one is kept per
// locale, time zone and set of options.
const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify([locale ?? null, options])
  let f = formatters.get(key)
  if (!f) formatters.set(key, (f = new Intl.DateTimeFormat(locale, options)))
  return f
}

function dayKey(ms: number, o: FormatOpts): string {
  return formatter('en-CA', { timeZone: o.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
}
const sameDay = (a: number, b: number, o: FormatOpts) => dayKey(a, o) === dayKey(b, o)
const yesterday = (ms: number, now: number, o: FormatOpts) => sameDay(ms, now - DAY, o)

function time(ms: number, o: FormatOpts): string {
  return formatter(o.locale, { timeZone: o.timeZone, hour: '2-digit', minute: '2-digit' }).format(ms)
}

/** "7 Nov", or "2 Nov 2025" outside the current year. */
function dayMonth(ms: number, now: number, o: FormatOpts): string {
  const year = (t: number) => formatter('en-CA', { timeZone: o.timeZone, year: 'numeric' }).format(t)
  const same = year(ms) === year(now)
  return formatter(o.locale, { timeZone: o.timeZone, day: 'numeric', month: 'short', ...(same ? {} : { year: 'numeric' }) }).format(ms)
}

export function listDate(ms: number, now: number, o: FormatOpts = {}): string {
  if (sameDay(ms, now, o)) return `Today, ${time(ms, o)}`
  if (yesterday(ms, now, o)) return 'Yesterday'
  return dayMonth(ms, now, o)
}

export function editedLine(ms: number, now: number, o: FormatOpts = {}): string {
  if (sameDay(ms, now, o)) return `Edited today at ${time(ms, o)}`
  if (yesterday(ms, now, o)) return `Edited yesterday at ${time(ms, o)}`
  return `Edited ${dayMonth(ms, now, o)}`
}

export function trashMeta(trashedAt: number, retentionDays: number, now: number, o: FormatOpts = {}): string {
  const deleted = sameDay(trashedAt, now, o) ? 'today' : yesterday(trashedAt, now, o) ? 'yesterday' : dayMonth(trashedAt, now, o)
  const remaining = trashedAt + retentionDays * DAY - now
  const days = Math.ceil(remaining / DAY)
  const removed = remaining <= 0 ? 'removed today' : days === 1 ? 'removed in 1 day' : `removed in ${days} days`
  return `Deleted ${deleted} · ${removed}`
}

export function noteMeta(s: Pick<NoteSummary, 'modified'>, notebookName: string | null, now: number, o: FormatOpts = {}): string {
  const when = listDate(s.modified, now, o)
  return notebookName ? `${when} · ${notebookName}` : when
}

/** "7 notes": the note list's count beside its title. */
export function noteCount(n: number): string {
  return n === 1 ? '1 note' : `${n} notes`
}

const BLOCK_START = /^(#{1,6}|>|[-*+]( \[[ xX]\])?|\d+\.)\s/
const BLOCK_MARK = /(^|\s)(#{1,6}|>|[-*+] \[[ xX]\]|[-*+])(?=\s)/g
const SENTENCE_END = /[.,;:!?]$/

/** A row preview (data-model.md "List preview": white space already collapsed) with its Markdown marks dropped, for
 *  display only: "- [ ] Oat milk - [ ] Lemons" reads "Oat milk, Lemons". The line breaks are gone, so a list or quote
 *  mark inside the text counts only in a note that starts with a mark, or after a sentence's end; "3 * 4" stays. */
export function plainPreview(preview: string): string {
  let out = plainCache.get(preview)
  if (out === undefined) {
    // a list of 1,000 rows redraws as a whole: each preview is worked out once
    if (plainCache.size >= 4000) plainCache.clear()
    plainCache.set(preview, (out = strip(preview)))
  }
  return out
}
const plainCache = new Map<string, string>()

function strip(preview: string): string {
  const blocks = BLOCK_START.test(preview)
  let s = preview
    .replace(/```[\w+-]*\s*/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(BLOCK_MARK, (whole, _space: string, mark: string, at: number, all: string) => {
    if (at === 0) return ''
    const before = all.slice(0, at).trimEnd()
    const marksHere = blocks && (mark.length > 1 || mark === '-' || mark === '>' || mark.startsWith('#'))
    if (!marksHere && !(SENTENCE_END.test(before) && (mark === '-' || mark === '>'))) return whole
    return SENTENCE_END.test(before) ? ' ' : ', '
  })
  s = s
    .replace(/(\*\*|__|~~)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/\*(\S(?:.*?\S)?)\*/g, '$1')
    .replace(/(^|\W)_(\S(?:.*?\S)?)_(?=\W|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
  return s.replace(/\s+/g, ' ').trim()
}

/** The heading a list row sits under (data-model.md "List groups (web)"). `pinnedFirst`: the view puts pinned notes
 *  first (All, a notebook, a tag). Uses the kept formatters only, so it adds no formatter per row. */
export type RowGroup = 'Pinned' | 'Today' | 'Yesterday' | 'Earlier'
export function rowGroup(s: Pick<NoteSummary, 'modified' | 'pinned'>, pinnedFirst: boolean, now: number, o: FormatOpts = {}): RowGroup {
  if (pinnedFirst && s.pinned) return 'Pinned'
  if (sameDay(s.modified, now, o)) return 'Today'
  return yesterday(s.modified, now, o) ? 'Yesterday' : 'Earlier'
}

/** "Groceries, pinned, Today, 08:15, Personal": a note row's accessible name. */
export function rowLabel(s: NoteSummary, notebookName: string | null, now: number, o: FormatOpts = {}): string {
  const parts = [displayTitle(s.title)]
  if (s.pinned) parts.push('pinned')
  parts.push(listDate(s.modified, now, o))
  if (notebookName) parts.push(notebookName)
  return parts.join(', ')
}

export type Confirmation = { title: string; message: string; button: string }
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function deleteNotebookConfirmation(name: string, subNotebooks: number, notes: number): Confirmation {
  const parts: string[] = []
  if (subNotebooks > 0) parts.push(`Its ${count(subNotebooks, 'sub-notebook', 'sub-notebooks')} ${subNotebooks === 1 ? 'is' : 'are'} deleted too`)
  if (notes > 0) {
    const move = `${count(notes, 'note', 'notes')} ${notes === 1 ? 'moves' : 'move'} to the Trash`
    parts.push(parts.length ? `its ${move}` : `Its ${move}`)
  }
  return { title: `Delete “${name}”?`, message: parts.length ? parts.join(', and ') + '.' : "It's empty.", button: 'Delete notebook' }
}

export function deleteTagConfirmation(name: string): Confirmation {
  return { title: `Delete the tag “${name}”?`, message: 'Notes keep their text; only the tag is removed.', button: 'Delete tag' }
}

export function emptyTrashConfirmation(n: number): Confirmation {
  return { title: 'Empty the Trash?', message: `${count(n, 'note', 'notes')} will be deleted for good. This can't be undone.`, button: 'Empty Trash' }
}

export function deletePermanentlyConfirmation(title: string): Confirmation {
  return { title: `Delete “${displayTitle(title)}” permanently?`, message: "This can't be undone.", button: 'Delete permanently' }
}

/** A file over the demo's attachment limit (ui-copy.md "Web app", Editor). */
export function tooLargeMessage(fileName: string): string {
  return `“${fileName}” is too large for the demo. Files can be up to 25 MB.`
}

/** A dropped folder or a file the browser can't read (ui-copy.md "Web app", Editor). */
export function unreadableMessage(fileName: string): string {
  return `“${fileName}” couldn’t be read.`
}

export function errorMessage(e: unknown, tagName?: string): string {
  if (e instanceof LibraryError) {
    switch (e.kind) {
      case 'duplicateTagName':
        return `A tag named “${tagName ?? e.detail ?? ''}” already exists.`
      case 'notebookCycle':
        return "A notebook can't go inside its own sub-notebook."
      case 'invalidName':
        return "Names can't be empty."
      case 'notFound':
        return 'That item no longer exists.'
    }
  }
  return `Something went wrong: ${e instanceof Error ? e.message : String(e)}`
}

/** The unlock screen's title (ui-copy.md "Web app" › "Accounts (Phase 20)"): thrown out by the server, the tab asks
 *  to sign in again; another tab owns the kept library, it says so; otherwise it is simply locked. */
export function lockedTitle(email: string, reason: 'idle' | 'manual' | 'signedOut' | 'otherTab' | 'kept'): string {
  if (reason === 'signedOut') return `Sign in again as ${email}`
  return reason === 'otherTab' ? 'FeatherMark is open in another tab.' : 'FeatherMark is locked'
}
