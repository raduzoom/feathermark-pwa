import type { AppModel } from '../model/app-model.ts'

export function UndoToast({ model }: { model: AppModel }) {
  const offer = model.undo.value
  return (
    <div role="status" class="toast" data-shown={offer ? 'true' : 'false'}>
      {offer && (
        <>
          <span>“{offer.title.trim() === '' ? 'Untitled' : offer.title}” moved to the Trash.</span>
          <button type="button" class="toast-action" onClick={() => model.undoLastTrash()}>
            Undo
          </button>
        </>
      )}
    </div>
  )
}

export function ErrorToast({ model }: { model: AppModel }) {
  const message = model.error.value
  if (!message) return null
  return (
    <div role="alert" class="toast toast-error" data-shown="true">
      <span>{message}</span>
      <button type="button" class="toast-action" onClick={() => model.clearError()}>
        OK
      </button>
    </div>
  )
}
