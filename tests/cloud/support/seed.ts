// A library made by "another device": signs up from Node (the app's own account service, sync engine and key store,
// run in this process, with real Argon2id), writes notes and attachments and syncs them to the local Feather Cloud.
// The browser then logs in to an account that already holds them, as a person opening a big library would.
import { randomInt } from 'node:crypto'
import { systemClock } from '../../../src/core/clock.ts'
import { sha256Hex } from '../../../src/core/library/attachments.ts'
import { Library } from '../../../src/core/library/library.ts'
import { AccountService } from '../../../src/core/sync/account.ts'
import { ApiClient } from '../../../src/core/sync/api.ts'
import { BodyLoader } from '../../../src/core/sync/bodies.ts'
import { SyncEngine } from '../../../src/core/sync/engine.ts'
import { newUlid } from '../../../src/core/ulid.ts'
import { keyringCrypto } from '../../unit/support/keyring-crypto.ts'
import { CLOUD, PASSWORD, verificationCode } from './server'

/** "Another device" on a new account: signs up `email` from Node and gives its library and a sync that leaves
 *  nothing unsynced and every note body downloaded. */
export async function nodeDevice(email: string): Promise<{ library: Library; sync: () => Promise<void> }> {
  const ip = `10.${randomInt(1, 255)}.${randomInt(0, 256)}.${randomInt(1, 255)}`
  const fetchFrom: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('x-forwarded-for', ip)
    return fetch(input, { ...init, headers })
  }
  const base = `${CLOUD}/v1`
  const crypto = keyringCrypto().client
  const account = new AccountService({ base, crypto, fetch: fetchFrom })
  const libraryId = newUlid(systemClock)
  await account.startSignup(email, PASSWORD, libraryId)
  const s = await account.verify(email, await verificationCode(email), 'Seeding Mac')
  const library = new Library(systemClock)
  const api = new ApiClient({ base, token: s.token, fetch: fetchFrom, timeoutMs: 120_000 })
  const engine = new SyncEngine({ library, api, crypto, session: s.session, libraryId: s.libraryId, deviceName: 'Seeding Mac', clock: systemClock })
  const loader = new BodyLoader({ library, api, crypto, session: s.session, onProgress: () => undefined })
  const sync = async () => {
    for (let pass = 0; pass < 5; pass++) {
      await engine.syncOnce()
      for (const n of library.notes({ kind: 'all' })) if (library.syncItem(n.id)?.bodyLoaded === false) await loader.openNote(n.id)
      if (library.dirtyItems().length === 0) return
    }
    throw new Error(`seeding left ${library.dirtyItems().length} items unsynced`)
  }
  return { library, sync }
}

/** Signs up `email` and syncs `notes` notes (about 600 characters each) and `files` attachments of `fileBytes`. */
export async function seedAccount(email: string, o: { notes: number; files: number; fileBytes: number }): Promise<void> {
  const { library, sync } = await nodeDevice(email)
  const words = 'the quick brown fox jumps over the lazy dog while the river runs past the old mill '.repeat(7)
  for (let i = 0; i < o.files; i++) {
    const bytes = new Uint8Array(o.fileBytes).map((_, j) => (i * 31 + j) & 255)
    const a = library.addAttachment({ bytes, filename: `photo-${i}.png`, mime: 'image/png', sha256: await sha256Hex(bytes) })
    library.createNote({ title: `Photo ${i}`, body: `![photo](feather://attachment/${a.id})\n${words}` })
  }
  for (let i = o.files; i < o.notes; i++) library.createNote({ title: `Note ${String(i).padStart(4, '0')}`, body: `${i} ${words}` })
  await sync()
}
