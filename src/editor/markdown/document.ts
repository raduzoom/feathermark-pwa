// A note's parse in the Swift editor's shape (MarkdownSpans.swift, MarkdownParser.swift): leaf blocks, their
// inline spans and the marker ranges the editor hides, as UTF-16 offsets into the text. Built from the Lezer tree
// so the editor's syntax tree and the commands read one parse. Where Lezer and cmark-gfm differ, this file makes
// the result match the Swift parse (specs/editor.md: the Swift code is the reference).
import type { SyntaxNode, Tree } from '@lezer/common'
import { nestingLimit } from './nesting-limit.ts'
import { markdownParser } from './parser.ts'

export { NESTING_DEPTH, nestingLimit } from './nesting-limit.ts'

export type Range = { from: number; to: number }
export type Checkbox = { checked: boolean; range: Range }
export type BlockKind =
  | { kind: 'paragraph' }
  | { kind: 'heading'; level: number }
  | { kind: 'listItem'; ordered: boolean; depth: number; checkbox: Checkbox | null }
  | { kind: 'quote'; depth: number }
  | { kind: 'codeBlock'; language: string | null; content: Range }
  | { kind: 'thematicBreak' }
  | { kind: 'image'; alt: string; url: string; source: Range }
  | { kind: 'unrendered' }
export type InlineKind = 'strong' | 'emphasis' | 'strikethrough' | 'code' | 'html' | { link: string }
export type Inline = { kind: InlineKind; range: Range; markers: Range[] }
export type Block = BlockKind & { range: Range; inlines: Inline[]; markers: Range[] }
export type MarkdownDocument = { blocks: Block[] }

/** A block longer than this (UTF-16 units) is shown as plain Markdown (MarkdownStyler.swift maxStyledBlockLength),
 *  so its inline spans aren't collected: a pasted 2 MB line would otherwise cost seconds on every update. */
export const MAX_STYLED_BLOCK = 65_536

export function parseTree(text: string): Tree {
  return markdownParser.parse(nestingLimit(text))
}

export function parseDocument(text: string): MarkdownDocument {
  return documentFromTree(parseTree(text), text)
}

type Ctx = { quoteDepth: number; listDepth: number; ordered: boolean; pending: { marker: Range; checkbox: Checkbox | null } | null }

const HEADING = /^(?:ATXHeading([1-6])|SetextHeading([12]))$/

/** The blocks of `tree` (parsed from `text`) that overlap [from, to]; the whole note when no range is given. */
export function documentFromTree(tree: Tree, text: string, from = 0, to = text.length): MarkdownDocument {
  const b = new Builder(text, tree)
  const ctx: Ctx = { quoteDepth: 0, listDepth: -1, ordered: false, pending: null }
  for (let child = tree.topNode.firstChild; child; child = child.nextSibling) {
    if (child.to < from) continue
    if (child.from > to) break
    b.visit(child, ctx)
  }
  return { blocks: b.blocks }
}

const isLineBreak = (c: number) => c === 0x0a || c === 0x0d

class Builder {
  blocks: Block[] = []
  private refs: Map<string, string> | null = null

  constructor(
    private readonly text: string,
    private readonly tree: Tree,
  ) {}

  private char(i: number): number | undefined {
    return i >= 0 && i < this.text.length ? this.text.charCodeAt(i) : undefined
  }

