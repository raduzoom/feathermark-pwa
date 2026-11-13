// Bold, italic, inline code, link, heading level and the active formats (InlineCommands.swift).
import type { Inline, MarkdownDocument } from '../markdown/document.ts'
import { splitMarkers } from './block-commands.ts'
import { codeContent, line, type Edit, type Selection } from './edit.ts'

export type InlineFormat = 'bold' | 'italic' | 'code'
const MARKER: Record<InlineFormat, string> = { bold: '**', italic: '*', code: '`' }
const KIND: Record<InlineFormat, 'strong' | 'emphasis' | 'code'> = { bold: 'strong', italic: 'emphasis', code: 'code' }

export type ActiveFormats = { inline: Set<InlineFormat>; heading: number; checklist: boolean; bulleted: boolean; code: boolean }

/** A span holds the selection when it contains it; an empty selection must be strictly inside, so a caret just
 *  after "**b**" is outside the bold. */
function holds(i: Inline, sel: Selection): boolean {
  const r = i.range
  if (sel.from === sel.to) return sel.from > r.from && sel.from < r.to
  return sel.from >= r.from && sel.to <= r.to
}

/** Unwraps the innermost span of that format holding the selection; otherwise wraps the selection (each line's
 *  text separately, block markers and surrounding spaces left outside) or, with nothing selected, inserts the pair
 *  with the caret between. Null inside a code block. */
export function toggleInline(format: InlineFormat, text: string, doc: MarkdownDocument, sel: Selection): Edit | null {
  if (codeContent(doc, sel.from)) return null
  let inner: Inline | null = null
  for (const b of doc.blocks)
    for (const i of b.inlines)
      if (i.kind === KIND[format] && i.markers.length === 2 && holds(i, sel) && (!inner || i.range.to - i.range.from < inner.range.to - inner.range.from)) inner = i
  return inner ? unwrap(inner, text, sel) : wrap(format, text, sel)
}

function unwrap(span: Inline, s: string, sel: Selection): Edit {
  const [open, close] = [span.markers[0]!, span.markers[1]!]
  const openLength = open.to - open.from
  const closeLength = close.to - close.from
  const moved = (p: number) => {
    if (p <= open.from) return p
    if (p < open.to) return open.from
    if (p <= close.from) return p - openLength
    if (p < close.to) return close.from - openLength
    return p - openLength - closeLength
  }
  return { from: span.range.from, to: span.range.to, insert: s.slice(open.to, close.from), selection: { from: moved(sel.from), to: moved(sel.to) } }
}

const isSpace = (c: number) => c === 0x20 || c === 0x09

function wrap(format: InlineFormat, s: string, sel: Selection): Edit {
  let marker = MARKER[format]
  if (format === 'code') {
    // a run longer than any backtick run inside, so the code span holds them
    let longest = 0
    let run = 0
    for (const c of s.slice(sel.from, sel.to)) {
      run = c === '`' ? run + 1 : 0
      longest = Math.max(longest, run)
    }
    marker = '`'.repeat(longest + 1)
  }
  const m = marker.length
  const pieces: Array<{ from: number; to: number }> = []
  let p = sel.from
  const end = sel.to
  for (;;) {
    const l = line(s, p)
    const parts = splitMarkers(l.text)
    const textStart = l.from + (parts.indent + parts.markers).length
    let a = Math.max(p, textStart)
    let b = Math.min(end, l.to)
    while (a < b && isSpace(s.charCodeAt(a))) a++
    while (b > a && isSpace(s.charCodeAt(b - 1))) b--
    if (b > a) pieces.push({ from: a, to: b })
    const next = l.to + l.ending.length
    if (l.ending === '' || next > end || next <= p) break
    p = next
  }
  const first = pieces[0]
  const last = pieces[pieces.length - 1]
  if (!first || !last) {
    const at = sel.from
    return { from: at, to: at, insert: marker + marker, selection: { from: at + m, to: at + m } }
  }
  let insert = ''
  let cursor = first.from
  for (const piece of pieces) {
    insert += s.slice(cursor, piece.from) + marker + s.slice(piece.from, piece.to) + marker
    cursor = piece.to
  }
  return { from: first.from, to: last.to, insert, selection: { from: first.from + m, to: last.to + (2 * pieces.length - 1) * m } }
}

/** The selection becomes `[selection](https://)` with `https://` selected, so typing replaces it; with nothing
 *  selected, `[](https://)` with the caret between the brackets. */
export function link(text: string, sel: Selection): Edit {
  const label = text.slice(sel.from, sel.to)
  const placeholder = 'https://'
  const insert = '[' + label + '](' + placeholder + ')'
  if (sel.from === sel.to) return { from: sel.from, to: sel.to, insert, selection: { from: sel.from + 1, to: sel.from + 1 } }
  const url = sel.from + 1 + label.length + 2
  return { from: sel.from, to: sel.to, insert, selection: { from: url, to: url + placeholder.length } }
}

/** Sets the caret line's heading level (0 = body text), replacing any heading, quote or list markers, as the block
 *  menu does. The caret stays on the same character of the line's text. */
export function heading(level: number, text: string, caret: number): Edit {
  const l = line(text, caret)
  const parts = splitMarkers(l.text)
  const oldPrefix = (parts.indent + parts.markers).length
  const newPrefix = parts.indent + (level > 0 ? '#'.repeat(Math.min(level, 6)) + ' ' : '')
  const inText = Math.max(0, caret - l.from - oldPrefix)
  const at = l.from + newPrefix.length + inText
  return { from: l.from, to: l.from + oldPrefix, insert: newPrefix, selection: { from: at, to: at } }
}

/** The formats on at the selection's start (inline spans holding the selection, and the caret's block). */
export function activeFormats(doc: MarkdownDocument, _text: string, sel: Selection): ActiveFormats {
  const f: ActiveFormats = { inline: new Set(), heading: 0, checklist: false, bulleted: false, code: false }
  for (const b of doc.blocks)
    for (const i of b.inlines) {
      if (!holds(i, sel)) continue
      const format = (Object.keys(KIND) as InlineFormat[]).find((k) => KIND[k] === i.kind)
      if (format) f.inline.add(format)
    }
  const p = sel.from
  f.code = codeContent(doc, p) !== null
  const block = doc.blocks.find((b) => p >= b.range.from && p <= b.range.to)
  if (block?.kind === 'heading') f.heading = block.level
  else if (block?.kind === 'listItem') {
    f.checklist = block.checkbox !== null
    f.bulleted = !block.ordered && block.checkbox === null
  } else if (block?.kind === 'codeBlock') f.code = true
  return f
}
