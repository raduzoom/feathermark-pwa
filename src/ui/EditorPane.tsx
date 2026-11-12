// The open note: breadcrumb, toolbar, title, edited line and the plain Markdown body (live preview is Phase 19).
import { useLayoutEffect, useRef } from 'preact/hooks'
import { noteFileName, noteMarkdown } from '../core/library/export.ts'
import type { Note } from '../core/library/types.ts'
import type { AppModel } from '../model/app-model.ts'
import { editedLine } from '../model/format.ts'
import { bodyFromTextarea, textareaValue } from '../model/line-endings.ts'
import * as act from './actions.ts'
import { saveText } from './download.ts'
import { notebookTree } from './LibraryPanel.tsx'
import { MenuButton } from './Menu.tsx'

export function EditorPane({ model, onBack }: { model: AppModel; onBack: () => void }) {
  const note = model.openNote.value
  const titleRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    if (model.titleWantsFocus.value && note) {
      titleRef.current?.focus()
      model.focusTitleDone()
    }
  })

  if (!note) {
    return (
      <div class="editor-empty">
        <p>Select a note, or press Alt+N for a new one.</p>
      </div>
    )
  }

  const draft = model.draft.value
  const title = draft?.title ?? note.title
  const body = draft?.body ?? note.body
  const trashed = note.trashedAt !== null
  const path: string[] = []
  for (let id = note.notebookId; id; ) {
    const nb = model.notebooks.value.find((n) => n.id === id)
    if (!nb) break
    path.unshift(nb.name)
    id = nb.parentId
  }

  return (
    <div class="editor-body">
      <div class="editor-head">
        <button type="button" class="back-button" onClick={onBack}>
          Back to notes
        </button>
        <span class="crumb">{path.join(' · ')}</span>
        {!trashed && <Toolbar model={model} note={note} />}
      </div>
      {trashed && (
        <div class="trash-banner">
          <div>
            <p class="trash-title">This note is in the Trash</p>
            <p>It's read-only. Restore it to edit.</p>
          </div>
          <div class="trash-actions">
            <button type="button" class="button button-danger-outline" onClick={() => act.deletePermanently(model, note.id, note.title)}>
              Delete permanently…
            </button>
            <button type="button" class="button button-primary" onClick={() => model.restore(note.id)}>
              Restore note
            </button>
          </div>
        </div>
      )}
      <div class="editor-scroll">
        <div class="editor-page">
          {/* A one-row textarea so long titles wrap; a title is one line, so Enter moves on and pasted line breaks become spaces. */}
          <textarea
            ref={titleRef}
            class="note-title"
            aria-label="Title"
            placeholder="Title"
            rows={1}
            value={title}
            readOnly={trashed}
            onInput={(e) => model.editTitle(e.currentTarget.value.replace(/\r?\n/g, ' '))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                document.getElementById('note-body')?.focus()
              }
            }}
          />
          <p class="edited">{editedLine(note.modified, model.now())}</p>
          <textarea
            id="note-body"
            class="note-body"
            aria-label="Note"
            placeholder="Start writing…"
            value={textareaValue(body)}
            readOnly={trashed}
            spellcheck
            autocapitalize="sentences"
            onInput={(e) => model.editBody(bodyFromTextarea(e.currentTarget.value, body))}
          />
        </div>
      </div>
    </div>
  )
}

function Toolbar({ model, note }: { model: AppModel; note: Note }) {
  const download = () => {
    model.flush()
    const n = model.openNote.value!
    const tagNames = model.tags.value.filter((t) => n.tagIds.includes(t.id)).map((t) => t.name)
    saveText(noteFileName(n), noteMarkdown(n, tagNames))
  }
  return (
    <div role="toolbar" aria-label="Note" class="toolbar">
      <button type="button" class="tool" aria-pressed={note.pinned} onClick={() => model.togglePin(note.id)}>
        Pinned
      </button>
      <MenuButton
        label="Tags"
        ariaLabel="Tags"
        class="tool"
        items={() => [
          ...model.tags.value.map((t) => ({
            label: t.name,
            kind: 'checkbox' as const,
            checked: (model.openNote.value?.tagIds ?? []).includes(t.id),
            onSelect: () => model.toggleTag(note.id, t.id),
          })),
          'separator',
          { label: 'New tag…', onSelect: () => act.newTag(model, (id) => model.toggleTag(note.id, id)) },
        ]}
      />
      <MenuButton
        label="Move"
        ariaLabel="Move"
        class="tool"
        items={() => [
          { label: 'No notebook', kind: 'radio', checked: note.notebookId === null, onSelect: () => model.move(note.id, null) },
          ...notebookTree(model.notebooks.value).map(({ nb, depth }) => ({
            label: nb.name,
            kind: 'radio' as const,
            depth,
            checked: note.notebookId === nb.id,
            onSelect: () => model.move(note.id, nb.id),
          })),
        ]}
      />
      <button type="button" class="tool" onClick={download}>
        Download .md
      </button>
      <button type="button" class="tool" onClick={() => model.trashWithUndo(note.id)}>
        Move to Trash
      </button>
    </div>
  )
}
