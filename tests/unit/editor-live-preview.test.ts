// The live preview plan: what is hidden, drawn and styled for a note and a selection (specs/editor.md "Live
// preview", from MarkdownStyler.swift).
import { describe, expect, test } from 'vitest'
import { codeTokens } from '../../src/editor/code-highlight.ts'
import { parseDocument } from '../../src/editor/markdown/document.ts'
import { planPreview, type Mark } from '../../src/editor/preview-plan.ts'
import { corpus } from './support/editor-fixtures.ts'

const at = (p: number) => ({ from: p, to: p })
const NO_CARET = { from: -1, to: -1 }
const plan = (text: string, sel = NO_CARET, raw = false) => planPreview(parseDocument(text), text, sel, raw)
const hidden = (text: string, marks: Mark[]) => marks.flatMap((m) => (m.type === 'hide' ? [text.slice(m.from, m.to)] : []))
const spans = (text: string, marks: Mark[], cls: string) => marks.flatMap((m) => (m.type === 'span' && m.class === cls ? [text.slice(m.from, m.to)] : []))
const lines = (marks: Mark[]) => marks.flatMap((m) => (m.type === 'line' ? [`${m.at}:${m.class}`] : []))

test('heading markers hide away from the caret and show at it', () => {
  const t = '# Title\n\nbody'
  expect(hidden(t, plan(t, at(12)))).toEqual(['# '])
  expect(lines(plan(t, at(12)))).toContain('0:cm-h1')
  const near = plan(t, at(3))
  expect(hidden(t, near)).toEqual([])
  expect(spans(t, near, 'cm-marker')).toEqual(['# '])
})

test('inline markers show only while the caret touches the span', () => {
  const t = 'a **b** c'
  expect(hidden(t, plan(t, at(4)))).toEqual([])
  expect(hidden(t, plan(t, at(0)))).toEqual(['**', '**'])
  // a touch includes the span's ends, as MarkdownStyler's touches(): right after the closing ** shows them
  expect(hidden(t, plan(t, at(7)))).toEqual([])
  expect(hidden(t, plan(t, at(8)))).toEqual(['**', '**'])
  expect(spans(t, plan(t, at(0)), 'cm-strong')).toEqual(['b'])
})

test('a selection reveals only at its two ends', () => {
  const t = '**a** x **b** y **c**'
  const marks = plan(t, { from: 1, to: t.length - 1 })
  expect(hidden(t, marks)).toEqual(['**', '**'])
})

test('fences hide; only the fence line the caret is on shows', () => {
  const t = 'x\n\n```js\nlet a = "s" // c\n```\n\ny'
  const bars = (marks: Mark[]) => marks.flatMap((m) => (m.type === 'codeBar' ? [`${m.at}:${m.language}:${m.active}`] : []))
  const away = plan(t, at(0))
  expect(hidden(t, away)).toEqual(['```js', '```'])
  expect(lines(away).filter((l) => l.includes('cm-fence-hidden')).length).toBe(2)
  expect(spans(t, away, 'cm-tok-keyword')).toEqual(['let'])
  expect(spans(t, away, 'cm-tok-string')).toEqual(['"s"'])
  expect(spans(t, away, 'cm-tok-comment')).toEqual(['// c'])
  expect(bars(away)).toEqual(['9:js:false'])
  // the caret in the content: fences stay hidden, the bar is active
  const inside = plan(t, at(12))
  expect(hidden(t, inside)).toEqual(['```js', '```'])
  expect(bars(inside)).toEqual(['9:js:true'])
  // at the start and end of the content: still hidden
  expect(hidden(t, plan(t, at(9)))).toEqual(['```js', '```'])
  expect(hidden(t, plan(t, at(25)))).toEqual(['```js', '```'])
  // on the opening fence: it shows, and the bar isn't drawn
  const onOpen = plan(t, at(5))
  expect(hidden(t, onOpen)).toEqual(['```'])
  expect(spans(t, onOpen, 'cm-marker')).toEqual(['```js\n'])
  expect(bars(onOpen)).toEqual([])
  // on the closing fence: only it shows
  const onClose = plan(t, at(27))
  expect(hidden(t, onClose)).toEqual(['```js'])
  expect(bars(onClose)).toEqual(['9:js:true'])
})

test('list bullets become a bullet, numbers stay', () => {
  const t = '- one\n  - two\n\n1. three'
  const marks = plan(t, NO_CARET)
  const bullets = marks.filter((m) => m.type === 'bullet')
  expect(bullets.map((m) => t.slice(m.from, m.to))).toEqual(['- ', '- '])
  expect(hidden(t, marks)).toEqual(['  ']) // the nested item's indent: the line class places it
  expect(spans(t, marks, 'cm-list-number')).toEqual(['1. '])
  expect(lines(marks)).toEqual(expect.arrayContaining(['0:cm-list cm-list-d0', '6:cm-list cm-list-d1']))
})

test('a checkbox becomes a box', () => {
  const t = '- [ ] a\n- [x] b'
  const boxes = plan(t, NO_CARET).filter((m) => m.type === 'checkbox')
  expect(boxes).toEqual([
    { type: 'checkbox', from: 0, to: 6, checked: false },
    { type: 'checkbox', from: 8, to: 14, checked: true },
  ])
  expect(spans(t, plan(t, NO_CARET), 'cm-done')).toEqual(['b'])
})

