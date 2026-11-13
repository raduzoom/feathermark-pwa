// What live preview hides, draws and styles for a note and its selection: a pure function of the parse, the text
// and the selection (MarkdownStyler.swift; specs/editor.md "Live preview"). It never changes the text: hidden
// characters are only hidden. live-preview.ts turns the marks into CodeMirror decorations.
import { codeTokens } from './code-highlight.ts'
import { MAX_STYLED_BLOCK, type Block, type MarkdownDocument, type Range } from './markdown/document.ts'

export type Mark =
  | { type: 'hide'; from: number; to: number }
  | { type: 'line'; at: number; class: string }
  | { type: 'span'; from: number; to: number; class: string }
  | { type: 'bullet'; from: number; to: number }
  | { type: 'checkbox'; from: number; to: number; checked: boolean }
  | { type: 'image'; from: number; to: number; url: string; alt: string }
  | { type: 'chip'; from: number; to: number; url: string; label: string }
  /** A fenced code block's bar (language menu and Copy), drawn on its first content line. */
  | { type: 'codeBar'; at: number; language: string | null; active: boolean }

const ATTACHMENT = 'feather://attachment/'
export const isAttachmentUrl = (url: string) => url.toLowerCase().startsWith(ATTACHMENT)

type Sel = { from: number; to: number }

export function planPreview(doc: MarkdownDocument, text: string, sel: Sel, raw: boolean): Mark[] {
  const out: Mark[] = []
  // Markers show where the caret is: at the selection's two ends, not across everything it covers.
  const touches = (r: Range) => (r.from <= sel.from && sel.from <= r.to) || (r.from <= sel.to && sel.to <= r.to)
  for (const b of doc.blocks) {
    if (b.range.to - b.range.from > MAX_STYLED_BLOCK) continue
    if (raw) planRaw(b, text, out)
    else planLive(b, text, touches, out)
  }
  return out
}

const isBreak = (c: number) => c === 0x0a || c === 0x0d

function lineStart(text: string, p: number): number {
  let s = p
  while (s > 0 && !isBreak(text.charCodeAt(s - 1))) s--
  return s
}

/** The start of every line `r` touches. */
function lineStarts(text: string, r: Range): number[] {
  const out = [lineStart(text, r.from)]
  for (let i = r.from; i + 1 < r.to; i++) {
    const c = text.charCodeAt(i)
    if (c === 0x0d && text.charCodeAt(i + 1) === 0x0a) continue
    if (isBreak(c)) out.push(i + 1)
  }
  return out
}

/** A marker range without its trailing line break (CodeMirror can't hide a line break from a view plugin). */
function withoutBreak(text: string, r: Range): Range {
  let to = r.to
  while (to > r.from && isBreak(text.charCodeAt(to - 1))) to--
  return { from: r.from, to }
}

function planRaw(b: Block, text: string, out: Mark[]) {
  if (b.kind === 'heading') out.push({ type: 'line', at: lineStart(text, b.range.from), class: 'cm-raw-heading' })
  for (const i of b.inlines) if (i.kind === 'strong') out.push({ type: 'span', from: i.range.from, to: i.range.to, class: 'cm-strong' })
  for (const m of [...b.markers, ...b.inlines.flatMap((i) => i.markers)]) if (m.to > m.from) out.push({ type: 'span', ...m, class: 'cm-marker' })
  if (b.kind === 'listItem' && b.checkbox) out.push({ type: 'span', ...b.checkbox.range, class: 'cm-marker' })
}

