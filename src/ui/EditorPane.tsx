// The open note: breadcrumb, toolbar, title, edited line and the Markdown editor.
import { useLayoutEffect, useRef } from 'preact/hooks'
import type { Note } from '../core/library/types.ts'
import type { AppModel } from '../model/app-model.ts'
import { editedLine } from '../model/format.ts'
import * as act from './actions.ts'
import { downloadOpenNote } from './download.ts'
import { notebookTree } from './LibraryPanel.tsx'
import { DotsIcon, Icon } from './icons.tsx'
import { MenuButton } from './Menu.tsx'
import { notebookInfo } from './notebook-tint.ts'
import { NoteEditor } from './NoteEditor.tsx'

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
  const trashed = note.trashedAt !== null
  const path: string[] = []
  for (let id = note.notebookId; id; ) {
    const nb = model.notebooks.value.find((n) => n.id === id)
    if (!nb) break
    path.unshift(nb.name)
    id = nb.parentId
  }
  const dot = note.notebookId ? notebookInfo(model.notebooks.value).get(note.notebookId)?.tint : undefined

  return (
    <div class="editor-body">
      <div class="editor-head">
        <button type="button" class="back-button" onClick={onBack}>
          Back to notes
        </button>
        {/* "● Projects › Work": the notebook's dot, then its path, the note's own notebook last */}
        <p class="crumb">
          {path.length > 0 && <span class="nb-dot" data-tint={dot} aria-hidden="true" />}
          {path.map((name, i) => (
            <span key={i} class={i === path.length - 1 ? 'crumb-here' : undefined}>
              {i > 0 && <Icon name="chevron" size={12} />}
              {name}
            </span>
          ))}
        </p>
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
            readOnly={trashed || model.readOnly.value}
            onInput={(e) => model.editTitle(e.currentTarget.value.replace(/\r?\n/g, ' '))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                document.getElementById('note-body')?.focus()
              }
            }}
          />
          <p class="edited">{editedLine(note.modified, model.now())}</p>
          {model.openNoteLoading.value && (
            <p class="note-loading" role="status">
              Loading this note…
            </p>
          )}
          <NoteEditor model={model} />
        </div>
      </div>
    </div>
  )
}

function Toolbar({ model, note }: { model: AppModel; note: Note }) {
  // What the note is (pin, tags, notebook), then how it shows (Preview or Markdown), then the rare and destructive
  // actions under More.
  const raw = model.editorRaw.value
  return (
    <div role="toolbar" aria-label="Note" class="toolbar">
      <div class="tool-group">
        {/* named "Pinned" with its pressed state; it reads "Pin" until pressed (the name holds the visible label) */}
        <button type="button" class="tool" aria-label="Pinned" aria-pressed={note.pinned} onClick={() => model.togglePin(note.id)}>
          <Icon name="pin" />
          {note.pinned ? 'Pinned' : 'Pin'}
        </button>
        <MenuButton
          label={
            <>
              <Icon name="tag" />
              Tags
            </>
          }
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
            { label: 'New tag…', icon: <Icon name="plus" />, onSelect: () => act.newTag(model, (id) => model.toggleTag(note.id, id)) },
          ]}
        />
        <MenuButton
          label={
            <>
              <Icon name="move" />
              Move
            </>
          }
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
      </div>
      <div role="group" aria-label="View" class="segment">
        <button type="button" class="segment-option" aria-pressed={!raw} onClick={() => raw && model.toggleRaw()}>
          Preview
        </button>
        <button type="button" class="segment-option" aria-pressed={raw} onClick={() => !raw && model.toggleRaw()}>
          Markdown
        </button>
      </div>
      <MenuButton
        label={
          <>
            More
            <DotsIcon />
          </>
        }
        ariaLabel="More"
        class="tool"
        items={() => [
          // a body that hasn't arrived would be saved as an empty file
          { label: 'Download .md', icon: <Icon name="download" />, disabled: model.openNoteLoading.value, onSelect: () => downloadOpenNote(model) },
          'separator',
          { label: 'Move to Trash', icon: <Icon name="trash" />, danger: true, onSelect: () => model.trashWithUndo(note.id) },
        ]}
      />
    </div>
  )
}
