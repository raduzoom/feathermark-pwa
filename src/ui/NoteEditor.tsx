// The open note's body: the CodeMirror editor, given the note's text in LF form and handing edits back in the
// note's own line endings.
import { Compartment } from '@codemirror/state'
import { useLayoutEffect, useRef } from 'preact/hooks'
import { pastedAndDroppedFiles } from '../editor/attachments.ts'
import { attachmentAdder } from '../editor/block-menu.ts'
import { attachmentOpener, attachmentResolver } from '../editor/live-preview.ts'
import { createEditor, type EditorHandle } from '../editor/setup.ts'
import type { AppModel } from '../model/app-model.ts'
import { bodyFromTextarea, lineStyle, textareaValue, type LineStyle } from '../model/line-endings.ts'
import { saveObjectUrl } from './download.ts'

/** How many times (20 ms apart) a held replacement waits for the editor to stop composing. */
const SETTLE_TRIES = 50

/** Holds the attachment resolver, so it can be given again (a new function) when an attachment arrives. */
const resolver = new Compartment()

export function NoteEditor({ model }: { model: AppModel }) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorHandle | null>(null)
  const shownId = useRef<string | null>(null)
  /** The open note's line-break style, fixed when it opens (line-endings.ts). */
  const style = useRef<LineStyle>('\n')
  const note = model.openNote.value
  // a note whose body hasn't arrived shows "Loading this note…" over an empty, read-only editor
  const loading = model.openNoteLoading.value
  // a note in the Trash, a library another tab owns now, or a body not here yet can't be edited here
  const trashed = note?.trashedAt !== null || model.readOnly.value || loading
  /** Whether the text in the editor is the note's body, or the empty placeholder of one still loading. */
  const shownLoaded = useRef(!loading)
  /** The body the editor's text stands for: what it was given, or what its last edit made. */
  const known = useRef<string | null>(null)
  /** Another device's version of the open note landed during an IME composition: replacing the text then would drop
   *  the characters not committed yet, so it waits for compositionend (and the typing meanwhile isn't saved over it). */
  const held = useRef(false)

  useLayoutEffect(() => {
    const current = () => {
      const n = model.openNote.value
      return n ? (model.draft.value?.body ?? n.body) : ''
    }
    style.current = lineStyle(current())
    editor.current = createEditor({
      parent: host.current!,
      doc: textareaValue(current()),
      readOnly: trashed,
      onChange: (doc, info) => {
        const body = current()
        // a note with no line break yet takes the style of text pasted into it
        if (info.pastedBreak && !/[\r\n]/.test(body)) style.current = info.pastedBreak
        known.current = bodyFromTextarea(doc, body, style.current)
        // typed over text another device has replaced: kept when the composition ends, never saved over theirs
        if (!held.current) model.editBody(known.current)
        // held, but no composition is open any more (its compositionend was missed): settle, so typing from here on
        // isn't held back for good. After this update: the editor can't take a new one from inside it.
        else if (!editor.current?.view.composing) setTimeout(() => settle(), 0)
      },
      extensions: [
        resolver.of(attachmentResolver.of((url) => model.attachmentUrl(url))),
        attachmentOpener.of((url) => {
          const file = model.attachmentUrl(url)
          if (file) saveObjectUrl(file.filename, file.objectUrl)
        }),
        attachmentAdder.of((files) => model.addFiles(files)),
        pastedAndDroppedFiles(),
      ],
    })
    shownId.current = note?.id ?? null
    shownLoaded.current = !loading
    known.current = current()
    const view = editor.current.view
    // a replacement held back during a composition goes in once it ends (the editor reads the composition's end
    // itself first, so this waits until it no longer says it is composing)
    const settle = (tries = 0) => {
      if (!held.current) return
      if (view.composing && tries < SETTLE_TRIES) {
        setTimeout(() => settle(tries + 1), 20)
        return
      }
      held.current = false
      const n = model.openNote.peek()
      if (!n || shownId.current !== n.id) return
      // what was typed here stays, as a conflict copy, if the other device's text didn't already include it
      if (known.current !== null && known.current !== n.body) model.keepAsCopy(n.id, known.current)
      replaceText(n.body)
    }
    const onCompositionEnd = () => setTimeout(() => settle(), 0)
    // a key pressed outside any composition while held: the composition is over even if its compositionend was never
    // seen, and the editor may still think it is composing (it learns that from the same event), so settle without
    // waiting for it. A key the IME is processing (229, "Process") may be starting a new composition: not that one.
    const onKeyDown = (e: KeyboardEvent) => {
      if (held.current && !e.isComposing && e.keyCode !== 229 && e.key !== 'Process') setTimeout(() => settle(SETTLE_TRIES), 0)
    }
    view.contentDOM.addEventListener('compositionend', onCompositionEnd)
    view.contentDOM.addEventListener('keydown', onKeyDown)
    return () => {
      view.contentDOM.removeEventListener('compositionend', onCompositionEnd)
      view.contentDOM.removeEventListener('keydown', onKeyDown)
      editor.current?.destroy()
    }
  }, [])

  /** Shows another device's version of the open note, the caret kept where the new text allows. */
  const replaceText = (body: string) => {
    const e = editor.current
    if (!e) return
    const sel = e.view.state.selection.main
    known.current = body
    style.current = lineStyle(body)
    e.setDoc(textareaValue(body))
    const len = e.view.state.doc.length
    e.view.dispatch({ selection: { anchor: Math.min(sel.anchor, len), head: Math.min(sel.head, len) } })
  }

  // A different note (or the same one restored from the Trash) replaces the text; edits from this editor don't.
  useLayoutEffect(() => {
    const e = editor.current
    if (!e || !note) return
    // its body arrived while it was open: the editor shows it now (nothing was typed over the placeholder)
    const arrived = shownId.current === note.id && !shownLoaded.current && !loading
    shownLoaded.current = !loading
    if (shownId.current !== note.id || arrived) {
      held.current = false
      shownId.current = note.id
      const body = model.draft.value?.body ?? note.body
      style.current = lineStyle(body)
      e.setDoc(textareaValue(body))
      known.current = body
      // for the speed tests (tests/e2e/editor-speed.spec.ts); it records no note text
      performance.mark('feather:note-open')
    }
    e.setReadOnly(trashed)
  }, [note?.id, trashed, loading])

  // Another device's version of the open note landed (nothing typed here was pending: that would have gone in first,
  // as a local change, and the conflict rules keep it): the editor shows the new text, the caret kept where it can be.
  // Without this the next keystroke would save the old text over it.
  const body = note?.body
  useLayoutEffect(() => {
    const e = editor.current
    if (!e || !note || shownId.current !== note.id || !shownLoaded.current || loading) return
    if (body === known.current || held.current) return
    // mid-composition: replacing the text now would drop what isn't committed yet
    if (e.view.composing) {
      held.current = true
      return
    }
    if (model.draft.peek() !== null) return
    replaceText(note.body)
  }, [body])

  // an attachment from another device arrived: the images and chips are drawn again with it
  const attachments = model.attachmentsVersion.value
  useLayoutEffect(() => {
    const e = editor.current
    if (!e || attachments === 0) return
    e.view.dispatch({ effects: resolver.reconfigure(attachmentResolver.of((url) => model.attachmentUrl(url))) })
  }, [attachments])

  const raw = model.editorRaw.value
  useLayoutEffect(() => editor.current?.setRaw(raw), [raw])

  return <div class="note-editor" ref={host} />
}
