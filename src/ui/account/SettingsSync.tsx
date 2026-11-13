// Settings on the web (web design plan: a dialog with one page, "Sync"), opened from the account menu's "Settings…".
// Ported from SyncSettingsView.swift: the email and the status line, Feather Cloud storage, "Keep my notes on this
// browser", devices (this browser, and "Sign out" for another), sync conflicts; then the web's own "Change password…",
// "Download all notes (.zip)" and "Delete account…".
import { signal } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { CloudDevice } from '../../core/sync/api.ts'
import { zipStored } from '../../core/zip.ts'
import type { AppModel } from '../../model/app-model.ts'
import type { SessionModel } from '../../model/session.ts'
import { cloudAgo, cloudUsage, settingsLine, syncStatusText } from '../../model/sync-text.ts'
import { confirm } from '../Dialog.tsx'
import { saveBytes } from '../download.ts'

const open = signal(false)

export function openSettings(): void {
  open.value = true
}

/** Lock and sign-out close Settings: its sync-conflicts list holds names. */
export function closeSettings(): void {
  open.value = false
}

export function SettingsSync({ session, model }: { session: SessionModel; model: AppModel }) {
  return open.value ? <SettingsDialog session={session} model={model} /> : null
}

type Pane = 'main' | 'password' | 'delete'

