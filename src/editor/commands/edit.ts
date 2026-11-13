// Shared pieces of the editor commands, ported line for line from EditorCommands.swift (apple d49c0a6). Offsets
// are UTF-16 code units, as NSString's are, so the arithmetic is unchanged.
import type { MarkdownDocument, Range } from '../markdown/document.ts'

export type Selection = { from: number; to: number }
/** Replace [from, to) with `insert`; then select `selection` (in the new text). */
export type Edit = { from: number; to: number; insert: string; selection: Selection }
/** A line without its ending ("\n", "\r\n", "\r" or ""). */
export type Line = { from: number; to: number; ending: string; text: string }

export function applyEdit(text: string, e: Edit): string {
  return text.slice(0, e.from) + e.insert + text.slice(e.to)
}

const isBreak = (c: number) => c === 0x0a || c === 0x0d

export function line(s: string, p: number): Line {
  let start = Math.min(p, s.length)
  while (start > 0 && !isBreak(s.charCodeAt(start - 1))) start--
  let end = start
  while (end < s.length && !isBreak(s.charCodeAt(end))) end++
  let ending = ''
  if (end < s.length) ending = s.charCodeAt(end) === 0x0d && end + 1 < s.length && s.charCodeAt(end + 1) === 0x0a ? '\r\n' : s.charCodeAt(end) === 0x0d ? '\r' : '\n'
  return { from: start, to: end, ending, text: s.slice(start, end) }
}

export function previousEnding(s: string, lineStart: number): string {
  if (lineStart <= 0) return '\n'
  if (lineStart >= 2 && s.charCodeAt(lineStart - 2) === 0x0d && s.charCodeAt(lineStart - 1) === 0x0a) return '\r\n'
  return s.charCodeAt(lineStart - 1) === 0x0d ? '\r' : '\n'
}

/** Swift's `trimmingCharacters(in: .whitespaces).isEmpty`: only spaces (Zs) and tabs. */
export const isBlank = (s: string) => /^[\p{Zs}\t]*$/u.test(s)

export const leadingWhitespace = (s: string) => /^[ \t]*/.exec(s)![0]

/** A list item's first line: indentation, bullet ("-", "1."), spacing and checkbox. */
export type ItemMarker = { indent: string; bullet: string; spacing: string; checkbox: string | null }
export const markerLength = (m: ItemMarker) => (m.indent + m.bullet + m.spacing + (m.checkbox ?? '')).length
export const bulletWidth = (m: ItemMarker) => m.bullet.length + 1

export const ITEM_PATTERN = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)(\[[ xX]\][ \t]+|\[[ xX]\]$)?/

export function itemMarker(l: Line): ItemMarker | null {
  const m = ITEM_PATTERN.exec(l.text)
  if (!m) return null
  return { indent: m[1] ?? '', bullet: m[2] ?? '-', spacing: m[3] ?? '', checkbox: m[4] ?? null }
}

export function codeContent(doc: MarkdownDocument, p: number): Range | null {
  for (const b of doc.blocks) {
    if (b.kind !== 'codeBlock') continue
    const c = b.content
    if (p >= c.from && p <= c.to && (c.to > c.from || p === c.from)) return c
  }
  return null
}

export function nextBullet(bullet: string): string {
  const last = bullet[bullet.length - 1]
  if (last !== '.' && last !== ')') return bullet
  const n = Number(bullet.slice(0, -1))
  if (!Number.isInteger(n) || bullet.length < 2) return bullet
  return `${n + 1}${last}`
}

export function previousItem(s: string, lineStart: number): ItemMarker | null {
  let start = lineStart
  while (start > 0) {
    const prev = line(s, start - 1)
    if (isBlank(prev.text)) return null
    const m = itemMarker(prev)
    if (m) return m
    start = prev.from
  }
  return null
}
