// Word-processor behaviour as pure text edits (EditorCommands.swift). Each returns null when it doesn't apply,
// and the editor's default handling runs.
import type { MarkdownDocument } from '../markdown/document.ts'
import {
  bulletWidth,
  codeContent,
  isBlank,
  itemMarker,
  leadingWhitespace,
  line,
  markerLength,
  nextBullet,
  previousEnding,
  previousItem,
  type Edit,
  type Selection,
} from './edit.ts'

const caretAt = (p: number): Selection => ({ from: p, to: p })

export function returnKey(text: string, doc: MarkdownDocument, sel: Selection): Edit | null {
  if (sel.to !== sel.from) return null
  const p = sel.from
  const l = line(text, p)
  const newline = l.ending === '' ? previousEnding(text, l.from) : l.ending
  if (codeContent(doc, p)) {
    const insert = newline + leadingWhitespace(l.text)
    return { from: p, to: p, insert, selection: caretAt(p + insert.length) }
  }
  const m = itemMarker(l)
  if (!m) return null
  const markerEnd = l.from + markerLength(m)
  if (p < markerEnd) return null
  const rest = text.slice(markerEnd, l.to)
  if (isBlank(rest)) {
    // empty item: the list ends here
    return { from: l.from, to: l.to, insert: '', selection: caretAt(l.from) }
  }
  const marker = m.indent + nextBullet(m.bullet) + (m.spacing === '' ? ' ' : m.spacing) + (m.checkbox !== null ? '[ ] ' : '')
  const insert = newline + marker
  return { from: p, to: p, insert, selection: caretAt(p + insert.length) }
}

export function tab(text: string, doc: MarkdownDocument, sel: Selection): Edit | null {
  const p = sel.from
  if (codeContent(doc, p)) return { from: sel.from, to: sel.to, insert: '    ', selection: caretAt(p + 4) }
  const l = line(text, p)
  const m = itemMarker(l)
  const previous = m ? previousItem(text, l.from) : null
  if (!m || !previous) return null
  const target = previous.indent.length + bulletWidth(previous)
  const current = m.indent.length
  if (target <= current) return null
  const add = ' '.repeat(target - current)
  return { from: l.from, to: l.from, insert: add, selection: { from: sel.from + add.length, to: sel.to + add.length } }
}

export function backtab(text: string, doc: MarkdownDocument, sel: Selection): Edit | null {
  const p = sel.from
  const l = line(text, p)
  if (codeContent(doc, p)) {
    const spaces = Math.min(4, /^ */.exec(l.text)![0].length)
    if (spaces === 0) return null
    return { from: l.from, to: l.from + spaces, insert: '', selection: caretAt(Math.max(l.from, p - spaces)) }
  }
  const m = itemMarker(l)
  if (!m) return null
  const current = m.indent.length
  if (current === 0) return null
  let target = 0
  let start = l.from
  while (start > 0) {
    const prev = line(text, start - 1)
    if (isBlank(prev.text)) break
    const pm = itemMarker(prev)
    if (pm && pm.indent.length < current) {
      target = pm.indent.length
      break
    }
    start = prev.from
  }
  const remove = current - target
  const from = Math.max(l.from, p - remove)
  return { from: l.from, to: l.from + remove, insert: '', selection: { from, to: from + (sel.to - sel.from) } }
}

export function backspaceAtItemStart(text: string, doc: MarkdownDocument, sel: Selection): Edit | null {
  if (sel.to !== sel.from) return null
  const p = sel.from
  if (codeContent(doc, p)) return null
  const l = line(text, p)
  let len: number | null = null
  const m = itemMarker(l)
  if (m) len = markerLength(m)
  else {
    const q = /^[ ]{0,3}(>[ ]?)+/.exec(l.text)
    if (q) len = q[0].length
  }
  if (len === null || len <= 0 || p !== l.from + len) return null
  return { from: l.from, to: l.from + len, insert: '', selection: caretAt(l.from) }
}

export function toggleCheckbox(_text: string, doc: MarkdownDocument, at: number): Edit | null {
  for (const b of doc.blocks) {
    if (at < b.range.from || at > b.range.to) continue
    if (b.kind !== 'listItem' || !b.checkbox) continue
    const r = b.checkbox.range
    return { from: r.from, to: r.to, insert: b.checkbox.checked ? '[ ]' : '[x]', selection: caretAt(r.to) }
  }
  return null
}
