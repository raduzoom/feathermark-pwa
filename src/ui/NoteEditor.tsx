// The open note's body: the CodeMirror editor, given the note's text in LF form and handing edits back in the
// note's own line endings.
import { useLayoutEffect, useRef } from 'preact/hooks'
import { pastedAndDroppedFiles } from '../editor/attachments.ts'
import { attachmentAdder } from '../editor/block-menu.ts'
import { attachmentOpener, attachmentResolver } from '../editor/live-preview.ts'
import { createEditor, type EditorHandle } from '../editor/setup.ts'
import type { AppModel } from '../model/app-model.ts'
import { bodyFromTextarea, lineStyle, textareaValue, type LineStyle } from '../model/line-endings.ts'
import { saveObjectUrl } from './download.ts'

export function NoteEditor({ model }: { model: AppModel }) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorHandle | null>(null)
  const shownId = useRef<string | null>(null)
  /** The open note's line-break style, fixed when it opens (line-endings.ts). */
  const style = useRef<LineStyle>('\n')
  const note = model.openNote.value
  const trashed = note?.trashedAt !== null

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
        model.editBody(bodyFromTextarea(doc, body, style.current))
      },
      extensions: [
        attachmentResolver.of((url) => model.attachmentUrl(url)),
        attachmentOpener.of((url) => {
          const file = model.attachmentUrl(url)
          if (file) saveObjectUrl(file.filename, file.objectUrl)
        }),
        attachmentAdder.of((files) => model.addFiles(files)),
        pastedAndDroppedFiles(),
      ],
    })
    shownId.current = note?.id ?? null
    return () => editor.current?.destroy()
  }, [])

  // A different note (or the same one restored from the Trash) replaces the text; edits from this editor don't.
  useLayoutEffect(() => {
    const e = editor.current
    if (!e || !note) return
    if (shownId.current !== note.id) {
      shownId.current = note.id
      const body = model.draft.value?.body ?? note.body
      style.current = lineStyle(body)
      e.setDoc(textareaValue(body))
      // for the speed tests (tests/e2e/editor-speed.spec.ts); it records no note text
      performance.mark('feather:note-open')
    }
    e.setReadOnly(trashed)
  }, [note?.id, trashed])

  const raw = model.editorRaw.value
  useLayoutEffect(() => editor.current?.setRaw(raw), [raw])

  return <div class="note-editor" ref={host} />
}
