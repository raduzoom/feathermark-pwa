// Dialog-backed actions shared by the library panel, the toolbar and the row menus.
import type { AppModel } from '../model/app-model.ts'
import { deleteNotebookConfirmation, deletePermanentlyConfirmation, deleteTagConfirmation, emptyTrashConfirmation } from '../model/format.ts'
import { askName, confirm } from './Dialog.tsx'

/** Runs a model action and returns the model's error message, if it refused (and clears it). */
function attempt(model: AppModel, act: () => void): string | null {
  act()
  const message = model.error.value
  model.clearError()
  return message
}

export function newNotebook(model: AppModel, parentId: string | null): void {
  askName({ title: 'New notebook', button: 'Create', submit: (name) => attempt(model, () => model.createNotebook(name, parentId)) })
}

export function renameNotebook(model: AppModel, id: string, current: string): void {
  askName({ title: 'Rename notebook', initial: current, button: 'Rename', submit: (name) => attempt(model, () => model.renameNotebook(id, name)) })
}

export function deleteNotebook(model: AppModel, id: string, name: string): void {
  const all = model.notebooks.value
  const below = (parent: string): number => all.filter((n) => n.parentId === parent).reduce((s, n) => s + 1 + below(n.id), 0)
  const notes = model.counts.value.notebooks.get(id) ?? 0
  const c = deleteNotebookConfirmation(name, below(id), notes)
  confirm({ ...c, onConfirm: () => model.deleteNotebook(id) })
}

export function newTag(model: AppModel, then?: (tagId: string) => void): void {
  askName({
    title: 'New tag',
    button: 'Create',
    submit: (name) => {
      let id: string | null = null
      const problem = attempt(model, () => (id = model.createTag(name)?.id ?? null))
      if (!problem && id && then) then(id)
      return problem
    },
  })
}

export function renameTag(model: AppModel, id: string, current: string): void {
  askName({ title: 'Rename tag', initial: current, button: 'Rename', submit: (name) => attempt(model, () => model.renameTag(id, name)) })
}

export function deleteTag(model: AppModel, id: string, name: string): void {
  confirm({ ...deleteTagConfirmation(name), onConfirm: () => model.deleteTag(id) })
}

export function emptyTrash(model: AppModel): void {
  confirm({ ...emptyTrashConfirmation(model.counts.value.trash), onConfirm: () => model.emptyTrash() })
}

export function deletePermanently(model: AppModel, id: string, title: string): void {
  confirm({ ...deletePermanentlyConfirmation(title), onConfirm: () => model.deletePermanently(id) })
}
