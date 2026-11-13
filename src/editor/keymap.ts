// The keys that run the editor commands (specs/editor.md "Commands"). Each command is one undo step, as the Mac
// groups Return and block picks. A command that doesn't apply returns false and the default runs.
import { insertNewline, isolateHistory } from '@codemirror/commands'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorSelection, Prec, type EditorState, type Extension } from '@codemirror/state'
import { keymap, type Command, type EditorView } from '@codemirror/view'
import { backspaceAtItemStart, backtab, link, returnKey, tab, toggleCheckbox, toggleInline, type Edit, type InlineFormat, type Selection } from './commands/index.ts'
import { attachmentOpener, docText } from './live-preview.ts'
import { documentFromTree, type MarkdownDocument } from './markdown/document.ts'

/** The parse around [from, to], parsing that far first if the background parse hasn't got there. */
export function documentAt(state: EditorState, from: number, to: number): MarkdownDocument {
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, to + 1), 50) ?? syntaxTree(state)
  return documentFromTree(tree, docText(state), from, to)
}

/** Applies a command's edit as its own undo step; `select` false leaves the selection where it is (mapped). */
export function dispatchEdit(view: EditorView, e: Edit, userEvent = 'input.command', select = true) {
  view.dispatch({
    changes: { from: e.from, to: e.to, insert: e.insert },
    selection: select ? EditorSelection.range(e.selection.from, e.selection.to) : undefined,
    annotations: isolateHistory.of('full'),
    userEvent,
    scrollIntoView: true,
  })
}

type Cmd = (text: string, doc: MarkdownDocument, sel: Selection) => Edit | null

function run(cmd: Cmd): Command {
  return (view) => {
    if (view.state.readOnly) return false
    const sel = view.state.selection.main
    const e = cmd(docText(view.state), documentAt(view.state, sel.from, sel.to), { from: sel.from, to: sel.to })
    if (!e) return false
    dispatchEdit(view, e)
    return true
  }
}

const inline = (f: InlineFormat) => run((text, doc, sel) => toggleInline(f, text, doc, sel))

/** Tab with no list or code to act on inserts a tab character, as on the Mac. */
const insertTab: Command = (view) => {
  if (view.state.readOnly) return false
  view.dispatch(view.state.replaceSelection('\t'), { userEvent: 'input' })
  return true
}

/** Opens the link or attachment at `pos`: an attachment through the opener, a web link in a new tab (only http,
 *  https and mailto; never in this tab, which would end the demo). False when there is no link there. */
export function openLinkAt(view: EditorView, pos: number): boolean {
  for (const b of documentAt(view.state, pos, pos).blocks)
    for (const i of b.inlines) {
      if (typeof i.kind !== 'object' || pos < i.range.from || pos > i.range.to) continue
      const url = i.kind.link
      if (url.toLowerCase().startsWith('feather://attachment/')) view.state.facet(attachmentOpener)(url)
      else if (/^(https?:|mailto:)/i.test(url)) window.open(url, '_blank', 'noopener,noreferrer')
      return true
    }
  return false
}

/** Ctrl/⌘+Enter: opens the link or attachment at the caret, or else ticks the to-do on the caret's line, so neither
 *  needs a mouse (the to-do marker is hidden and the caret skips it). */
const actAtCaret: Command = (view) => {
  const sel = view.state.selection.main
  if (openLinkAt(view, sel.head)) return true
  if (view.state.readOnly) return false
  const e = toggleCheckbox(docText(view.state), documentAt(view.state, sel.head, sel.head), sel.head)
  if (!e) return false
  dispatchEdit(view, { ...e, selection: { from: sel.head, to: sel.head } }, 'input.toggle')
  return true
}

export const editorKeymap: Extension = Prec.high(
  keymap.of([
    { key: 'Enter', run: (v) => run(returnKey)(v) || insertNewline(v) },
    { key: 'Tab', run: (v) => run(tab)(v) || insertTab(v), shift: run(backtab) },
    { key: 'Backspace', run: run(backspaceAtItemStart) },
    { key: 'Mod-b', run: inline('bold') },
    { key: 'Mod-i', run: inline('italic') },
    { key: 'Mod-e', run: inline('code') },
    { key: 'Mod-k', run: run((text, _doc, sel) => link(text, sel)) },
    { key: 'Mod-Enter', run: actAtCaret },
  ]),
)
