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

/** The code bar's language menu (specs/editor.md "Code bar"): `[label, id]`, the id written as the info string. */
export const CODE_LANGUAGES: readonly (readonly [string, string])[] = [
  ['Plain text', ''], ['Bash', 'bash'], ['C', 'c'], ['C++', 'cpp'], ['C#', 'csharp'], ['CSS', 'css'], ['Go', 'go'],
  ['HTML', 'html'], ['Java', 'java'], ['JavaScript', 'javascript'], ['JSON', 'json'], ['Kotlin', 'kotlin'],
  ['Markdown', 'markdown'], ['PHP', 'php'], ['Python', 'python'], ['Ruby', 'ruby'], ['Rust', 'rust'], ['SQL', 'sql'],
  ['Swift', 'swift'], ['TypeScript', 'typescript'], ['YAML', 'yaml'],
]

/** Replaces the info string of the fenced code block holding `at` with `language` ("" for none); the caret stays. */
export function setCodeLanguage(text: string, doc: MarkdownDocument, at: number, language: string, sel: Selection): Edit | null {
  for (const b of doc.blocks) {
    if (at < b.range.from || at > b.range.to || b.kind !== 'codeBlock') continue
    const open = b.markers[0]
    if (!open) return null
    const l = line(text, open.from)
    const fence = /^[ \t]*(`{3,}|~{3,})/.exec(l.text)
    if (!fence) return null
    const from = l.from + fence[0].length
    if (text.slice(from, l.to) === language) return null
    const shift = (p: number) => (p <= from ? p : p >= l.to ? p - (l.to - from) + language.length : from + language.length)
    return { from, to: l.to, insert: language, selection: { from: shift(sel.from), to: shift(sel.to) } }
  }
  return null
}

/** Backspace at the start of a fenced block's content, or Delete at its end, would join a hidden fence line: an
 *  edit that does nothing, or, for Backspace in a block of blank lines, one that removes the block. */
export function codeFenceGuard(text: string, doc: MarkdownDocument, sel: Selection, key: 'backspace' | 'delete'): Edit | null {
  if (sel.to !== sel.from) return null
  const p = sel.from
  for (const b of doc.blocks) {
    if (b.kind !== 'codeBlock' || b.markers.length === 0 || p < b.range.from || p > b.range.to) continue
    const c = b.content
    if (key === 'backspace' && p === c.from) {
      if (/^[\s]*$/.test(text.slice(c.from, c.to))) return { from: b.range.from, to: b.range.to, insert: '', selection: caretAt(b.range.from) }
      return { from: p, to: p, insert: '', selection: caretAt(p) }
    }
    let end = c.to
    while (end > c.from && (text.charCodeAt(end - 1) === 0x0a || text.charCodeAt(end - 1) === 0x0d)) end--
    if (key === 'delete' && b.markers.length === 2 && p === end && c.to > c.from) return { from: p, to: p, insert: '', selection: caretAt(p) }
  }
  return null
}
