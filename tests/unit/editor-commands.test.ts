// The editor commands against every shared case in universal/test-vectors/editor/commands.json (extracted from
// the Swift tests), then the Swift tests that stay in Swift (README "Left in Swift"), ported by hand.
import { describe, expect, test } from 'vitest'
import { parseDocument } from '../../src/editor/markdown/document.ts'
import {
  activeFormats,
  applyEdit,
  CODE_LANGUAGES,
  codeFenceGuard,
  setCodeLanguage,
  attachmentSnippets,
  backspaceAtItemStart,
  backtab,
  block,
  BLOCK_CHOICES,
  BlockMenuState,
  heading,
  line,
  link,
  matching,
  mediaEdit,
  mediaInsertionPoint,
  returnKey,
  slashOpensMenu,
  tab,
  toggleCheckbox,
  toggleInline,
  type BlockChoiceId,
  type Edit,
  type InlineFormat,
  type Selection,
} from '../../src/editor/commands/index.ts'
import { commandCases, corpus, type CommandCase } from './support/editor-fixtures.ts'

/** "|" is the caret, «…» the selection. */
function decode(marked: string): [string, Selection] {
  const open = marked.indexOf('«')
  if (open >= 0) {
    const close = marked.indexOf('»')
    return [marked.slice(0, open) + marked.slice(open + 1, close) + marked.slice(close + 1), { from: open, to: close - 1 }]
  }
  const bar = marked.indexOf('|')
  return [marked.slice(0, bar) + marked.slice(bar + 1), { from: bar, to: bar }]
}

function show(text: string, sel: Selection): string {
  if (sel.from === sel.to) return text.slice(0, sel.from) + '|' + text.slice(sel.from)
  return text.slice(0, sel.from) + '«' + text.slice(sel.from, sel.to) + '»' + text.slice(sel.to)
}

const shown = (text: string, e: Edit | null) => (e ? show(applyEdit(text, e), e.selection) : null)

function run(c: CommandCase): unknown {
  switch (c.command) {
    case 'matching':
      return matching(c.query as string)
    case 'toggleCheckbox': {
      const e = toggleCheckbox(c.input!, parseDocument(c.input!), c.at as number)
      return e ? applyEdit(c.input!, e) : null
    }
    case 'slashOpensMenu': {
      const [t, sel] = decode(c.input!)
      const text = t.slice(0, sel.from) + '/' + t.slice(sel.from)
      return slashOpensMenu(text, parseDocument(text), sel.from)
    }
  }
  const [text, sel] = decode(c.input!)
  const doc = parseDocument(text)
  switch (c.command) {
    case 'returnKey':
      return shown(text, returnKey(text, doc, sel))
    case 'tab':
      return shown(text, tab(text, doc, sel))
    case 'backtab':
      return shown(text, backtab(text, doc, sel))
    case 'backspaceAtItemStart':
      return shown(text, backspaceAtItemStart(text, doc, sel))
    case 'block': {
      const t = c.trigger as [number, number] | undefined
      return shown(text, block(c.choice as BlockChoiceId, text, sel.from, t ? { from: t[0], to: t[0] + t[1] } : null))
    }
    case 'toggleInline':
      return shown(text, toggleInline(c.format as InlineFormat, text, doc, sel))
    case 'link':
      return shown(text, link(text, sel))
    case 'heading':
      return shown(text, heading(c.level as number, text, sel.from))
    case 'mediaEdit':
      return applyEdit(text, mediaEdit(c.snippets as string[], text, sel.from))
    case 'activeFormats': {
      const f = activeFormats(doc, text, sel)
      const all: Record<string, unknown> = { inline: [...f.inline].sort(), heading: f.heading, checklist: f.checklist, bulleted: f.bulleted, code: f.code }
      return Object.fromEntries(Object.keys(c.expected as object).map((k) => [k, all[k]]))
    }
  }
  throw new Error(`unknown command ${c.command}`)
}

describe('commands.json', () => {
  const cases = commandCases()
  test('has every case', () => expect(cases.length).toBe(143))
  test.each(cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    expect(run(c)).toEqual(c.expected)
  })
})

