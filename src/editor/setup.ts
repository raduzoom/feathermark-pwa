// The note body's editor: CodeMirror 6 over the note's exact Markdown (specs/editor.md). The editor holds the
// LF form of the text; NoteEditor maps it back to the note's own line endings (src/model/line-endings.ts).
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { EditorView, keymap } from '@codemirror/view'
import { blockMenu } from './block-menu.ts'
import { editorKeymap, openLinkAt } from './keymap.ts'
import { docText, livePreview, rawMode } from './live-preview.ts'

export type EditorOptions = {
  parent: HTMLElement
  doc: string
  readOnly: boolean
  /** `pastedBreak`: the line-break style of text just pasted, so a note with no line break yet can take it. */
  onChange(doc: string, info: { pastedBreak: '\n' | '\r\n' | null }): void
  extensions?: Extension[]
}

export type EditorHandle = {
  view: EditorView
  setDoc(doc: string): void
  setReadOnly(readOnly: boolean): void
  setRaw(raw: boolean): void
  focus(): void
  destroy(): void
}

export function createEditor(opts: EditorOptions): EditorHandle {
  const editable = new Compartment()
  const raw = new Compartment()
  let replacing = false
  let rawOn = false
  let pastedBreak: '\n' | '\r\n' | null = null
  const readOnlyExt = (ro: boolean) => [EditorState.readOnly.of(ro), EditorView.editable.of(!ro)]
  const state = (doc: string, ro: boolean) =>
    EditorState.create({
      doc,
      extensions: [
        editable.of(readOnlyExt(ro)),
        raw.of(rawMode.of(rawOn)),
        livePreview(),
        blockMenu(),
        history(),
        editorKeymap,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.domEventHandlers({
          paste(e) {
            const t = e.clipboardData?.getData('text/plain') ?? ''
            pastedBreak = /\r\n/.test(t) && !/(^|[^\r])\n/.test(t) ? '\r\n' : /\n/.test(t) ? '\n' : null
            return false // CodeMirror inserts the plain text
          },
          mousedown: (e, view) => openLinkOnModClick(e, view),
        }),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': 'Note', id: 'note-body', spellcheck: 'true', autocapitalize: 'sentences' }),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged || replacing) return
          const pasted = u.transactions.some((t) => t.isUserEvent('input.paste'))
          opts.onChange(docText(u.state), { pastedBreak: pasted ? pastedBreak : null }) // one shared copy of the text
          if (pasted) pastedBreak = null
        }),
        ...(opts.extensions ?? []),
      ],
    })
  const view = new EditorView({ parent: opts.parent, state: state(opts.doc, opts.readOnly) })
  let readOnly = opts.readOnly
  return {
    view,
    setDoc(doc) {
      replacing = true
      try {
        view.setState(state(doc, readOnly))
      } finally {
        replacing = false
      }
    },
    setReadOnly(ro) {
      readOnly = ro
      view.dispatch({ effects: editable.reconfigure(readOnlyExt(ro)) })
    },
    setRaw(on) {
      rawOn = on
      view.dispatch({ effects: raw.reconfigure(rawMode.of(on)) })
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  }
}

/** Ctrl/⌘-click on a link opens it in a new tab (a plain click only places the caret, so the demo is never left by
 *  accident); on an attachment link it opens the attachment. Only http, https and mailto links open. */
function openLinkOnModClick(e: MouseEvent, view: EditorView): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return false
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
  if (pos === null || !openLinkAt(view, pos)) return false
  e.preventDefault()
  return true
}
