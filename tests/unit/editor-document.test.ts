// Ported by hand from ParserTests.swift and NestingLimitTests.swift (apple d49c0a6): the web parse must give
// the Swift parse's blocks, inlines and markers, as UTF-16 ranges.
import { describe, expect, test } from 'vitest'
import { documentFromTree, nestingLimit, NESTING_DEPTH, parseDocument, parseTree, type Block, type Range } from '../../src/editor/markdown/document.ts'
import { corpus } from './support/editor-fixtures.ts'

const sub = (t: string, r: Range) => t.slice(r.from, r.to)
const blocks = (t: string) => parseDocument(t).blocks
const isItem = (b: Block) => b.kind === 'listItem'

test('headingsLevels1To6', () => {
  const t = '# A\n\n###### F\n\n#NoSpace'
  const b = blocks(t)
  expect(b.length).toBe(3)
  expect(b[0]).toMatchObject({ kind: 'heading', level: 1 })
  expect(b[0]!.markers.map((m) => sub(t, m))).toEqual(['# '])
  expect(b[1]).toMatchObject({ kind: 'heading', level: 6 })
  expect(b[2]!.kind).toBe('paragraph')
})

test('emphasisVariants', () => {
  const cases: Array<[string, string, string[]]> = [
    ['**b**', 'strong', ['**', '**']], ['__b__', 'strong', ['__', '__']], ['*i*', 'emphasis', ['*', '*']],
    ['_i_', 'emphasis', ['_', '_']], ['~~s~~', 'strikethrough', ['~~', '~~']], ['`c`', 'code', ['`', '`']],
  ]
  for (const [t, kind, markers] of cases) {
    const inl = blocks(t)[0]!.inlines
    expect(inl.length, t).toBe(1)
    expect(inl[0]!.kind, t).toBe(kind)
    expect(inl[0]!.markers.map((m) => sub(t, m)), t).toEqual(markers)
    expect(sub(t, inl[0]!.range)).toBe(t)
  }
  expect(blocks('**unclosed')[0]!.inlines).toEqual([])
})

test('nestedEmphasis', () => {
  const t = '***bi***'
  const inl = blocks(t)[0]!.inlines
  expect(new Set(inl.map((i) => i.kind))).toEqual(new Set(['strong', 'emphasis']))
  expect(inl.flatMap((i) => i.markers).map((m) => sub(t, m)).join('')).toBe('******')
})

test('linksAndImages', () => {
  const t = 'see [t](u) ok'
  const link = blocks(t)[0]!.inlines[0]!
  expect(link.kind).toEqual({ link: 'u' })
  expect(link.markers.map((m) => sub(t, m))).toEqual(['[', '](u)'])
  const img = '![a](feather://attachment/01JC8ZQ6V4N1XG2H3K5M7P9R0T)'
  expect(blocks(img)[0]).toMatchObject({ kind: 'image', alt: 'a', url: 'feather://attachment/01JC8ZQ6V4N1XG2H3K5M7P9R0T', source: { from: 0, to: img.length } })
  expect(blocks('text ![a](x.png)')[0]!.kind).toBe('paragraph')
})

test('listsAndTasks', () => {
  const t = '- a\n* b\n\n+ c\n\n1. d\n   - e\n\n- [ ] t\n- [x] u'
  const items = blocks(t).filter(isItem)
  expect(items.length).toBe(7)
  expect(items[0]).toMatchObject({ kind: 'listItem', ordered: false, depth: 0, checkbox: null })
  expect(items[0]!.markers.map((m) => sub(t, m))).toEqual(['- '])
  expect(items[3]).toMatchObject({ kind: 'listItem', ordered: true, depth: 0, checkbox: null })
  expect(items[3]!.markers.map((m) => sub(t, m))).toEqual(['1. '])
  expect(items[4]).toMatchObject({ kind: 'listItem', ordered: false, depth: 1, checkbox: null })
  const [i5, i6] = [items[5]!, items[6]!]
  if (i5.kind !== 'listItem' || i6.kind !== 'listItem') throw new Error('items')
  expect(i5.checkbox?.checked).toBe(false)
  expect(i6.checkbox?.checked).toBe(true)
  expect(sub(t, i5.checkbox!.range)).toBe('[ ]')
  expect(sub(t, i6.checkbox!.range)).toBe('[x]')
  expect(i5.markers.map((m) => sub(t, m))).toEqual(['- [ ] '])
})