function planLive(b: Block, text: string, touches: (r: Range) => boolean, out: Mark[]) {
  const hide = (r: Range) => {
    const h = withoutBreak(text, r)
    if (h.to > h.from) out.push({ type: 'hide', ...h })
  }
  const reveal = (r: Range) => {
    if (r.to > r.from) out.push({ type: 'span', ...r, class: 'cm-marker' })
  }
  const lineClass = (r: Range, cls: string) => {
    for (const at of lineStarts(text, r)) out.push({ type: 'line', at, class: cls })
  }

  switch (b.kind) {
    case 'paragraph':
      break
    case 'heading': {
      lineClass(b.range, `cm-h${b.level}`)
      const shown = touches(b.range)
      for (const m of b.markers) (shown ? reveal : hide)(m)
      break
    }
    case 'listItem': {
      const start = lineStart(text, b.range.from)
      lineClass({ from: start, to: b.range.to }, `cm-list cm-list-d${Math.min(b.depth, 8)}`)
      // a nested item's leading spaces: the line class places it instead
      if (start < b.range.from) out.push({ type: 'hide', from: start, to: b.range.from })
      const m = b.markers[0]
      if (b.ordered) {
        if (m) out.push({ type: 'span', ...m, class: 'cm-list-number' })
      } else if (b.checkbox) {
        if (m) out.push({ type: 'checkbox', ...m, checked: b.checkbox.checked })
        if (b.checkbox.checked && m && b.range.to > m.to) out.push({ type: 'span', from: m.to, to: b.range.to, class: 'cm-done' })
      } else if (m && m.to > m.from) out.push({ type: 'bullet', ...m })
      break
    }
    case 'quote':
      lineClass(b.range, `cm-quote cm-quote-d${Math.min(b.depth, 8)}`)
      for (const m of b.markers) hide(m)
      break
    case 'codeBlock': {
      const starts = lineStarts(text, b.range)
      starts.forEach((at, i) => out.push({ type: 'line', at, class: `cm-code${i === 0 ? ' cm-code-first' : ''}${i === starts.length - 1 ? ' cm-code-last' : ''}` }))
      for (const t of codeTokens(text.slice(b.content.from, b.content.to), b.language)) {
        out.push({ type: 'span', from: b.content.from + t.from, to: b.content.from + t.to, class: `cm-tok-${t.kind}` })
      }
      // only the fence line the caret is on shows
      let openShown = false
      b.markers.forEach((m, i) => {
        if (touches(withoutBreak(text, m))) {
          reveal(m)
          if (i === 0) openShown = true
        } else {
          hide(m)
          out.push({ type: 'line', at: lineStart(text, m.from), class: 'cm-fence-hidden' })
        }
      })
      if (b.markers.length > 0 && !openShown && b.content.to > b.content.from) {
        out.push({ type: 'line', at: b.content.from, class: 'cm-code-head' })
        out.push({ type: 'codeBar', at: b.content.from, language: b.language, active: touches(b.range) })
      }
      return // no inline styling inside code
    }
    case 'thematicBreak':
      out.push({ type: 'line', at: lineStart(text, b.range.from), class: 'cm-hr' })
      hide(b.range)
      break
    case 'image':
      if (isAttachmentUrl(b.url)) {
        out.push({ type: 'image', from: b.source.from, to: b.source.to, url: b.url, alt: b.alt })
        ;(touches(b.range) ? reveal : hide)(b.source)
      } else {
        // a remote image is never loaded: it shows as a link
        const close = text.indexOf(']', b.source.from + 2)
        const markers = [
          { from: b.source.from, to: b.source.from + 2 },
          { from: close < 0 || close > b.source.to ? b.source.to : close, to: b.source.to },
        ]
        out.push({ type: 'span', from: markers[0]!.to, to: markers[1]!.from, class: 'cm-link' })
        for (const m of markers) (touches(b.source) ? reveal : hide)(m)
      }
      return
    case 'unrendered':
      lineClass(b.range, 'cm-source')
      return
  }
  planInlines(b, text, touches, out, hide, reveal)
}

function planInlines(b: Block, text: string, touches: (r: Range) => boolean, out: Mark[], hide: (r: Range) => void, reveal: (r: Range) => void) {
  const chips: Range[] = []
  for (const i of b.inlines) {
    const open = i.markers[0]
    const close = i.markers[i.markers.length - 1]
    const content = { from: open ? open.to : i.range.from, to: close && i.markers.length > 1 ? close.from : i.range.to }
    if (i.kind === 'html') {
      out.push({ type: 'span', ...i.range, class: 'cm-html' })
      continue
    }
    if (typeof i.kind === 'object') {
      if (isAttachmentUrl(i.kind.link) && !touches(i.range)) {
        out.push({ type: 'chip', from: i.range.from, to: i.range.to, url: i.kind.link, label: text.slice(content.from, content.to) })
        chips.push(i.range)
        continue
      }
      out.push({ type: 'span', ...content, class: isAttachmentUrl(i.kind.link) ? 'cm-chip-text' : 'cm-link' })
    } else {
      const cls = { strong: 'cm-strong', emphasis: 'cm-em', strikethrough: 'cm-strike', code: 'cm-code-inline' }[i.kind]
      if (content.to > content.from) out.push({ type: 'span', ...content, class: cls })
    }
  }
  const inChip = (r: Range) => chips.some((c) => r.from >= c.from && r.to <= c.to)
  for (const i of b.inlines) {
    if (i.kind === 'html' || inChip(i.range)) continue
    for (const m of i.markers) (touches(i.range) ? reveal : hide)(m)
  }
  // spans inside a chip are drawn by the chip
  for (let k = out.length - 1; k >= 0; k--) {
    const m = out[k]!
    if ((m.type === 'span' || m.type === 'hide') && inChip(m) && chips.length) out.splice(k, 1)
  }
}
