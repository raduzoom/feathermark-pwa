// The library column: "New note", views with counts, the notebook tree, the folding Tags section and Trash at the
// foot, each with its menu.
import { signal } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import type { Notebook, View } from '../core/library/types.ts'
import type { AppModel } from '../model/app-model.ts'
import * as act from './actions.ts'
import { MenuButton, type MenuItem } from './Menu.tsx'
import { notebookInfo } from './notebook-tint.ts'

/** Tags unfolded by hand. In memory only: folded again after a reload. */
const tagsOpen = signal(false)

/** 16 px line icons for the views (web-shell-redesign.dc.html). */
const ICONS: Record<'all' | 'recent' | 'pinned' | 'trash' | 'sidebar', ComponentChildren> = {
  all: <path d="M4 2h6l3 3v9H4zM6.5 8h4M6.5 11h4" />,
  recent: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </>
  ),
  pinned: <path d="M6 2h4l-.5 4.5L12 9H4l2.5-2.5zM8 9v5" />,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9" />,
  sidebar: <path d="M2.5 3.5h11v9h-11zM6 3.5v9" />,
}
const icon = (name: keyof typeof ICONS) => (
  <svg aria-hidden="true" class="lib-icon" width="16" height="16" viewBox="0 0 16 16">
    {ICONS[name]}
  </svg>
)

const sameView = (a: View, b: View) => a.kind === b.kind && ('id' in a ? a.id : null) === ('id' in b ? b.id : null)

