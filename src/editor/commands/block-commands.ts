// The block menu's edits and attachment insertion (BlockCommands.swift). Each block edit replaces the caret's
// line, so a pick and the removal of its "/query" trigger are one undo step.
import type { MarkdownDocument } from '../markdown/document.ts'
import { choice, type BlockChoiceId } from './block-choice.ts'
import { codeContent, isBlank, ITEM_PATTERN, itemMarker, leadingWhitespace, line, nextBullet, previousEnding, previousItem, type Edit, type Line, type Selection } from './edit.ts'

const HEADING_MARKER = /^[ \t]*#{1,6}(?:[ \t]+|$)/
const QUOTE_MARKER = /^[ \t]*(?:>[ ]?)+/

/** A line's leading whitespace, the block markers after it (headings, quote prefixes, list markers with their
 *  checkbox, in any order and repeated), and the text that follows. */
export function splitMarkers(text: string): { indent: string; markers: string; content: string } {
  const indent = leadingWhitespace(text)
  let rest = text.slice(indent.length)
  let markers = ''
  for (;;) {
    let length = 0
    for (const pattern of [HEADING_MARKER, QUOTE_MARKER, ITEM_PATTERN]) {
      const m = pattern.exec(rest)
      if (m && m[0].length > 0) {
        length = m[0].length
        break
      }
    }
    if (length === 0) break
    markers += rest.slice(0, length)
    rest = rest.slice(length)
  }
  return { indent, markers, content: rest }
}

/** What lines added below `l` start with, so they stay in its container: a list item's content indent, a quote's
 *  ">" run, or the line's leading whitespace. */
function containerPrefix(l: Line): string {
  const m = itemMarker(l)
  if (m) return m.indent + ' '.repeat(m.bullet.length + Math.max(1, m.spacing.length))
  const q = QUOTE_MARKER.exec(l.text)
  if (q) return q[0].endsWith(' ') ? q[0] : q[0] + ' '
  return leadingWhitespace(l.text)
}

/** The caret's line with `trigger` (inside it) removed; `from` and `to` stay those of the line in the text. */
function lineWithout(trigger: Selection | null, s: string, caret: number): Line {
  const l = line(s, caret)
  if (trigger && trigger.from >= l.from && trigger.to <= l.to) {
    return { ...l, text: l.text.slice(0, trigger.from - l.from) + l.text.slice(trigger.to - l.from) }
  }
  return l
}

const trimTrailing = (s: string) => s.replace(/[ \t]+$/, '')

function previousLineIsBlank(s: string, lineStart: number): boolean {
  if (lineStart <= 0) return true
  return isBlank(line(s, lineStart - previousEnding(s, lineStart).length).text)
}

function marker(id: BlockChoiceId, s: string, lineStart: number, indent: string): string {
  switch (id) {
    case 'heading1':
      return '# '
    case 'heading2':
      return '## '
    case 'heading3':
      return '### '
    case 'bulleted':
      return '- '
    case 'todo':
      return '- [ ] '
    case 'quote':
      return '> '
    case 'numbered': {
      const p = previousItem(s, lineStart)
      if (p && p.indent === indent && (p.bullet.endsWith('.') || p.bullet.endsWith(')'))) return nextBullet(p.bullet) + ' '
      return '1. '
    }
    default:
      return ''
  }
}

/** The edit for a block choice at the caret, removing `trigger` (the typed "/query") in the same edit. Null for
 *  image or file and scan, which the editor inserts once the file arrives. */
export function block(id: BlockChoiceId, text: string, caret: number, trigger: Selection | null): Edit | null {
  const l = lineWithout(trigger, text, caret)
  const nl = l.ending === '' ? previousEnding(text, l.from) : l.ending
  const { indent, content } = splitMarkers(l.text)
  const empty = isBlank(content)
  const edit = (before: string, after = ''): Edit => ({ from: l.from, to: l.to, insert: before + after, selection: { from: l.from + before.length, to: l.from + before.length } })

  if (choice(id).textBlock) return edit(indent + marker(id, text, l.from, indent) + content)
  // Code and divider: on an empty line they replace it, markers included; below a line with text they keep its
  // container.
  const prefix = empty ? indent : containerPrefix(l)
  const blank = trimTrailing(prefix)
  const head = empty ? '' : l.text + nl
  if (id === 'code') return edit(head + prefix + '```' + nl + prefix, nl + prefix + '```')
  if (id === 'divider') {
    // a divider right under text would make that text a setext heading
    const needsBlank = !empty || !previousLineIsBlank(text, l.from)
    return edit(head + (needsBlank ? blank + nl : '') + prefix + '---' + nl + prefix)
  }
  return null
}