// Ported by hand (README "Left in Swift").

test('toggleCheckboxEditsOnlyTheBox: the edit covers exactly the box', () => {
  const t = '- [ ] a\n- [x] b\n- [X] c'
  for (const at of [2, 10, 18]) {
    const e = toggleCheckbox(t, parseDocument(t), at)!
    expect(e.to - e.from).toBe(3)
  }
})

test('choiceCopy', () => {
  expect(BLOCK_CHOICES.map((c) => c.title)).toEqual(['Heading 1', 'Heading 2', 'Heading 3', 'Bulleted list', 'Numbered list', 'To-do list', 'Quote', 'Divider', 'Code block', 'Image or file', 'Scan from iPhone'])
  expect(BLOCK_CHOICES.filter((c) => c.textBlock).map((c) => c.id)).toEqual(['heading1', 'heading2', 'heading3', 'bulleted', 'numbered', 'todo', 'quote'])
})

test('dividerNeverMakesASetextHeading: the parse', () => {
  expect(parseDocument('a\n\n---\n').blocks.some((b) => b.kind === 'thematicBreak')).toBe(true)
})

test('triggerIsRemovedInTheSameEdit: image, file and scan have no text edit', () => {
  for (const c of BLOCK_CHOICES.filter((c) => !c.textBlock && c.id !== 'code' && c.id !== 'divider')) expect(block(c.id, 'x', 1, null)).toBe(null)
})

test('mediaInsertionPoint', () => {
  const empty = mediaInsertionPoint('a\n/im\nb', 5, { from: 2, to: 5 })
  expect(empty.edit?.insert).toBe('')
  expect(empty.location).toBe(2)
  const text = mediaInsertionPoint('hello\nb', 2, null)
  expect(text.edit).toBe(null)
  expect(text.location).toBe(5)
})

test('menuStateFiltersAndWraps', () => {
  const s = new BlockMenuState()
  expect(s.items).toEqual(BLOCK_CHOICES.map((c) => c.id))
  expect(s.selection).toBe('heading1')
  s.move(-1)
  expect(s.selection).toBe('scan')
  s.move(1)
  s.move(1)
  expect(s.selection).toBe('heading2')
  expect(s.setQuery('list')).toBe(true)
  expect(s.items).toEqual(['bulleted', 'numbered', 'todo'])
  expect(s.selected).toBe(0)
  expect(s.setQuery('listz')).toBe(false)
  expect(s.setQuery(' h')).toBe(false)
  expect(s.setQuery('a'.repeat(25))).toBe(false)
  expect(s.query).toBe('list')
})

test('hiddenChoicesNeverShow', () => {
  const s = new BlockMenuState(new Set<BlockChoiceId>(['scan']))
  expect(s.items).not.toContain('scan')
  expect(s.items.length).toBe(BLOCK_CHOICES.length - 1)
  s.move(-1)
  expect(s.selection).toBe('imageOrFile')
  expect(s.setQuery('sca')).toBe(false)
  expect(s.query).toBe('')
  expect(s.setQuery('ima')).toBe(true)
  expect(s.items).toEqual(['imageOrFile'])
})

test('mediaBelowTextIsItsOwnParagraph: the parse', () => {
  const text = applyEdit('hello\nnext', mediaEdit(['![a](x)'], 'hello\nnext', 5))
  expect(parseDocument(text).blocks.some((b) => b.kind === 'image')).toBe(true)
})

test('attachmentSnippets: one per line, new lines where needed, the note’s line ending', () => {
  expect(attachmentSnippets([], 'a', { from: 0, to: 0 })).toBe(null)
  const mid = attachmentSnippets(['[f](x)', '[g](y)'], 'ab\r\ncd', { from: 1, to: 1 })!
  expect(applyEdit('ab\r\ncd', mid)).toBe('a\r\n[f](x)\r\n[g](y)\r\nb\r\ncd')
  const start = attachmentSnippets(['[f](x)'], 'ab', { from: 0, to: 0 })!
  expect(applyEdit('ab', start)).toBe('[f](x)\nab')
})