/** Notebooks as a flat list in tree order, each with its depth. */
export function notebookTree(notebooks: Notebook[], exclude?: Set<string>): Array<{ nb: Notebook; depth: number }> {
  const out: Array<{ nb: Notebook; depth: number }> = []
  const walk = (parent: string | null, depth: number) => {
    for (const nb of notebooks) {
      if (nb.parentId !== parent || exclude?.has(nb.id)) continue
      out.push({ nb, depth })
      walk(nb.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/** `rail`: from 1000 px the column is shrunk to icons (shell.css hides the names); each row's name is then its tooltip. */
export function LibraryPanel({ model, onNavigate, rail, onToggleRail, beforeTrash }: { model: AppModel; onNavigate: () => void; rail: boolean; onToggleRail: () => void; beforeTrash?: ComponentChildren }) {
  const counts = model.counts.value
  const selection = model.selection.value
  const go = (v: View) => {
    model.select(v)
    onNavigate()
  }

  const viewRow = (view: View & { kind: 'all' | 'recent' | 'pinned' | 'trash' }, label: string, count: number | null, menu?: () => MenuItem[]) => (
    <li class={menu ? 'lib-item has-menu' : 'lib-item'}>
      <button
        type="button"
        class="lib-row"
        aria-label={label}
        title={rail ? label : undefined}
        aria-current={sameView(selection, view) ? 'page' : undefined}
        onClick={() => go(view)}
      >
        {icon(view.kind)}
        <span class="lib-name">{label}</span>
        {count ? <span class="lib-count">{count}</span> : null}
      </button>
      {menu && <MenuButton label="⋯" ariaLabel={`More for ${label}`} class="lib-more" items={menu} />}
    </li>
  )

  const notebookMenu = (nb: Notebook) => (): MenuItem[] => [
    { label: 'New notebook inside…', onSelect: () => act.newNotebook(model, nb.id) },
    { label: 'Rename…', onSelect: () => act.renameNotebook(model, nb.id, nb.name) },
    {
      label: 'Move to…',
      submenu: () => {
        const own = new Set(notebookTreeIds(model.notebooks.value, nb.id))
        return [
          { label: 'Top level', kind: 'radio', checked: nb.parentId === null, onSelect: () => model.moveNotebook(nb.id, null) },
          ...notebookTree(model.notebooks.value, own).map(({ nb: target, depth }) => ({
            label: target.name,
            kind: 'radio' as const,
            depth,
            checked: nb.parentId === target.id,
            onSelect: () => model.moveNotebook(nb.id, target.id),
          })),
        ]
      },
    },
    'separator',
    { label: 'Delete notebook…', danger: true, onSelect: () => act.deleteNotebook(model, nb.id, nb.name) },
  ]

  const tags = model.tags.value
  const info = notebookInfo(model.notebooks.value)
  // shown while unfolded by hand, or while a tag is the view, so the selected row never hides
  const tagsShown = tagsOpen.value || selection.kind === 'tag'

  return (
    <div class="library-body">
      <div class="library-top">
        <button type="button" class="new-note" aria-label="New note" title={rail ? 'New note' : undefined} onClick={() => model.newNote()}>
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" class="lib-icon">
            <path d="M8 3v10M3 8h10" />
          </svg>
          <span class="lib-label">New note</span>
        </button>
      </div>
      <div class="library-scroll">
        <ul class="lib-list">
          {viewRow({ kind: 'all' }, 'All notes', counts.all)}
          {viewRow({ kind: 'recent' }, 'Recent', null)}
          {viewRow({ kind: 'pinned' }, 'Pinned', counts.pinned)}
        </ul>

        <div class="lib-section">
          <h3 class="overline" id="notebooks-heading">
            Notebooks
          </h3>
          <button type="button" class="lib-add" aria-label="New notebook" title="New notebook" onClick={() => act.newNotebook(model, null)}>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" class="lib-icon">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
        </div>
        <ul class="lib-list" aria-labelledby="notebooks-heading">
          {notebookTree(model.notebooks.value).map(({ nb, depth }) => (
            <li class="lib-item has-menu" key={nb.id} data-depth={Math.min(depth, 6)}>
              <button
                type="button"
                class="lib-row"
                aria-label={nb.name}
                title={rail ? nb.name : undefined}
                aria-current={sameView(selection, { kind: 'notebook', id: nb.id }) ? 'page' : undefined}
                onClick={() => go({ kind: 'notebook', id: nb.id })}
              >
                {depth === 0 && <span class="nb-dot lib-dot" data-tint={info.get(nb.id)?.tint ?? 0} aria-hidden="true" />}
                <span class="lib-name">{nb.name}</span>
                {counts.notebooks.get(nb.id) ? <span class="lib-count">{counts.notebooks.get(nb.id)}</span> : null}
              </button>
              <MenuButton label="⋯" ariaLabel={`More for ${nb.name}`} class="lib-more" items={notebookMenu(nb)} />
            </li>
          ))}
        </ul>

        {/* the whole row folds and unfolds; its count sits in the counts column. "New tag" is inside the open panel */}
        <div class="lib-section lib-section-tags">
          <button
            type="button"
            class="lib-fold"
            aria-label="Tags"
            aria-expanded={tagsShown}
            aria-controls="library-tags"
            onClick={() => (tagsOpen.value = !tagsShown)}
          >
            <span class="overline">Tags</span>
            {/* points right while folded, down while open */}
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" class="lib-icon lib-fold-chevron">
              <path d="m6 4 4 4-4 4" />
            </svg>
            {tags.length > 0 && (
              <span class="lib-count lib-fold-count">
                <span class="lib-fold-dot" aria-hidden="true" />
                {tags.length}
              </span>
            )}
          </button>
        </div>
        {/* tags as chips; each keeps its menu, shown on hover or focus */}
        <ul class="lib-chips" id="library-tags" aria-label="Tags" hidden={!tagsShown}>
          {tagsShown &&
            tags.map((tag) => (
              <li class="lib-chip-item" key={tag.id}>
                <button
                  type="button"
                  class="lib-chip"
                  aria-label={`#${tag.name}`}
                  data-label={`#${tag.name}`}
                  aria-current={sameView(selection, { kind: 'tag', id: tag.id }) ? 'page' : undefined}
                  onClick={() => go({ kind: 'tag', id: tag.id })}
                >
                  #{tag.name}
                </button>
                <MenuButton
                  label="⋯"
                  ariaLabel={`More for #${tag.name}`}
                  class="lib-chip-more"
                  items={() => [
                    { label: 'Rename…', onSelect: () => act.renameTag(model, tag.id, tag.name) },
                    'separator',
                    { label: 'Delete tag…', danger: true, onSelect: () => act.deleteTag(model, tag.id, tag.name) },
                  ]}
                />
              </li>
            ))}
          {tagsShown && (
            <li class="lib-chip-item lib-chip-add-item">
              <button type="button" class="lib-chip lib-chip-add" aria-label="New tag" onClick={() => act.newTag(model, () => (tagsOpen.value = true))}>
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" class="lib-icon">
                  <path d="M8 3v10M3 8h10" />
                </svg>
                New tag
              </button>
            </li>
          )}
        </ul>

        <ul class="lib-list lib-foot">
          {/* the demo card, from 1000 px (App.tsx) */}
          {beforeTrash && <li class="lib-demo">{beforeTrash}</li>}
          {viewRow({ kind: 'trash' }, 'Trash', counts.trash, () => [
            { label: 'Empty Trash…', danger: true, onSelect: () => act.emptyTrash(model) },
          ])}
          {/* from 1000 px only (below that the library is the drawer); the last button, under Trash */}
          <li class="lib-item lib-rail-toggle">
            <button
              type="button"
              class="lib-row lib-rail-button"
              aria-label={rail ? 'Expand sidebar' : 'Collapse sidebar'}
              title={rail ? 'Expand sidebar' : undefined}
              onClick={onToggleRail}
            >
              {icon('sidebar')}
              <span class="lib-name">Collapse sidebar</span>
            </button>
          </li>
        </ul>
      </div>
    </div>
  )
}

function notebookTreeIds(notebooks: Notebook[], root: string): string[] {
  const out = [root]
  for (let i = 0; i < out.length; i++) for (const nb of notebooks) if (nb.parentId === out[i]) out.push(nb.id)
  return out
}