test('quotesNested', () => {
  const q = blocks('> a\n>\n> > b').flatMap((b) => (b.kind === 'quote' ? [b.depth] : []))
  expect(q).toEqual([1, 2])
})

test('fencesWithLanguage', () => {
  const t = '```swift\nlet x = 1\n```\n\n~~~\nraw\n~~~'
  const b = blocks(t)
  if (b[0]!.kind !== 'codeBlock' || b[1]!.kind !== 'codeBlock') throw new Error('code')
  expect(b[0]!.language).toBe('swift')
  expect(sub(t, b[0]!.content)).toBe('let x = 1\n')
  expect(b[0]!.markers.map((m) => sub(t, m))).toEqual(['```swift\n', '```'])
  expect(b[1]!.language).toBe(null)
  expect(blocks('```\nnever closed\n\n# not a heading').length).toBe(1)
})

test('thematicBreaks', () => {
  for (const t of ['---', '***', '___']) expect(blocks('a\n\n' + t)[1]!.kind, t).toBe('thematicBreak')
  expect(blocks('Title\n---')[0]).toMatchObject({ kind: 'heading', level: 2 })
})

test('tablesAndHTMLAreUnrendered', () => {
  expect(blocks('| a | b |\n|---|---|\n| 1 | 2 |')[0]!.kind).toBe('unrendered')
  expect(blocks('<div>\nx\n</div>')[0]!.kind).toBe('unrendered')
  expect(blocks('a <b>c</b>')[0]!.inlines.some((i) => i.kind === 'html')).toBe(true)
  expect(blocks('| a | b |\n|---|---|\n| 1 | 2 |')[0]!.inlines).toEqual([])
})

test('rangesAreUTF16', () => {
  const t = '😀 **é**\r\n\r\n# Café'
  const b = blocks(t)
  expect(sub(t, b[0]!.inlines[0]!.range)).toBe('**é**')
  expect(sub(t, b[1]!.range).startsWith('# Café')).toBe(true)
  expect(b[1]).toMatchObject({ kind: 'heading', level: 1 })
})

test('everyInlineMarkerIsARealDelimiter', () => {
  const lazy = '- item\nlazy `code` and **bold**\n\n> quote\nlazy *em* line'
  for (const { name, text } of [...corpus(), { name: 'lazy', text: lazy }]) {
    for (const b of parseDocument(text).blocks) {
      for (const i of b.inlines) {
        expect(i.range.to <= b.range.to && i.range.from >= b.range.from, name).toBe(true)
        for (const m of i.markers) {
          const s = sub(text, m)
          expect([...s].every((c) => '*_~`[]!('.includes(c)) || s.startsWith(']'), `${JSON.stringify(s)} in ${name}`).toBe(true)
        }
      }
    }
  }
})

// Not in the Swift tests: Lezer marks [x] as a link even with no definition; cmark doesn't.
test('a bracket without a definition is not a link', () => {
  expect(blocks('see [1] and [a][b]')[0]!.inlines).toEqual([])
  const t = 'see [a][r] and [r]\n\n[r]: https://e.com'
  const links = blocks(t)[0]!.inlines
  expect(links.map((l) => l.kind)).toEqual([{ link: 'https://e.com' }, { link: 'https://e.com' }])
  expect(blocks(t).length).toBe(1) // the definition itself makes no block, as in cmark
})

test('the corpus parses and covers every character once', () => {
  for (const { name, text } of corpus()) {
    const b = parseDocument(text).blocks
    for (let i = 1; i < b.length; i++) expect(b[i]!.range.from >= b[i - 1]!.range.to, `${name} block ${i}`).toBe(true)
    for (const x of b) expect(x.range.from >= 0 && x.range.to <= text.length, name).toBe(true)
  }
})

test('documentFromTree limits to a range', () => {
  const text = Array.from({ length: 5000 }, (_, i) => `Paragraph ${i} with **bold**.`).join('\n\n')
  const p = text.indexOf('Paragraph 2500 ')
  const doc = documentFromTree(parseTree(text), text, p, p)
  expect(doc.blocks.length).toBe(1)
  expect(sub(text, doc.blocks[0]!.range)).toBe('Paragraph 2500 with **bold**.')
})