// commandsNeverTouchOtherLines (InlineCommandTests), with a seeded generator as in Swift.
test('commandsNeverTouchOtherLines', () => {
  let state = 13n
  const next = () => {
    // SplitMix64
    state = (state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn
    let z = state
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn
    return z ^ (z >> 31n)
  }
  const rand = (lo: number, hi: number) => lo + Number(next() % BigInt(hi - lo + 1))
  for (const { name, text } of corpus()) {
    if (text.length === 0) continue
    const doc = parseDocument(text)
    for (let k = 0; k < 50; k++) {
      const a = rand(0, text.length)
      const b = Math.min(text.length, a + rand(0, 40))
      const sel = { from: a, to: b }
      const edits: Edit[] = (['bold', 'italic', 'code'] as const).flatMap((f) => toggleInline(f, text, doc, sel) ?? [])
      edits.push(link(text, sel), heading(2, text, a), heading(0, text, a))
      let lo = line(text, a).from
      let hi = line(text, b).to
      for (const bl of doc.blocks)
        if (bl.range.from <= b && bl.range.to >= a) {
          lo = Math.min(lo, line(text, bl.range.from).from)
          hi = Math.max(hi, line(text, bl.range.to).to)
        }
      for (const e of edits) {
        expect(e.from >= lo && e.to <= hi, `${name}: ${JSON.stringify(e)} outside ${lo}..${hi}`).toBe(true)
        const changed = applyEdit(text, e)
        const back = changed.slice(0, e.from) + text.slice(e.from, e.to) + changed.slice(e.from + e.insert.length)
        expect(back, name).toBe(text)
        expect(!e.insert.includes('\r') || text.includes('\r'), `${name}: no new line-ending kind`).toBe(true)
        expect(e.selection.from >= 0 && e.selection.to <= changed.length, name).toBe(true)
      }
    }
  }
})

describe('setCodeLanguage (specs/editor.md "Code bar")', () => {
  const run = (t: string, at: number, lang: string, sel = { from: at, to: at }) => {
    const e = setCodeLanguage(t, parseDocument(t), at, lang, sel)
    return e && { text: applyEdit(t, e), selection: e.selection }
  }
  test('sets, replaces and clears the info string, keeping indent and fence', () => {
    expect(run('```\nx\n```', 4, 'swift')).toEqual({ text: '```swift\nx\n```', selection: { from: 9, to: 9 } })
    expect(run('  ~~~~js  \nx\n~~~~', 11, 'python')!.text).toBe('  ~~~~python\nx\n~~~~')
    expect(run('```js\r\nx\r\n```', 7, '')!.text).toBe('```\r\nx\r\n```')
  })
  test('nothing outside a fenced block, or when unchanged', () => {
    expect(run('plain', 1, 'go')).toBeNull()
    expect(run('    indented', 5, 'go')).toBeNull()
    expect(run('```go\nx\n```', 6, 'go')).toBeNull()
  })
  test('the menu ids', () => {
    expect(CODE_LANGUAGES[0]).toEqual(['Plain text', ''])
    expect(CODE_LANGUAGES.map(([, id]) => id)).toContain('typescript')
  })
})

describe('codeFenceGuard (specs/editor.md "Commands")', () => {
  const run = (t: string, p: number, key: 'backspace' | 'delete') => {
    const e = codeFenceGuard(t, parseDocument(t), { from: p, to: p }, key)
    return e && applyEdit(t, e)
  }
  const t = 'a\n\n```js\nx = 1\ny\n```\n\nb'
  test('Backspace at the content start and Delete at its end change nothing', () => {
    expect(run(t, 9, 'backspace')).toBe(t)
    expect(run(t, 16, 'delete')).toBe(t)
  })
  test('elsewhere they are left to the default', () => {
    expect(run(t, 10, 'backspace')).toBeNull()
    expect(run(t, 15, 'delete')).toBeNull()
    expect(run(t, 1, 'backspace')).toBeNull()
  })
  test('Backspace in a block of blank lines removes it', () => {
    expect(run('a\n\n```\n\n```\n\nb', 7, 'backspace')).toBe('a\n\n\n\nb')
  })
})