test('quote markers stay hidden, even at the caret', () => {
  const t = '> a\n> b'
  expect(hidden(t, plan(t, at(2)))).toEqual(['> ', '> '])
  expect(lines(plan(t, at(2)))).toEqual(['0:cm-quote cm-quote-d1', '4:cm-quote cm-quote-d1'])
})

test('a rule is drawn', () => {
  const t = 'a\n\n---\n\nb'
  const marks = plan(t, at(4))
  expect(hidden(t, marks)).toEqual(['---'])
  expect(lines(marks)).toContain('3:cm-hr')
})

test('an image alone in its paragraph becomes an image', () => {
  const t = 'x\n\n![Shield](feather://attachment/01JC8ZQ6V4N1XG2H3K5M7P9R0T)'
  const away = plan(t, at(0))
  expect(away.filter((m) => m.type === 'image')).toEqual([{ type: 'image', from: 3, to: t.length, url: 'feather://attachment/01JC8ZQ6V4N1XG2H3K5M7P9R0T', alt: 'Shield' }])
  expect(hidden(t, away)).toEqual([t.slice(3)])
  expect(hidden(t, plan(t, at(t.length)))).toEqual([])
})

test('a remote image stays a link', () => {
  const t = 'x\n\n![x](https://e.com/a.png)'
  const marks = plan(t, at(0))
  expect(marks.some((m) => m.type === 'image')).toBe(false)
  expect(spans(t, marks, 'cm-link')).toEqual(['x'])
  expect(hidden(t, marks)).toEqual(['![', '](https://e.com/a.png)'])
})

test('a feather link becomes a chip', () => {
  const t = 'see [receipt.pdf](feather://attachment/01JC8ZT9HJ2KM3MN4PQ5RS6TV7) now'
  const away = plan(t, at(0))
  expect(away.filter((m) => m.type === 'chip')).toEqual([{ type: 'chip', from: 4, to: t.length - 4, url: 'feather://attachment/01JC8ZT9HJ2KM3MN4PQ5RS6TV7', label: 'receipt.pdf' }])
  const near = plan(t, at(6))
  expect(near.some((m) => m.type === 'chip')).toBe(false)
  expect(spans(t, near, 'cm-marker')).toEqual(['[', '](feather://attachment/01JC8ZT9HJ2KM3MN4PQ5RS6TV7)'])
})

test('tables and HTML are not styled', () => {
  const t = '| **a** | b |\n|---|---|\n| 1 | 2 |\n\n<div>\n*x*\n</div>'
  const marks = plan(t, NO_CARET)
  expect(hidden(t, marks)).toEqual([])
  expect(marks.filter((m) => m.type === 'span')).toEqual([])
  expect(lines(marks).every((l) => l.endsWith('cm-source'))).toBe(true)
})

test('raw mode hides nothing', () => {
  const t = '# T\n\n- [ ] a **b** [l](u)\n\n```\nc\n```\n\n---\n\n> q'
  const marks = plan(t, NO_CARET, true)
  expect(marks.filter((m) => m.type !== 'span' && m.type !== 'line')).toEqual([])
  expect(spans(t, marks, 'cm-marker')).toEqual(expect.arrayContaining(['# ', '**', '[', '](u)', '```\n', '---', '> ']))
})

test('a block over 65,536 characters is left plain', () => {
  const t = '**a** ' + 'x'.repeat(70_000)
  expect(plan(t, NO_CARET)).toEqual([])
})

test('no mark ever covers a character outside the text, and hides never overlap', () => {
  for (const { name, text } of corpus()) {
    const doc = parseDocument(text)
    for (let k = 0; k <= 20; k++) {
      const p = Math.floor((text.length * k) / 20)
      const marks = planPreview(doc, text, at(p), false)
      const replaced = marks.filter((m) => m.type === 'hide' || m.type === 'bullet' || m.type === 'checkbox' || m.type === 'chip').map((m) => m as { from: number; to: number })
      replaced.sort((a, b) => a.from - b.from)
      for (const m of marks) {
        const [from, to] = m.type === 'line' || m.type === 'codeBar' ? [m.at, m.at] : [m.from, m.to]
        expect(from >= 0 && to <= text.length && from <= to, `${name} at ${p}: ${JSON.stringify(m)}`).toBe(true)
      }
      for (let i = 1; i < replaced.length; i++) expect(replaced[i]!.from >= replaced[i - 1]!.to, `${name} at ${p}: overlap`).toBe(true)
    }
  }
})

describe('code colours (CodeHighlighter.swift)', () => {
  test('keywords, strings and comments', () => {
    const kinds = (code: string, lang: string | null) => codeTokens(code, lang).map((t) => `${t.kind}:${code.slice(t.from, t.to)}`)
    expect(kinds('let x = "a\\"b" // hi', null)).toEqual(['keyword:let', 'string:"a\\"b"', 'comment:// hi'])
    expect(kinds('# note\nx', 'python')).toEqual(['comment:# note'])
    expect(kinds('# note', null)).toEqual([])
    expect(kinds('/* a\nb */ return', 'c')).toEqual(['comment:/* a\nb */', 'keyword:return'])
    expect(kinds('letter', null)).toEqual([])
  })
})
