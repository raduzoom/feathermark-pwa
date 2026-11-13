// The Markdown grammar: CommonMark with the GFM extensions, as swift-markdown (cmark-gfm) reads it. Tables are
// parsed only so they can be shown as plain source. The editor's parser reads the text through nestingLimit, so
// pathological nesting never builds a pathological tree.
import { Parser, type Input, type PartialParse, type TreeFragment } from '@lezer/common'
import { GFM, parser as base, type BlockContext, type LeafBlock, type MarkdownConfig, type MarkdownParser } from '@lezer/markdown'
import type { Text } from '@codemirror/state'
import { textOfDoc } from '../doc-text.ts'
import { nestingLimit } from './nesting-limit.ts'

/** A paragraph longer than this is shown plain (document.ts MAX_STYLED_BLOCK, MarkdownStyler.swift), so its inline
 *  syntax is never parsed: Lezer's inline parse is quadratic on unmatched "]", long emphasis runs and autolinks,
 *  and a pasted 2 MB paragraph would freeze the tab. (Duplicated here to keep the parser free of document.ts.) */
const PLAIN_PARAGRAPH = 65_536

/** Finishes an over-long paragraph as a bare Paragraph node, before the default finish parses its inlines. Other
 *  leaf parsers (tables, setext headings, link references) come first and keep their say. */
const longParagraphs: MarkdownConfig = {
  parseBlock: [
    {
      name: 'LongParagraph',
      leaf: () => ({
        nextLine: () => false,
        finish(cx: BlockContext, leaf: LeafBlock) {
          if (leaf.content.length <= PLAIN_PARAGRAPH) return false
          cx.addLeafElement(leaf, cx.elt('Paragraph', leaf.start, leaf.start + leaf.content.length))
          return true
        },
      }),
    },
  ],
}

export const markdownParser: MarkdownParser = base.configure([GFM, longParagraphs])

/** markdownParser over the nesting-limited text (same offsets). */
class LimitedParser extends Parser {
  constructor(private readonly inner: Parser) {
    super()
  }
  createParse(input: Input, fragments: readonly TreeFragment[], ranges: readonly { from: number; to: number }[]): PartialParse {
    // CodeMirror's input carries its document: share the editor's one copy of the text
    const doc = (input as { doc?: Text }).doc
    const text = doc && doc.length === input.length ? textOfDoc(doc) : input.read(0, input.length)
    const limited = nestingLimit(text)
    return this.inner.startParse(limited === text ? input : limited, fragments, ranges)
  }
}

export const limitedMarkdownParser: Parser = new LimitedParser(markdownParser)
