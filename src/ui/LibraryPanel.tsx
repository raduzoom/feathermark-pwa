// The library column: views with counts, the notebook tree and tags, each with its menu.
import type { Notebook, View } from '../core/library/types.ts'
import type { AppModel } from '../model/app-model.ts'
import * as act from './actions.ts'
import { MenuButton, type MenuItem } from './Menu.tsx'

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

export function LibraryPanel({ model, onNavigate }: { model: AppModel; onNavigate: () => void }) {
  const counts = model.counts.value
  const selection = model.selection.value
  const go = (v: View) => {
    model.select(v)
    onNavigate()
  }

  const viewRow = (view: View, label: string, count: number | null, menu?: () => MenuItem[]) => (
    <li class="lib-item">
      <button
        type="button"
        class="lib-row"
        aria-label={label}
        aria-current={sameView(selection, view) ? 'page' : undefined}
        onClick={() => go(view)}
      >
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

  return (
    <div class="library-body">
      <div class="library-top">
        <button type="button" class="new-note" onClick={() => model.newNote()}>
          New note
        </button>
      </div>
      <div class="library-scroll">
        <ul class="lib-list">
          {viewRow({ kind: 'all' }, 'All notes', counts.all)}
          {viewRow({ kind: 'recent' }, 'Recent', null)}
          {viewRow({ kind: 'pinned' }, 'Pinned', counts.pinned)}
          {viewRow({ kind: 'trash' }, 'Trash', counts.trash, () => [
            { label: 'Empty Trash…', danger: true, onSelect: () => act.emptyTrash(model) },
          ])}
        </ul>

        <div class="lib-section">
          <h3 class="overline" id="notebooks-heading">
            Notebooks
          </h3>
          <button type="button" class="lib-add" aria-label="New notebook" title="New notebook" onClick={() => act.newNotebook(model, null)}>
            +
          </button>
        </div>
        <ul class="lib-list" aria-labelledby="notebooks-heading">
          {notebookTree(model.notebooks.value).map(({ nb, depth }) => (
            <li class="lib-item" key={nb.id} data-depth={Math.min(depth, 6)}>
              <button
                type="button"
                class="lib-row"
                aria-label={nb.name}
                aria-current={sameView(selection, { kind: 'notebook', id: nb.id }) ? 'page' : undefined}
                onClick={() => go({ kind: 'notebook', id: nb.id })}
              >
                <span class="lib-name">{nb.name}</span>
                {counts.notebooks.get(nb.id) ? <span class="lib-count">{counts.notebooks.get(nb.id)}</span> : null}
              </button>
              <MenuButton label="⋯" ariaLabel={`More for ${nb.name}`} class="lib-more" items={notebookMenu(nb)} />
            </li>
          ))}
        </ul>

        <div class="lib-section">
          <h3 class="overline" id="tags-heading">
            Tags
          </h3>
          <button type="button" class="lib-add" aria-label="New tag" title="New tag" onClick={() => act.newTag(model)}>
            +
          </button>
        </div>
        <ul class="lib-list" aria-labelledby="tags-heading">
          {model.tags.value.map((tag) => (
            <li class="lib-item" key={tag.id}>
              <button
                type="button"
                class="lib-row"
                aria-label={`#${tag.name}`}
                aria-current={sameView(selection, { kind: 'tag', id: tag.id }) ? 'page' : undefined}
                onClick={() => go({ kind: 'tag', id: tag.id })}
              >
                <span class="lib-name">#{tag.name}</span>
              </button>
              <MenuButton
                label="⋯"
                ariaLabel={`More for #${tag.name}`}
                class="lib-more"
                items={() => [
                  { label: 'Rename…', onSelect: () => act.renameTag(model, tag.id, tag.name) },
                  'separator',
                  { label: 'Delete tag…', danger: true, onSelect: () => act.deleteTag(model, tag.id, tag.name) },
                ]}
              />
            </li>
          ))}
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
