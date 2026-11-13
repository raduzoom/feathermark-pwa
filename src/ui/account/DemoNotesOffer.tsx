// After logging in or creating an account from a demo where notes were written (web design "The demo"): "Add the 2
// notes you wrote here to your account?" with "Add notes" and "Don't add". Sample notes are never offered.
import { useEffect, useRef } from 'preact/hooks'
import type { SessionModel } from '../../model/session.ts'

export function DemoNotesOffer({ session }: { session: SessionModel }) {
  const offer = session.demoOffer.value
  return offer ? <OfferDialog session={session} count={offer.count} /> : null
}

function OfferDialog({ session, count }: { session: SessionModel; count: number }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current!
    d.showModal()
    return () => {
      if (d.open) d.close()
    }
  }, [])
  // one note: copy for approval (ui-copy.md gives only the plural)
  const title = count === 1 ? 'Add the note you wrote here to your account?' : `Add the ${count} notes you wrote here to your account?`
  return (
    <dialog
      ref={ref}
      class="dialog"
      aria-labelledby="demo-offer-title"
      onCancel={(e) => {
        e.preventDefault()
        session.dismissDemoNotes()
      }}
    >
      <h2 id="demo-offer-title" class="dialog-title">
        {title}
      </h2>
      <div class="dialog-actions">
        <button type="button" class="button" onClick={() => session.dismissDemoNotes()}>
          Don't add
        </button>
        <button type="button" class="button button-primary" autoFocus onClick={() => session.addDemoNotes()}>
          Add notes
        </button>
      </div>
    </dialog>
  )
}