function SettingsDialog({ session, model }: { session: SessionModel; model: AppModel }) {
  const ref = useRef<HTMLDialogElement>(null)
  /** Ticked while turning Keep on is under way, before the session says it is on. */
  const [turningOn, setTurningOn] = useState(false)
  const returnTo = useRef<Element | null>(document.activeElement)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [devices, setDevices] = useState<CloudDevice[] | null>(null)
  const [pane, setPane] = useState<Pane>('main')
  const keep = session.keep.value
  const state = session.state.value
  const email = state.kind === 'unlocked' ? state.email : ''
  const account = session.cloudAccount.value
  const now = Date.now()

  const loadDevices = () =>
    session
      .account()
      .devices()
      .then(setDevices, (e: unknown) => setError(session.message(e)))

  useEffect(() => {
    const d = ref.current!
    d.showModal()
    void session.refreshAccount().catch(() => undefined)
    void loadDevices()
    return () => {
      // locked or signed out meanwhile: the dialog doesn't come back by itself after unlocking
      open.value = false
      if (d.open) d.close()
      ;(returnTo.current as HTMLElement | null)?.focus?.()
    }
  }, [])

  const close = () => (open.value = false)
  /** Runs an action with the buttons held and its failure shown. */
  const act = async (body: () => Promise<void>) => {
    setWorking(true)
    setError(null)
    setNotice(null)
    try {
      await body()
    } catch (e) {
      setError(session.message(e))
    } finally {
      setWorking(false)
    }
  }
  const setKeep = (on: boolean) => act(() => session.setKeep(on))

  const signOutDevice = (d: CloudDevice) =>
    confirm({
      title: `Sign out ${d.name}?`,
      message: 'It stops syncing and keeps its notes. It can sign in again with your password.',
      button: `Sign out ${d.name}`,
      onConfirm: () =>
        void act(async () => {
          await session.account().revoke(d.id)
          await loadDevices()
        }),
    })

  const download = () =>
    act(async () => {
      const entries = await session.exportLibrary()
      saveBytes('FeatherMark Export.zip', zipStored(entries, Date.now()), 'application/zip')
    })

  const status = syncStatusText({ status: session.status.value, plan: account?.plan ?? null, billingEnabled: account?.billingEnabled ?? false, now })
  const plan = account?.plan
  const conflicts = session.conflicts()

  return (
    <dialog
      ref={ref}
      class="dialog settings"
      aria-labelledby="settings-title"
      onCancel={(e) => {
        e.preventDefault()
        if (pane !== 'main') setPane('main')
        else close()
      }}
    >
      <h2 id="settings-title" class="dialog-title">
        Settings
      </h2>
      {pane === 'password' ? (
        <PasswordForm
          working={working}
          error={error}
          onCancel={() => (setError(null), setPane('main'))}
          onSubmit={(current, next) =>
            void act(async () => {
              await session.changePassword(current, next)
              setPane('main')
              setNotice('Your password is changed. Your other devices sign in again with the new one.')
            })
          }
        />
      ) : pane === 'delete' ? (
        <DeleteForm
          working={working}
          error={error}
          onCancel={() => (setError(null), setPane('main'))}
          onSubmit={(password) => void act(() => session.deleteAccount(password))}
        />
      ) : (
        <section aria-labelledby="settings-sync" class="settings-page">
          <h3 id="settings-sync" class="settings-heading">
            Sync
          </h3>
          <div class="settings-account">
            <span class="settings-avatar" aria-hidden="true">
              {email.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <p class="settings-email">{email}</p>
              <p class="settings-meta">{settingsLine(status)}</p>
            </div>
          </div>

          {plan && plan.quotaBytes > 0 && (
            <div class="settings-group">
              <h4 class="settings-subheading">Feather Cloud</h4>
              <progress class="settings-usage" value={plan.usedBytes} max={plan.quotaBytes} aria-label="Storage used" />
              <p class="settings-meta">{cloudUsage(plan.usedBytes, plan.quotaBytes)}</p>
            </div>
          )}

          <label class="account-check">
            <input
              type="checkbox"
              checked={keep || turningOn}
              disabled={working}
              aria-describedby="settings-keep-note"
              onChange={(e) => {
                if (e.currentTarget.checked) {
                  // ticked at once; a browser that refuses to store it unticks it, with the message
                  setTurningOn(true)
                  void setKeep(true).then(() => setTurningOn(false))
                } else {
                  // turning it off waits for the answer: the box stays ticked until "Remove"
                  e.currentTarget.checked = true
                  confirm({
                    title: 'Remove the copy of your notes from this browser?',
                    message: 'They stay in your account.',
                    button: 'Remove',
                    onConfirm: () => void setKeep(false),
                  })
                }
              }}
            />
            <span>Keep my notes on this browser</span>
          </label>
          <p id="settings-keep-note" class="settings-note">
            Your notes stay here, encrypted, so the next visit opens without downloading them. Only your password can unlock them.
          </p>

          <div class="settings-group">
            <h4 class="settings-subheading" id="settings-devices">
              Devices
            </h4>
            <ul class="settings-list" aria-labelledby="settings-devices">
              {(devices ?? []).map((d) => (
                <li key={d.id} class="settings-row">
                  <div>
                    <p class="settings-row-title">{d.current ? `${d.name} (this browser)` : d.name}</p>
                    {!d.current && <p class="settings-meta">Last synced {cloudAgo(Date.parse(d.lastSeenAt), now)}</p>}
                  </div>
                  {!d.current && (
                    <button type="button" class="button" disabled={working} aria-label={`Sign out ${d.name}`} onClick={() => signOutDevice(d)}>
                      Sign out
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div class="settings-group">
            <h4 class="settings-subheading" id="settings-conflicts">
              Sync conflicts
            </h4>
            <p class="settings-meta">When two devices change a note at once, Feather keeps both. Nothing is overwritten.</p>
            {conflicts.length > 0 && (
              <ul class="settings-list" aria-labelledby="settings-conflicts">
                {conflicts.map((c) => (
                  <li key={c.id} class="settings-row">
                    <p class="settings-row-title">
                      {c.lostName} (renamed on {c.device})
                    </p>
                    <button
                      type="button"
                      class="button"
                      aria-label={`Show ${c.lostName}`}
                      onClick={() => {
                        model.select(c.type === 'tag' ? { kind: 'tag', id: c.itemId } : { kind: 'notebook', id: c.itemId })
                        close()
                      }}
                    >
                      Show
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div class="settings-group settings-actions">
            <button type="button" class="button" disabled={working} onClick={() => (setError(null), setNotice(null), setPane('password'))}>
              Change password…
            </button>
            <button type="button" class="button" disabled={working} onClick={() => void download()}>
              Download all notes (.zip)
            </button>
            <button type="button" class="button button-danger-outline" disabled={working} onClick={() => (setError(null), setNotice(null), setPane('delete'))}>
              Delete account…
            </button>
          </div>
          {notice && (
            <p role="status" class="settings-meta">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" class="dialog-error">
              {error}
            </p>
          )}
        </section>
      )}
      {pane === 'main' && (
        <div class="dialog-actions">
          <button type="button" class="button button-primary" onClick={close}>
            Done
          </button>
        </div>
      )}
    </dialog>
  )
}

function PasswordForm(p: { working: boolean; error: string | null; onCancel: () => void; onSubmit: (current: string, next: string) => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  return (
    <form
      class="settings-page"
      aria-labelledby="settings-password"
      onSubmit={(e) => {
        e.preventDefault()
        p.onSubmit(current, next)
      }}
    >
      <h3 id="settings-password" class="settings-heading">
        Change password
      </h3>
      <p class="settings-meta">We never see this password, so we can't reset it for you. Your recovery key stays the same.</p>
      <label class="field">
        <span class="field-label">Current password</span>
        <input class="field-input" type="password" autoComplete="current-password" autoFocus value={current} onInput={(e) => setCurrent(e.currentTarget.value)} />
      </label>
      <label class="field">
        <span class="field-label">New password</span>
        <input class="field-input" type="password" autoComplete="new-password" value={next} onInput={(e) => setNext(e.currentTarget.value)} />
      </label>
      {p.error && (
        <p role="alert" class="dialog-error">
          {p.error}
        </p>
      )}
      <div class="dialog-actions">
        <button type="button" class="button" onClick={p.onCancel}>
          Cancel
        </button>
        <button type="submit" class="button button-primary" disabled={p.working || current === '' || next === ''}>
          Change password
        </button>
      </div>
    </form>
  )
}

function DeleteForm(p: { working: boolean; error: string | null; onCancel: () => void; onSubmit: (password: string) => void }) {
  const [password, setPassword] = useState('')
  return (
    <form
      class="settings-page"
      aria-labelledby="settings-delete"
      onSubmit={(e) => {
        e.preventDefault()
        p.onSubmit(password)
      }}
    >
      <h3 id="settings-delete" class="settings-heading">
        Delete account
      </h3>
      <p class="settings-meta">
        Your notes are deleted from Feather Cloud and every device is signed out. Notes already on a device stay there. This can't be undone.
      </p>
      <label class="field">
        <span class="field-label">Password</span>
        <input class="field-input" type="password" autoComplete="current-password" autoFocus value={password} onInput={(e) => setPassword(e.currentTarget.value)} />
      </label>
      {p.error && (
        <p role="alert" class="dialog-error">
          {p.error}
        </p>
      )}
      <div class="dialog-actions">
        <button type="button" class="button" onClick={p.onCancel}>
          Cancel
        </button>
        <button type="submit" class="button button-danger" disabled={p.working || password === ''}>
          Delete account
        </button>
      </div>
    </form>
  )
}
