// A note as a Markdown file: data-model.md "Export to a Markdown folder" (front matter, file names), as FeatherCore's
// FrontMatter.swift and FileNames.swift write them.
import { nameOrder } from './names.ts'
import type { Note } from './types.ts'

const INDICATORS = new Set(['-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', "'", '"', '%', '@', '`'])
const KEYWORDS = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'null', '~'])
// What Swift's Double(String) accepts: decimal and hex floats, inf, infinity and nan.
const NUMBER = /^[+-]?(\d+\.?\d*(e[+-]?\d+)?|\.\d+(e[+-]?\d+)?|inf(inity)?|nan|0x[0-9a-f]*\.?[0-9a-f]*(p[+-]?\d+)?)$/i

function needsQuotes(s: string): boolean {
  if (s === '') return true
  if (/^\s|\s$/u.test(s)) return true
  if (INDICATORS.has(s[0]!)) return true
  if (s.includes(': ') || s.includes(' #') || s.endsWith(':')) return true
  if (KEYWORDS.has(s.toLowerCase())) return true
  if (NUMBER.test(s) && /[0-9]|inf|nan/i.test(s)) return true
  return /\p{Cc}/u.test(s)
}

function quoted(s: string): string {
  let out = '"'
  for (const ch of s) {
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\t') out += '\\t'
    else if (ch === '\r') out += '\\r'
    else if (/\p{Cc}/u.test(ch)) out += '\\u' + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')
    else out += ch
  }
  return out + '"'
}

const scalar = (s: string) => (needsQuotes(s) ? quoted(s) : s)
const tagItem = (s: string) => (needsQuotes(s) || /[,[\]{}'"]/.test(s) ? quoted(s) : s)
const timestamp = (ms: number) => new Date(ms).toISOString()

export function frontMatter(note: Note, tagNames: string[]): string {
  const tags = [...tagNames].sort(nameOrder)
  return [
    '---',
    `feather_id: ${note.id}`,
    `title: ${scalar(note.title)}`,
    `created: ${timestamp(note.created)}`,
    `modified: ${timestamp(note.modified)}`,
    `tags: [${tags.map(tagItem).join(', ')}]`,
    `pinned: ${note.pinned}`,
    '---',
  ].join('\n') + '\n\n'
}

export function noteMarkdown(note: Note, tagNames: string[]): string {
  return frontMatter(note, tagNames) + note.body
}

const FORBIDDEN = /[/\\:*?"<>|\p{Cc}]/gu
const RESERVED = new Set(['con', 'prn', 'aux', 'nul', ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((i) => [`com${i}`, `lpt${i}`])])
const MAX_BYTES = 200
const trimSpacesAndDots = (s: string) => s.replace(/^[ .]+|[ .]+$/g, '')

export function sanitizeFileName(name: string): string {
  let out = trimSpacesAndDots(name.replace(FORBIDDEN, '-'))
  if (RESERVED.has(out.split('.')[0]!.toLowerCase())) out += '-'
  const encoder = new TextEncoder()
  if (encoder.encode(out).length > MAX_BYTES) {
    let cut = ''
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(out)) {
      if (encoder.encode(cut + segment).length > MAX_BYTES) break
      cut += segment
    }
    out = trimSpacesAndDots(cut)
  }
  return out === '' ? 'Untitled' : out
}

export function noteFileName(note: Note): string {
  return sanitizeFileName(note.title.trim() === '' ? 'Untitled' : note.title) + '.md'
}
