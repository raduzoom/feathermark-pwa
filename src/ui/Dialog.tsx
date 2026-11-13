// One modal dialog at a time, on <dialog> with showModal(): it traps focus and makes the page behind inert.
// Escape cancels. A name dialog stays open and shows the error when the action is refused.
import { signal } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'

/** The screen a dialog was opened from: the notes ('app', the default) or the unlock screen. A dialog shows only on
 *  its own screen, so one holding a note title or a notebook or tag name never shows on the unlock screen. */
export type DialogScreen = 'app' | 'unlock'

export type DialogSpec = { screen?: DialogScreen } & (
  | { kind: 'name'; title: string; initial?: string; button: string; submit: (name: string) => string | null }
  | { kind: 'confirm'; title: string; message: string; button: string; onConfirm: () => void }
)

export const activeDialog = signal<DialogSpec | null>(null)

export function askName(spec: Omit<Extract<DialogSpec, { kind: 'name' }>, 'kind'>): void {
  activeDialog.value = { kind: 'name', ...spec }
}

export function confirm(spec: Omit<Extract<DialogSpec, { kind: 'confirm' }>, 'kind'>): void {
  activeDialog.value = { kind: 'confirm', ...spec }
}

/** The screen changed (locked, unlocked, signed out): a dialog opened on another screen goes, and its text with it. */
export function closeDialogsNotOn(screen: DialogScreen | null): void {
  const spec = activeDialog.peek()
  if (spec && (spec.screen ?? 'app') !== screen) activeDialog.value = null
}

export function DialogHost({ screen = 'app' }: { screen?: DialogScreen }) {
  const spec = activeDialog.value
  return spec && (spec.screen ?? 'app') === screen ? <Dialog key={spec.title} spec={spec} /> : null
}

function Dialog({ spec }: { spec: DialogSpec }) {
  const ref = useRef<HTMLDialogElement>(null)
  const returnTo = useRef<Element | null>(document.activeElement)
  const [name, setName] = useState(spec.kind === 'name' ? (spec.initial ?? '') : '')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const d = ref.current!
    d.showModal()
    return () => {
      if (d.open) d.close()
      ;(returnTo.current as HTMLElement | null)?.focus?.()
    }
  }, [])

  const done = () => (activeDialog.value = null)
  const submit = (e: Event) => {
    e.preventDefault()
    if (spec.kind === 'name') {
      if (name.trim() === '') return
      const problem = spec.submit(name)
      if (problem) setError(problem)
      else done()
    } else {
      done()
      spec.onConfirm()
    }
  }

  return (
    <dialog
      ref={ref}
      class="dialog"
      aria-labelledby="dialog-title"
      onCancel={(e) => {
        e.preventDefault()
        done()
      }}
      onKeyDown={(e) => {
        // Keep Tab inside: some browsers let it leave a modal dialog for their own controls.
        if (e.key !== 'Tab') return
        const items = [...ref.current!.querySelectorAll<HTMLElement>('input, button:not(:disabled)')]
        const i = items.indexOf(document.activeElement as HTMLElement)
        const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length
        e.preventDefault()
        items[next]?.focus()
      }}
    >
      <form method="dialog" onSubmit={submit}>
        <h2 id="dialog-title" class="dialog-title">
          {spec.title}
        </h2>
        {spec.kind === 'confirm' ? (
          <p class="dialog-message">{spec.message}</p>
        ) : (
          <label class="field">
            <span class="field-label">Name</span>
            <input
              class="field-input"
              value={name}
              autoFocus
              onInput={(e) => {
                setName(e.currentTarget.value)
                setError(null)
              }}
            />
          </label>
        )}
        {error && (
          <p role="alert" class="dialog-error">
            {error}
          </p>
        )}
        <div class="dialog-actions">
          <button type="button" class="button" onClick={done}>
            Cancel
          </button>
          <button
            type="submit"
            class={spec.kind === 'confirm' ? 'button button-danger' : 'button button-primary'}
            disabled={spec.kind === 'name' && name.trim() === ''}
          >
            {spec.button}
          </button>
        </div>
      </form>
    </dialog>
  )
}