describe('NestingLimitTests', () => {
  const deep: Array<[string, string]> = [
    ['quotes', '> '.repeat(10_000) + 'x'],
    ['quotes in list items', '- > '.repeat(5_000) + 'x'],
    ['stars', '*'.repeat(10_000) + 'a' + '*'.repeat(10_000)],
    ['underscores', '_'.repeat(10_000) + 'a' + '_'.repeat(10_000)],
    ['separate emphasis', '*a '.repeat(10_000) + 'b* '.repeat(10_000)],
    ['quotes with tabs', '>\t'.repeat(10_000) + 'x'],
    ['list markers with tabs', '-\t'.repeat(10_000) + 'x'],
    ['quotes after a hard line break', 'a\\\n' + '> '.repeat(10_000) + 'x'],
    ['nested images', '!['.repeat(10_000) + 'x' + '](u)'.repeat(10_000)],
    ['brackets', '['.repeat(10_000)],
  ]

  test.each(deep)('deeplyNestedInputParses: %s (deep nesting parses without overflow)', (_, text) => {
    const start = performance.now()
    expect(parseDocument(text).blocks.length).toBeGreaterThan(0)
    // apple/AGENTS.md: hostile inputs under 1 s ("separate emphasis" takes about 160 ms alone: Lezer matches each
    // of 10,000 unmatched closers against the delimiter stack)
    expect(performance.now() - start).toBeLessThan(1000)
  })

  test('quoteDepthStopsAtTheLimit', () => {
    const depths = blocks('> '.repeat(200) + 'x').flatMap((b) => (b.kind === 'quote' ? [b.depth] : []))
    expect(Math.max(...depths)).toBe(NESTING_DEPTH)
  })

  test('ordinaryMarkdownIsUntouched', () => {
    const samples = [...corpus().map((c) => c.text), 'word **b** _i_ [l](u) '.repeat(2000), '> '.repeat(NESTING_DEPTH) + 'x\r\n\r\n' + '['.repeat(32)]
    for (const text of samples) expect(nestingLimit(text) === text).toBe(true)
  })

  test('limitedTextKeepsEveryOffset', () => {
    for (const [, text] of deep) expect(nestingLimit(text).length).toBe(text.length)
  })
})

test('a block over 65,536 characters keeps no inline spans (it is shown plain, as on the Mac)', () => {
  const t = 'word **b** [l](u) '.repeat(4000)
  const start = performance.now()
  const b = parseDocument(t).blocks
  expect(b.length).toBe(1)
  expect(b[0]!.inlines).toEqual([])
  expect(performance.now() - start).toBeLessThan(1000)
})

// patches/@lezer__markdown@1.8.1.patch: closing a link walked back over every earlier part of the paragraph.
test('many links in one paragraph parse in linear time', () => {
  const time = (n: number) => {
    const t = 'word **b** _i_ [l](u) '.repeat(n)
    const start = performance.now()
    parseTree(t)
    return performance.now() - start
  }
  time(2000)
  const small = time(10_000)
  const big = time(90_000) // a 2 MB line
  expect(big).toBeLessThan(2000)
  expect(big / small).toBeLessThan(20) // 9× the text; quadratic would be about 81×
  // and nested links still don't nest: the inner one wins, as in CommonMark
  const b = parseDocument('[a [b](u) c](v)').blocks[0]!
  expect(b.inlines.map((i) => i.kind)).toEqual([{ link: 'u' }])
})

// Final review: Lezer's inline parse is quadratic on more than links (unmatched "]", emphasis runs, autolinks).
// A paragraph over MAX_STYLED_BLOCK is shown plain, so its inlines are never parsed at all.
test.each([['*]'], ['a* '], ['`a`] '], ['www.a.b '], ['http://a.b ']])('a 2 MB paragraph of %j parses quickly', (unit) => {
  const t = unit.repeat(Math.ceil(2_000_000 / unit.length))
  const start = performance.now()
  parseTree(t)
  expect(performance.now() - start).toBeLessThan(1500)
})

test('a pasted list of URLs, one per line, parses quickly', () => {
  const t = Array.from({ length: 16_000 }, (_, i) => `https://example.com/page/${i}`).join('\n')
  const start = performance.now()
  parseTree(t)
  expect(performance.now() - start).toBeLessThan(500)
})
