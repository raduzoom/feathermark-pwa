// Where the app finds its account session. The session module (and with it the crypto worker client, the vault and
// the sync engine) loads only through import() when someone logs in, so the demo's first load carries none of it.
import { signal, type ReadonlySignal } from '@preact/signals'
import type { Library } from '../core/library/library.ts'
import type { AppModel } from './app-model.ts'
import type { SessionModel } from './session.ts'

const current = signal<SessionModel | null>(null)
/** The account session, once someone has logged in (or begun to); null in the demo. */
export const currentSession: ReadonlySignal<SessionModel | null> = current

/** The Feather Cloud origin built in, or null for the plain demo (VITE_FEATHER_CLOUD_URL). */
export const cloudOrigin: string | null = import.meta.env.VITE_FEATHER_CLOUD_URL || null

/** On opening the app: with a copy kept by "Keep my notes on this browser", the session loads and shows the unlock
 *  screen (or "FeatherMark is open in another tab."). Without one nothing loads: `indexedDB.databases()` lists without
 *  opening (opening would create the database), so the demo still stores nothing and fetches nothing. */
export async function resumeKept(o: { model: AppModel; demoLibrary: () => Library }): Promise<void> {
  try {
    if (!canResume) return
    const names: Array<string | undefined> = await indexedDB.databases().then((l) => l.map((d) => d.name), () => [])
    if (!names.includes('feathermark')) return
    const session = await startSession(o)
    await session.resume()
  } finally {
    pending.value = false
  }
}

const canResume = cloudOrigin !== null && typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function'
const pending = signal(canResume)
/** True from the page's start until resumeKept() has looked for a kept copy (and shown its unlock screen): the app
 *  shows neither the demo nor an account screen meanwhile, so the demo never flashes before the unlock screen and
 *  nobody logs in over a copy being opened. */
export const resuming: ReadonlySignal<boolean> = pending

/** The session, made once (the log-in and create-account screens call this first). */
export async function startSession(o: { model: AppModel; demoLibrary: () => Library }): Promise<SessionModel> {
  if (current.value) return current.value
  if (cloudOrigin === null) throw new Error('accounts are off in this build')
  const { createSession } = await import('./session.ts')
  current.value ??= createSession({ model: o.model, cloudOrigin, demoLibrary: o.demoLibrary })
  return current.value
}
