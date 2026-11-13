// Files pasted or dropped into the note become attachments, their snippets inserted where they landed
// (specs/editor.md "Attachments in the text"). The image and chip widgets live in live-preview.ts.
import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { attachmentAdder } from './block-menu.ts'
import { attachmentSnippets } from './commands/index.ts'
import { dispatchEdit } from './keymap.ts'
import { docText } from './live-preview.ts'

type Anchor = { from: number; to: number }
const holdAnchor = StateEffect.define<{ token: number; at: Anchor }>()
const dropAnchor = StateEffect.define<number>()
/** Where each paste or drop's files go, mapped through edits made while they are read. One per import, so two
 *  quick pastes both land; a note switch replaces the editor's state, and with it every anchor, so files read for
 *  one note never land in another (AppModel.swift's loadGeneration does the same on the Mac). */
const fileAnchors = StateField.define<ReadonlyMap<number, Anchor>>({
  create: () => new Map(),
  update(anchors, tr) {
    let next = anchors
    if (tr.docChanged && anchors.size) {
      // a selection keeps covering what it covered; an empty anchor stays empty, after text inserted at it
      next = new Map([...anchors].map(([k, a]) => [k, { from: tr.changes.mapPos(a.from, a.from === a.to ? 1 : -1), to: tr.changes.mapPos(a.to, 1) }]))
    }
    for (const e of tr.effects) {
      if (e.is(holdAnchor)) next = new Map(next).set(e.value.token, e.value.at)
      if (e.is(dropAnchor) && next.has(e.value)) {
        next = new Map(next)
        ;(next as Map<number, Anchor>).delete(e.value)
      }
    }
    return next
  },
})

let nextToken = 1

/** A paste is files only when it carries files and no rich text: text copied with a picture of itself (cells from a
 *  spreadsheet) pastes as text, as on the Mac ("image data next to text: paste the text"); a file copied in the
 *  Finder carries only its name as plain text, so it still pastes as the file. */
function pastedFiles(dt: DataTransfer | null): File[] {
  if (!dt || dt.files.length === 0) return []
  if (dt.types.includes('text/html')) return []
  return [...dt.files]
}

const droppedFiles = (dt: DataTransfer | null): File[] => (dt && [...dt.types].includes('Files') ? [...dt.files] : [])

function insertFiles(view: EditorView, files: File[], at: Anchor) {
  if (view.state.readOnly) return
  const token = nextToken++
  view.dispatch({ effects: holdAnchor.of({ token, at }) })
  void view.state
    .facet(attachmentAdder)(files)
    .then((snippets) => {
      const anchor = view.state.field(fileAnchors, false)?.get(token)
      if (!anchor) return // the note was switched (or the editor closed) while the files were read
      view.dispatch({ effects: dropAnchor.of(token) })
      const e = attachmentSnippets(snippets, docText(view.state), anchor)
      if (!e) return
      // The caret follows the files only if it is still where they were pasted; if the person moved it while the
      // files were read, it stays where they put it.
      const sel = view.state.selection.main
      const stayed = sel.from === anchor.from && sel.to === anchor.to
      dispatchEdit(view, e, 'input.paste', stayed)
    })
}

export function pastedAndDroppedFiles(): Extension {
  return [
    fileAnchors,
    EditorView.domEventHandlers({
      paste(e, view) {
        const files = pastedFiles(e.clipboardData)
        if (files.length === 0) return false
        e.preventDefault()
        const sel = view.state.selection.main
        insertFiles(view, files, { from: sel.from, to: sel.to })
        return true
      },
      drop(e, view) {
        const files = droppedFiles(e.dataTransfer)
        if (files.length === 0) return false
        e.preventDefault()
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head
        insertFiles(view, files, { from: pos, to: pos })
        return true
      },
    }),
  ]
}

/** A file dropped anywhere else would open in place of the demo and lose its notes: refuse it. */
export function preventFileNavigation(target: Window = window): () => void {
  const stop = (e: DragEvent) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault()
  }
  target.addEventListener('dragover', stop)
  target.addEventListener('drop', stop)
  return () => {
    target.removeEventListener('dragover', stop)
    target.removeEventListener('drop', stop)
  }
}
