// The card every account screen sits in (log in, create account, recovery; the unlock screen has its own): the
// brand, an optional step line, the title, the content, an error line and the buttons.
import type { ComponentChildren } from 'preact'
import { DialogHost } from '../Dialog.tsx'
import { Logo } from '../Logo.tsx'

export function AccountFrame(props: { step?: string; title: string; children: ComponentChildren; onSubmit?: () => void; buttons: ComponentChildren }) {
  const body = (
    <>
      <div class="account-content">{props.children}</div>
      <div class="account-buttons">{props.buttons}</div>
    </>
  )
  return (
    <div class="account-screen">
      <div class="glow glow-mint" aria-hidden="true" />
      <div class="glow glow-peach" aria-hidden="true" />
      <main class="account-card">
        <p class="brand">
          <Logo size={28} />
          FeatherMark
        </p>
        {props.step && <p class="account-step">{props.step}</p>}
        <h1 class="account-title">{props.title}</h1>
        {props.onSubmit ? (
          <form
            class="account-form"
            onSubmit={(e) => {
              e.preventDefault()
              props.onSubmit!()
            }}
          >
            {body}
          </form>
        ) : (
          <div class="account-form">{body}</div>
        )}
      </main>
      <DialogHost />
    </div>
  )
}

export function ErrorLine({ text }: { text: string | null }) {
  return text ? (
    <p role="alert" class="account-error">
      {text}
    </p>
  ) : null
}

export function Field(props: {
  label: string
  value: string
  onInput: (v: string) => void
  type?: 'email' | 'password' | 'text'
  autoComplete?: string
  placeholder?: string
  inputMode?: 'numeric' | 'text'
  mono?: boolean
  inputRef?: (el: HTMLInputElement | null) => void
}) {
  return (
    <label class="field">
      <span class="field-label">{props.label}</span>
      <input
        ref={props.inputRef}
        class={props.mono ? 'field-input field-mono' : 'field-input'}
        // preact's types split <input> by type; any of these three takes the same attributes
        type={(props.type ?? 'text') as 'text'}
        autoComplete={props.autoComplete}
        placeholder={props.placeholder}
        inputMode={props.inputMode}
        spellcheck={false}
        autoCapitalize="off"
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
    </label>
  )
}

/** A primary submit button that says what it's doing while it works, and can't be pressed twice. */
export function WorkingButton(props: { title: string; workingTitle: string; working: boolean; enabled: boolean; submit?: boolean; onClick?: () => void }) {
  return (
    <button
      type={props.submit === false ? 'button' : 'submit'}
      class="button button-primary"
      disabled={!props.enabled || props.working}
      aria-busy={props.working}
      onClick={props.onClick}
    >
      {props.working ? props.workingTitle : props.title}
    </button>
  )
}