/** Where an image, file or scan goes: the line itself once the trigger is removed and nothing but markers is left
 *  (the edit then clears the line), otherwise the line's end. `location` is in the text after `edit`. */
export function mediaInsertionPoint(text: string, caret: number, trigger: Selection | null): { edit: Edit | null; location: number } {
  const l = lineWithout(trigger, text, caret)
  if (isBlank(splitMarkers(l.text).content)) {
    const clear: Edit | null = l.to === l.from ? null : { from: l.from, to: l.to, insert: '', selection: { from: l.from, to: l.from } }
    return { edit: clear, location: l.from }
  }
  const removal: Edit | null = trigger ? { from: trigger.from, to: trigger.to, insert: '', selection: { from: trigger.from, to: trigger.from } } : null
  return { edit: removal, location: l.from + l.text.length }
}

/** Whether a "/" typed at `slashAt` opens the block menu: only where its line's text begins (nothing but
 *  whitespace and block markers before it), never in code or in a block shown as source (HTML, tables). */
export function slashOpensMenu(text: string, doc: MarkdownDocument, slashAt: number): boolean {
  const l = line(text, slashAt)
  const before = text.slice(l.from, slashAt)
  if (splitMarkers(before).content !== '' || codeContent(doc, slashAt)) return false
  return !doc.blocks.some((b) => {
    if (b.kind === 'unrendered') return slashAt >= b.range.from && slashAt <= b.range.to
    if (b.kind === 'codeBlock') return slashAt > b.range.from && slashAt < b.range.to
    return false
  })
}

function nextLineIsBlank(s: string, l: Line): boolean {
  if (l.ending === '') return true
  return isBlank(line(s, l.to + l.ending.length).text)
}

/** Inserts attachment snippets from the block menu as blocks of their own, so an image shows as an image: on an
 *  empty line (`at` its start) they replace it; at the end of a line with text they go below it in its
 *  container. Blank lines separate them from text above and below, and every new line uses the line's ending. */
export function mediaEdit(snippets: string[], text: string, at: number): Edit {
  const l = line(text, at)
  const nl = l.ending === '' ? previousEnding(text, l.from) : l.ending
  const empty = isBlank(splitMarkers(l.text).content)
  const prefix = empty ? leadingWhitespace(l.text) : containerPrefix(l)
  const blank = trimTrailing(prefix)
  const body = snippets.map((s) => prefix + s).join(nl + blank + nl)
  const after = nextLineIsBlank(text, l) ? '' : nl + blank
  let from: number
  let to: number
  let before: string
  if (empty) {
    ;[from, to] = [l.from, l.to]
    before = previousLineIsBlank(text, l.from) ? '' : blank + nl
  } else {
    ;[from, to] = [l.to, l.to]
    before = nl + blank + nl
  }
  const end = from + (before + body).length
  return { from, to, insert: before + body + after, selection: { from: end, to: end } }
}

/** Pasted or dropped files: their snippets replace `at`, each on its own line (new lines where the range isn't at
 *  a line's start or end), using the note's own line ending. Null when there are none. */
export function attachmentSnippets(snippets: string[], text: string, at: Selection): Edit | null {
  if (snippets.length === 0) return null
  const start = Math.min(at.from, text.length)
  const end = Math.min(at.to, text.length)
  const isBreak = (c: number) => c === 0x0a || c === 0x0d
  const atLineStart = start === 0 || isBreak(text.charCodeAt(start - 1))
  const atLineEnd = end >= text.length || isBreak(text.charCodeAt(end))
  const l = line(text, start)
  const nl = l.ending === '' ? previousEnding(text, l.from) : l.ending
  let insert = snippets.join(nl)
  if (!atLineStart) insert = nl + insert
  if (!atLineEnd) insert += nl
  return { from: start, to: end, insert, selection: { from: start + insert.length, to: start + insert.length } }
}