  private visitChildren(node: SyntaxNode, ctx: Ctx) {
    let c = { ...ctx }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      this.visit(child, c)
      if (!child.name.endsWith('Mark')) c = { ...c, pending: null } // only the item's first block carries the marker
    }
  }

  visit(node: SyntaxNode, ctx: Ctx) {
    const range = { from: node.from, to: node.to }
    const name = node.name
    if (name === 'BulletList' || name === 'OrderedList') {
      this.visitChildren(node, { ...ctx, listDepth: ctx.listDepth + 1, ordered: name === 'OrderedList' })
      return
    }
    if (name === 'ListItem') return this.listItem(node, ctx)
    if (name === 'Blockquote') return this.visitChildren(node, { ...ctx, quoteDepth: ctx.quoteDepth + 1 })
    const h = HEADING.exec(name)
    if (h) {
      const level = Number(h[1] ?? h[2])
      return this.append({ kind: 'heading', level }, range, this.inlines(node, range), this.headingMarkers(range), ctx)
    }
    if (name === 'Paragraph' || name === 'Task') return this.paragraph(node, range, ctx)
    if (name === 'FencedCode' || name === 'CodeBlock') {
      const [markers, content] = this.fenceMarkers(range)
      const info = node.getChild('CodeInfo')
      const language = info && info.to > info.from ? this.text.slice(info.from, info.to) : null
      return this.append({ kind: 'codeBlock', language, content }, range, [], markers, ctx)
    }
    if (name === 'HorizontalRule') return this.append({ kind: 'thematicBreak' }, range, [], [range], ctx)
    if (name === 'LinkReference') return // cmark keeps no node for a link reference definition
    if (name.endsWith('Mark')) return
    // HTML blocks, tables and anything else are shown as plain source (Swift's `default:`)
    this.append({ kind: 'unrendered' }, range, [], [], ctx)
  }

  private listItem(node: SyntaxNode, ctx: Ctx) {
    const content: SyntaxNode[] = []
    for (let c = node.firstChild; c; c = c.nextSibling) if (c.name !== 'ListMark') content.push(c)
    const first = content[0]
    let contentStart = node.to
    let checkbox: Checkbox | null = null
    if (first?.name === 'Task') {
      const tm = first.getChild('TaskMarker')
      if (tm) {
        const mark = this.text.charCodeAt(tm.from + 1)
        checkbox = { checked: mark === 0x78 || mark === 0x58, range: { from: tm.from, to: tm.to } }
        contentStart = tm.to
        while (contentStart < first.to && (this.char(contentStart) === 0x20 || this.char(contentStart) === 0x09)) contentStart++
      } else contentStart = first.from
    } else if (first) contentStart = first.from
    const marker = { from: node.from, to: Math.max(node.from, contentStart) }
    if (!first) {
      this.blocks.push({ kind: 'listItem', ordered: ctx.ordered, depth: ctx.listDepth, checkbox, range: { from: node.from, to: node.to }, inlines: [], markers: [marker] })
      return
    }
    content.forEach((child, i) => this.visit(child, { ...ctx, pending: i === 0 ? { marker, checkbox } : null }))
  }

  private paragraph(node: SyntaxNode, range: Range, ctx: Ctx) {
    if (node.name === 'Task') {
      const tm = node.getChild('TaskMarker')
      let start = tm ? tm.to : node.from
      while (start < node.to && (this.char(start) === 0x20 || this.char(start) === 0x09)) start++
      range = { from: start, to: node.to }
    }
    const image = node.name === 'Paragraph' ? this.soleImage(node) : null
    if (image) {
      const url = this.linkUrl(image)
      if (url !== null) {
        const close = this.closeBracket(image)
        return this.append({ kind: 'image', alt: this.plainText(image, image.from + 2, close), url, source: { from: image.from, to: image.to } }, range, [], [], ctx)
      }
    }
    this.append({ kind: 'paragraph' }, range, this.inlines(node, range), [], ctx)
  }

  /** Adds a leaf block, turning it into a list item or quote block when the context says so. */
  private append(kind: BlockKind, range: Range, inlines: Inline[], markers: Range[], ctx: Ctx) {
    if (ctx.pending) {
      const r = { from: ctx.pending.marker.from, to: range.to }
      const k: BlockKind = kind.kind === 'paragraph' ? { kind: 'listItem', ordered: ctx.ordered, depth: ctx.listDepth, checkbox: ctx.pending.checkbox } : kind
      this.blocks.push({ ...k, range: r, inlines, markers: [ctx.pending.marker, ...markers] })
      return
    }
    if (ctx.quoteDepth > 0 && kind.kind === 'paragraph') {
      this.blocks.push({ kind: 'quote', depth: ctx.quoteDepth, range, inlines, markers: this.quotePrefixes(range) })
      return
    }
    this.blocks.push({ ...kind, range, inlines, markers })
  }

  // Markers

  private headingMarkers(range: Range): Range[] {
    if (this.char(range.from) !== 0x23) {
      // setext: the underline line
      const s = this.text.slice(range.from, range.to)
      let last = -1
      for (let i = s.length - 1; i >= 0; i--)
        if (isLineBreak(s.charCodeAt(i))) {
          last = i
          break
        }
      if (last < 0) return []
      return [{ from: range.from + last + 1, to: range.to }]
    }
    let i = range.from
    while (this.char(i) === 0x23) i++
    while (i < range.to && (this.char(i) === 0x20 || this.char(i) === 0x09)) i++
    return [{ from: range.from, to: i }]
  }

  /** "> " prefixes on each line of a quoted paragraph. */
  private quotePrefixes(range: Range): Range[] {
    const out: Range[] = []
    let lineStart = range.from
    while (lineStart > 0) {
      const c = this.char(lineStart - 1)!
      if (isLineBreak(c)) break
      lineStart--
    }
    while (lineStart < range.to) {
      let i = lineStart
      for (let c = this.char(i); c === 0x20 || c === 0x3e || c === 0x09; c = this.char(i)) i++
      if (i > lineStart) out.push({ from: lineStart, to: i })
      let e = i
      for (let c = this.char(e); c !== undefined && !isLineBreak(c); c = this.char(e)) e++
      for (let c = this.char(e); c !== undefined && isLineBreak(c); c = this.char(e)) e++
      if (e === lineStart) break
      lineStart = e
    }
    return out
  }

  /** Opening fence line (with its line break) and closing fence line, and the content between. */
  private fenceMarkers(range: Range): [Range[], Range] {
    const s = this.text.slice(range.from, range.to)
    const trimmed = s.replace(/^[ \t]+/, '')
    if (!(s.startsWith('```') || s.startsWith('~~~') || trimmed.startsWith('```') || trimmed.startsWith('~~~'))) return [[], range] // indented code
    let firstBreak = -1
    for (let i = 0; i < s.length; i++)
      if (isLineBreak(s.charCodeAt(i))) {
        firstBreak = i
        break
      }
    if (firstBreak < 0) return [[range], { from: range.to, to: range.to }]
    let openEnd = firstBreak + 1
    if (s.charCodeAt(firstBreak) === 0x0d && openEnd < s.length && s.charCodeAt(openEnd) === 0x0a) openEnd++
    const open = { from: range.from, to: range.from + openEnd }
    const fenceChar = trimmed[0]!
    let lastBreak = -1
    for (let i = s.length - 1; i >= 0; i--)
      if (isLineBreak(s.charCodeAt(i))) {
        lastBreak = i
        break
      }
    if (lastBreak >= 0 && lastBreak >= openEnd - 1) {
      const lastLine = s.slice(lastBreak + 1).replace(/^[ \t]+|[ \t]+$/g, '')
      if (lastLine.length >= 3 && [...lastLine].every((c) => c === fenceChar)) {
        const closeStart = range.from + lastBreak + 1
        return [[open, { from: closeStart, to: range.to }], { from: open.to, to: closeStart }]
      }
    }
    return [[open], { from: open.to, to: range.to }]
  }

  // Inlines

  private soleImage(p: SyntaxNode): SyntaxNode | null {
    const c = p.firstChild
    return c && c.name === 'Image' && !c.nextSibling && c.from === p.from && c.to === p.to ? c : null
  }

  /** Inline spans of a leaf block, kept only when they lie inside it and every marker is really a delimiter. */
  private inlines(node: SyntaxNode, block: Range): Inline[] {
    if (block.to - block.from > MAX_STYLED_BLOCK) return []
    const out: Inline[] = []
    this.collect(node, out)
    return out.filter((i) => i.range.from >= block.from && i.range.to <= block.to && this.valid(i))
  }

  private valid(i: Inline): boolean {
    const parts = i.markers.map((m) => this.text.slice(m.from, m.to))
    const all = (s: string, ch: string) => s.length > 0 && [...s].every((c) => c === ch)
    switch (i.kind) {
      case 'strong':
        return parts.length === 2 && parts.every((p) => p === '**' || p === '__')
      case 'emphasis':
        return parts.length === 2 && parts.every((p) => p === '*' || p === '_')
      case 'strikethrough':
        return parts.length === 2 && parts.every((p) => all(p, '~'))
      case 'code':
        return parts.length === 2 && parts.every((p) => all(p, '`'))
      case 'html':
        return this.text.startsWith('<', i.range.from)
      default:
        return parts.length === 2 && (parts[0] === '[' || parts[0] === '![') && parts[1]!.startsWith(']')
    }
  }

  private collect(node: SyntaxNode, out: Inline[]) {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      const r = { from: child.from, to: child.to }
      switch (child.name) {
        case 'StrongEmphasis':
          out.push({ kind: 'strong', range: r, markers: ends(r, 2) })
          break
        case 'Emphasis':
          out.push({ kind: 'emphasis', range: r, markers: ends(r, 1) })
          break
        case 'Strikethrough':
          out.push({ kind: 'strikethrough', range: r, markers: ends(r, Math.max(1, this.run(r.from, 0x7e))) })
          break
        case 'InlineCode':
          out.push({ kind: 'code', range: r, markers: ends(r, Math.max(1, this.run(r.from, 0x60))) })
          break
        case 'Link':
        case 'Image': {
          const url = this.linkUrl(child)
          if (url !== null) out.push({ kind: { link: url }, range: r, markers: [{ from: r.from, to: r.from + (child.name === 'Image' ? 2 : 1) }, { from: this.closeBracket(child), to: r.to }] })
          break
        }
        case 'HTMLTag':
        case 'Comment':
        case 'ProcessingInstruction':
          out.push({ kind: 'html', range: r, markers: [] })
          break
      }
      this.collect(child, out)
    }
  }

  private run(at: number, ch: number): number {
    let n = 0
    while (this.char(at + n) === ch) n++
    return n
  }

  /** The "]" that ends a link's text (the second LinkMark), or the end of the opener when there is none. */
  private closeBracket(link: SyntaxNode): number {
    for (let c = link.firstChild; c; c = c.nextSibling) if (c.name === 'LinkMark' && this.text.charCodeAt(c.from) === 0x5d) return c.from
    return link.from + (link.name === 'Image' ? 2 : 1)
  }

  /** The link's destination; null when it is a reference with no definition (cmark then sees plain text). */
  private linkUrl(link: SyntaxNode): string | null {
    let inline = false
    let label: SyntaxNode | null = null
    for (let c = link.firstChild; c; c = c.nextSibling) {
      if (c.name === 'LinkMark' && this.text.charCodeAt(c.from) === 0x28) inline = true
      if (c.name === 'LinkLabel') label = c
    }
    if (inline) {
      const u = link.getChild('URL')
      if (!u) return ''
      const url = this.text.slice(u.from, u.to)
      return url.startsWith('<') && url.endsWith('>') ? url.slice(1, -1) : url
    }
    const close = this.closeBracket(link)
    let key = this.text.slice(link.from + (link.name === 'Image' ? 2 : 1), close)
    if (label && label.to - label.from > 2) key = this.text.slice(label.from + 1, label.to - 1)
    return this.references().get(normalizeLabel(key)) ?? null
  }

  private references(): Map<string, string> {
    if (this.refs) return this.refs
    const refs = new Map<string, string>()
    const containers = new Set(['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem'])
    this.tree.iterate({
      enter: (n) => {
        if (n.name === 'LinkReference') {
          const label = n.node.getChild('LinkLabel')
          const url = n.node.getChild('URL')
          if (label && url) {
            const key = normalizeLabel(this.text.slice(label.from + 1, label.to - 1))
            let u = this.text.slice(url.from, url.to)
            if (u.startsWith('<') && u.endsWith('>')) u = u.slice(1, -1)
            if (!refs.has(key)) refs.set(key, u) // the first definition wins
          }
          return false
        }
        return containers.has(n.name)
      },
    })
    this.refs = refs
    return refs
  }

  /** An image's alt text without its inline markers, as cmark's plainText gives it. */
  private plainText(node: SyntaxNode, from: number, to: number): string {
    const skip: Range[] = []
    const walk = (n: SyntaxNode) => {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.from >= from && c.to <= to && (c.name.endsWith('Mark') || c.name === 'Escape')) skip.push({ from: c.from, to: c.name === 'Escape' ? c.from + 1 : c.to })
        walk(c)
      }
    }
    walk(node)
    skip.sort((a, b) => a.from - b.from)
    let out = ''
    let at = from
    for (const s of skip) {
      if (s.from < at) continue
      out += this.text.slice(at, s.from)
      at = s.to
    }
    return out + this.text.slice(at, to)
  }
}

function ends(r: Range, n: number): Range[] {
  if (r.to - r.from < 2 * n) return []
  return [
    { from: r.from, to: r.from + n },
    { from: r.to - n, to: r.to },
  ]
}

function normalizeLabel(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase()
}
