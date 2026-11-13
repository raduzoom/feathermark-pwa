// The session model (Phase 20 Task 9): demo, unlocked, locked; the idle lock; lock and unlock through the vault;
// thrown out by the server; sign-out. Against the in-memory Feather Cloud, through the real ApiClient, SyncEngine,
// BodyLoader and the worker's real key store (Argon2id replaced by a fast stand-in, as in account.test.ts).
import { effect } from '@preact/signals'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Library } from '../../src/core/library/library.ts'
import { seedSampleLibrary } from '../../src/core/library/sample.ts'
import type { SyncItem } from '../../src/core/library/sync-state.ts'
import { AccountError, AccountService, accountMessage } from '../../src/core/sync/account.ts'
import { createAppModel, type AppModel } from '../../src/model/app-model.ts'
import { lockedTitle } from '../../src/model/format.ts'
import { createSession, unsyncedCount, type SessionModel, type SessionState } from '../../src/model/session.ts'
import { KeptStore } from '../../src/core/vault/kept-store.ts'
import { Vault } from '../../src/core/vault/vault.ts'
import { TabLock } from '../../src/core/vault/tab-lock.ts'
import { fakeClock } from './support/clock.ts'
import { fakeChannels, fakeLocks } from './support/locks.ts'
import { FakeCloud } from './support/fake-cloud.ts'
import { keyringCrypto } from './support/keyring-crypto.ts'
import { fakeTimers } from './support/timers.ts'

vi.mock('../../src/core/crypto/argon2.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/crypto/argon2.ts')>()
  const { fastDeriveRoot } = await import('./support/fast-argon2.ts')
  return { ...real, deriveRoot: fastDeriveRoot(real) }
})

const EMAIL = 'ada@example.com'
const PASSWORD = 'correct horse battery'
const LIBRARY = '01JC8ZQ6V4N1XG2H3K5M7P9R0T'
const MINUTE = 60_000

const settle = async () => {
  for (let i = 0; i < 100; i++) await new Promise((r) => setImmediate(r))
}

let revoked: string[]
beforeEach(() => {
  revoked = []
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => void revoked.push(u))
})
afterEach(() => vi.restoreAllMocks())

/** A cloud with an account, and a tab in the demo with a session model ready to log in. */
async function setup() {
  const cloud = new FakeCloud()
  const signup = new AccountService({ base: cloud.base, fetch: cloud.fetch, crypto: keyringCrypto().client })
  await signup.startSignup(EMAIL, PASSWORD, LIBRARY)
  await signup.verify(EMAIL, cloud.codes.get(EMAIL)!, 'Mac')
  const clock = fakeClock()
  const timers = fakeTimers(clock)
  const demo = () => {
    const lib = new Library(clock)
    seedSampleLibrary(lib, clock)
    return lib
  }
  const model: AppModel = createAppModel(demo(), { clock, setTimer: timers })
  const crypto = keyringCrypto()
  let cryptoMade = 0
  // this browser's IndexedDB and Web Locks, shared by every tab a test opens
  const idb = new IDBFactory()
  const locks = fakeLocks()
  const channels = fakeChannels()
  const browser = { kept: () => new KeptStore({ indexedDB: idb }), tabLock: () => new TabLock({ locks }), channel: channels }
  /** The first tab's store, which a test can hold back or make fail. */
  const store = new GatedStore({ indexedDB: idb })
  const session: SessionModel = createSession({
    model, cloudOrigin: 'https://cloud.test', fetch: cloud.fetch, clock, timers, random: () => 0.5, deviceName: 'Chrome on macOS',
    crypto: () => (cryptoMade++, crypto.client), demoLibrary: demo, ...browser, kept: () => store,
  })
  /** Another tab of the same browser, in the demo, with its own model and crypto worker. */
  const newTab = (o: { kept?: () => KeptStore } = {}) => {
    const m = createAppModel(demo(), { clock, setTimer: timers })
    const c = keyringCrypto()
    const t = createSession({
      model: m, cloudOrigin: 'https://cloud.test', fetch: cloud.fetch, clock, timers, random: () => 0.5, deviceName: 'Chrome on macOS',
      crypto: () => c.client, demoLibrary: demo, ...browser, ...o,
    })
    return { model: m, session: t, crypto: c }
  }
  return { cloud, clock, timers, model, crypto, session, made: () => cryptoMade, idb, locks, newTab, store, channels }
}
type Setup = Awaited<ReturnType<typeof setup>>

/** Logs in and lets the first sync finish. */
async function loggedIn() {
  const s = await setup()
  await s.session.logIn(EMAIL, PASSWORD)
  await settle()
  return s
}

/** A kept-copy store whose saves a test can hold back (`gate`) or make fail (`failing`). */
class GatedStore extends KeptStore {
  gate: Promise<void> | null = null
  failing = false
  /** Changes what a claim gives back (a copy that turned out to be another account's). */
  onClaim: ((v: Vault) => Vault) | null = null
  override async claim(...a: Parameters<KeptStore['claim']>): Promise<Vault | null> {
    const v = await super.claim(...a)
    return v && this.onClaim ? this.onClaim(v) : v
  }
  override async save(...a: Parameters<KeptStore['save']>): Promise<void> {
    if (this.gate) await this.gate
    if (this.failing) throw new Error('no space left')
    return super.save(...a)
  }
}
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((r) => (open = r))
  return { promise, open }
}
const HANDOVER_MS = 10_000

const databases = async (s: { idb: IDBFactory }) => (await s.idb.databases()).map((d) => d.name)
const keptVault = (s: { idb: IDBFactory }) => new KeptStore({ indexedDB: s.idb }).load()
const titles = (m: AppModel) => m.rows.value.map((r) => r.note.title)
const syncCalls = (s: Setup) => s.cloud.calls.filter((c) => c.path.startsWith('/sync/') || c.path.startsWith('/blobs/'))

describe('session', () => {
  test('starts in the demo and loads no crypto until someone logs in', async () => {
    const s = await setup()
    expect(s.session.state.value).toEqual({ kind: 'demo' })
    expect(s.made()).toBe(0)
    expect(s.cloud.calls.filter((c) => c.token !== null || c.path.startsWith('/auth/login'))).toEqual([])
    await s.session.logIn(EMAIL, PASSWORD)
    expect(s.session.state.value).toEqual({ kind: 'unlocked', email: EMAIL })
    // the demo's samples are gone: the account's library is a new one
    expect(titles(s.model)).toEqual([])
  })

  test('logging in with a wrong password stays in the demo with the message', async () => {
    const s = await setup()
    const e = await s.session.logIn(EMAIL, 'not the password').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(AccountError)
    expect(accountMessage(e)).toBe("That password doesn't match. Forgot it? Sign in with your recovery key instead.")
    expect(s.session.state.value).toEqual({ kind: 'demo' })
    expect(titles(s.model).length).toBeGreaterThan(0)
  })

  test('idle for 30 minutes locks; any noteActivity() resets', async () => {
    const s = await loggedIn()
    s.timers.tick(29 * MINUTE)
    s.session.noteActivity()
    s.timers.tick(29 * MINUTE)
    await settle()
    expect(s.session.state.value.kind).toBe('unlocked')
    s.timers.tick(1 * MINUTE + 1)
    await settle()
    expect(s.session.state.value).toEqual({ kind: 'locked', email: EMAIL, reason: 'idle' })
  })

  test('lock seals unsynced edits and unlock gives them back unchanged', async () => {
    const s = await loggedIn()
    s.model.newNote()
    s.model.editTitle('Secret plan')
    s.model.editBody('the treasure is under the oak')
    // still typing: the 500 ms save hasn't run, and nothing has synced
    const id = s.model.openNote.value!.id
    const files = await s.model.addFiles([new File([new Uint8Array([1, 2, 3])], 'oak.png', { type: 'image/png' })])
    const link = files[0]!.slice(files[0]!.indexOf('(') + 1, -1)
    const url = s.model.attachmentUrl(link)!.objectUrl
    s.model.setSearch('treasure')
    expect(s.crypto.held().sessions).toBe(1)

    // what the tab holds at the moment the unlock screen would show
    let atLock: { rows: number; open: unknown; search: string; revoked: string[] } | null = null
    const stop = effect(() => {
      if (s.session.state.value.kind === 'locked' && !atLock) {
        atLock = { rows: s.model.rows.value.length, open: s.model.openNote.value, search: s.model.searchText.value, revoked: [...revoked] }
      }
    })
    await s.session.lock('manual')
    stop()
    expect(s.session.state.value).toEqual({ kind: 'locked', email: EMAIL, reason: 'manual' })
    expect(atLock).toEqual({ rows: 0, open: null, search: '', revoked: [url] })
    // the key goes once the seal is done (lock's promise)
    expect(s.crypto.held()).toEqual({ sessions: 0, keks: 0 })
    expect(s.crypto.calls.some((c) => c.op === 'forget')).toBe(true)
    expect(s.model.draft.value).toBeNull()

    const before = s.cloud.calls.length
    let atUnlock: string[] | null = null
    const watch = effect(() => {
      if (s.session.state.value.kind === 'unlocked' && !atUnlock) atUnlock = s.cloud.calls.slice(before).map((c) => c.path)
    })
    await s.session.unlock(PASSWORD)
    watch()
    // opened from memory: no request before the notes show
    expect(atUnlock).toEqual([])
    expect(s.session.state.value).toEqual({ kind: 'unlocked', email: EMAIL })
    const note = s.model.openNote.value!
    expect(note).toMatchObject({ id, title: 'Secret plan', body: 'the treasure is under the oak' })
    expect(s.model.attachmentUrl(link)?.filename).toBe('oak.png')
    // the edit is still unsynced, and then syncs
    await settle()
    expect(s.cloud.items.has(id)).toBe(true)
  })

  test('typing during the seal is not lost', async () => {
    const s = await loggedIn()
    s.model.newNote()
    const id = s.model.openNote.value!.id
    s.model.editBody('first')
    const sealing = s.session.lock('manual')
    s.model.editBody('first and second')
    await sealing
    await s.session.unlock(PASSWORD)
    expect(s.model.rows.value.find((r) => r.note.id === id)).toBeTruthy()
    s.model.selectNote(id)
    expect(s.model.openNote.value!.body).toBe('first and second')
  })

  test('unlock with a wrong password gives the wrong-password message and keeps the vault', async () => {
    const s = await loggedIn()
    s.model.newNote()
    s.model.editTitle('Kept')
    await s.session.lock('manual')
    const e = await s.session.unlock('not the password').catch((x: unknown) => x)
    expect(accountMessage(e)).toBe("That password doesn't match. Forgot it? Sign in with your recovery key instead.")
    expect(s.session.state.value).toEqual({ kind: 'locked', email: EMAIL, reason: 'manual' })
    // the failed attempt's kek doesn't stay in the worker
    expect(s.crypto.held()).toEqual({ sessions: 0, keks: 0 })
    await s.session.unlock(PASSWORD)
    expect(titles(s.model)).toEqual(['Kept'])
  })

  test('a 401 locks with "Sign in again as <email>", keeps the edits and pushes them after signing in again', async () => {
    const s = await loggedIn()
    s.model.newNote()
    s.model.editTitle('Written before the revoke')
    s.model.flush()
    const id = s.model.openNote.value!.id
    // another device signs this one out
    for (const t of [...s.cloud.devices.keys()]) if (s.cloud.devices.get(t)!.name === 'Chrome on macOS') s.cloud.tokens.delete(t)
    s.session.pageHidden() // pushes at once (the engine's syncNow: a 0 ms timer)
    s.timers.tick(0)
    await settle()
    const state = s.session.state.value as Extract<SessionState, { kind: 'locked' }>
    expect(state).toEqual({ kind: 'locked', email: EMAIL, reason: 'signedOut' })
    expect(lockedTitle(state.email, state.reason)).toBe(`Sign in again as ${EMAIL}`)
    expect(s.model.rows.value).toEqual([])
    expect(s.cloud.items.has(id)).toBe(false)

    expect(accountMessage(await s.session.unlock('not the password').catch((x: unknown) => x))).toMatch(/^That password doesn't match/)
    await s.session.unlock(PASSWORD)
    expect(titles(s.model)).toEqual(['Written before the revoke'])
    await settle()
    expect(s.cloud.items.has(id)).toBe(true)
  })

  test('hiding the tab pushes at once', async () => {
    const s = await loggedIn()
    s.model.newNote()
    s.model.editTitle('Pushed when hidden')
    const before = syncCalls(s).length
    s.session.pageHidden()
    s.timers.tick(0)
    await settle()
    expect(syncCalls(s).slice(before).some((c) => c.path === '/sync/push')).toBe(true)
    expect(s.cloud.items.has(s.model.openNote.value!.id)).toBe(true)
  })

  test('signing out with unsynced edits asks first', async () => {
    const s = await loggedIn()
    s.cloud.fail(() => true, 'network', 1000)
    s.model.newNote()
    s.model.editTitle('Not synced')
    expect(s.session.hasUnsynced()).toBe(true)
    expect(s.session.shouldWarnOnClose()).toBe(true)
    expect(await s.session.signOut()).toBe('unsynced')
    expect(s.session.state.value.kind).toBe('unlocked')
    // locked, the vault's bookkeeping says the same
    await s.session.lock('manual')
    expect(await s.session.signOut()).toBe('unsynced')
    expect(s.session.state.value.kind).toBe('locked')
    expect(await s.session.signOut({ force: true })).toBe('done')
    expect(s.session.state.value).toEqual({ kind: 'demo' })
    // back to the demo's samples
    expect(titles(s.model).length).toBeGreaterThan(0)
    expect(s.session.hasUnsynced()).toBe(false)
  })

  test('signing out when everything synced ends the session on the server and drops the keys', async () => {
    const s = await loggedIn()
    s.model.newNote()
    s.model.editTitle('Synced')
    s.session.pageHidden()
    s.timers.tick(0)
    await settle()
    expect(s.session.hasUnsynced()).toBe(false)
    const tokens = s.cloud.tokens.size
    expect(await s.session.signOut()).toBe('done')
    await settle()
    expect(s.cloud.tokens.size).toBe(tokens - 1)
    expect(s.crypto.held()).toEqual({ sessions: 0, keks: 0 })
    expect(s.session.state.value).toEqual({ kind: 'demo' })
  })

  test('closing the tab with Keep off ends the session on the server; a page kept for back/forward does not', async () => {
    const s = await loggedIn()
    const tokens = s.cloud.tokens.size
    s.session.pageClosing(true)
    await settle()
    expect(s.cloud.tokens.size).toBe(tokens)
    s.session.pageClosing(false)
    await settle()
    expect(s.cloud.tokens.size).toBe(tokens - 1)
  })

  test('locking while a pull page is still on its way: after unlock the other device\'s note is there', async () => {
    const s = await loggedIn()
    // another device adds a note
    const model2 = createAppModel(new Library(s.clock), { clock: s.clock, setTimer: s.timers })
    const other = createSession({
      model: model2, cloudOrigin: 'https://cloud.test', fetch: s.cloud.fetch, clock: s.clock, timers: s.timers, random: () => 0.5,
      deviceName: 'Safari on iOS', crypto: () => keyringCrypto().client, demoLibrary: () => new Library(s.clock),
    })
    await other.logIn(EMAIL, PASSWORD)
    await settle()
    model2.newNote()
    model2.editTitle('Written on the phone')
    const phoneId = model2.openNote.value!.id
    other.pageHidden()
    s.timers.tick(0)
    await settle()
    other.dispose()
    // this tab's next pull is held open by the server
    const mine = new Set(s.cloud.devices.keys())
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let held = false
    s.cloud.hook = async (c) => {
      if (c.path === '/sync/pull' && !held && [...mine].some((t) => t === c.token && s.cloud.devices.get(t)?.name === 'Chrome on macOS')) {
        held = true
        await gate
      }
    }
    s.session.pageHidden()
    s.timers.tick(0)
    await settle()
    expect(held).toBe(true)
    // the page arrives while the tab is sealing
    const seal = s.crypto.client.seal
    const firstSeal: string[][] = []
    s.crypto.client.seal = async (...a) => {
      if (firstSeal.length === 0) firstSeal.push(a[1].map((r) => r.id))
      release()
      await settle()
      return seal(...a)
    }
    const locking = s.session.lock('manual')
    await settle()
    release()
    await locking
    s.crypto.client.seal = seal
    s.cloud.hook = null
    await s.session.unlock(PASSWORD)
    await settle()
    expect(titles(s.model)).toContain('Written on the phone')
    // lock waited for the pull to end: the snapshot it sealed already held the note
    expect(firstSeal[0]).toContain(phoneId)
  })

  for (const held of ['/sync/pull', 'PUT /blobs/'] as const) {
    test(`the notes leave the screen as soon as lock is asked for, while a request is held open (${held})`, async () => {
      const s = await loggedIn()
      s.model.newNote()
      s.model.editTitle('Secret plan')
      s.model.editBody('the treasure is under the oak')
      s.model.flush()
      const id = s.model.openNote.value!.id
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let holding = false
      s.cloud.hook = async (c) => {
        const what = held === '/sync/pull' ? c.path === '/sync/pull' : c.method === 'PUT' && c.path.startsWith('/blobs/')
        if (what && !holding) {
          holding = true
          await gate
        }
      }
      s.session.pageHidden()
      s.timers.tick(0)
      await settle()
      expect(holding).toBe(true)
      const locking = s.session.lock('manual')
      await settle()
      // the pass is still waiting on the server, but the unlock screen is up and nothing readable is on screen
      expect(s.session.state.value).toEqual({ kind: 'locked', email: EMAIL, reason: 'manual' })
      expect(s.model.rows.value).toEqual([])
      expect(s.model.openNote.value).toBeNull()
      expect(s.session.hasUnsynced()).toBe(held === 'PUT /blobs/')
      release()
      await locking
      s.cloud.hook = null
      expect(s.session.state.value).toMatchObject({ kind: 'locked', reason: 'manual' })
      await s.session.unlock(PASSWORD)
      expect(s.model.rows.value.map((r) => r.note.id)).toContain(id)
    })
  }

  /** A logged-in tab with two unsynced notes whose first upload the server holds open; lock() has been called. */
  async function lockingWhileUploading() {
    const s = await loggedIn()
    const made: string[] = []
    for (const t of ['First before lock', 'Second before lock']) {
      s.model.newNote()
      s.model.editTitle(t)
      s.model.editBody(`${t} body`)
      made.push(s.model.openNote.value!.id)
    }
    s.model.flush()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let holding = false
    s.cloud.hook = async (c) => {
      if (c.method === 'PUT' && !holding) {
        holding = true
        await gate
      }
    }
    s.session.pageHidden()
    s.timers.tick(0)
    await settle()
    expect(holding).toBe(true)
    const locking = s.session.lock('manual')
    await settle()
    return { s, made, release, locking }
  }

  test('unlock while the seal is still pending waits for it and gives back every edit made before lock', async () => {
    const { s, made, release, locking } = await lockingWhileUploading()
    expect(s.session.state.value.kind).toBe('locked')
    let done = false
    const unlocking = s.session.unlock(PASSWORD).then(() => void (done = true))
    await settle()
    expect(done).toBe(false)
    expect(s.session.state.value.kind).toBe('locked')
    release()
    await locking
    await unlocking
    s.cloud.hook = null
    expect(s.session.state.value.kind).toBe('unlocked')
    const ids = s.model.rows.value.map((r) => r.note.id)
    for (const id of made) expect(ids).toContain(id)
    s.model.selectNote(made[1]!)
    expect(s.model.openNote.value).toMatchObject({ title: 'Second before lock', body: 'Second before lock body' })
  })

  test('sign out while the seal is pending says at once that changes are unsynced', async () => {
    const { s, release, locking } = await lockingWhileUploading()
    const answer = await Promise.race([s.session.signOut(), settle().then(() => 'still waiting' as const)])
    expect(answer).toBe('unsynced')
    expect(s.session.state.value.kind).toBe('locked')
    release()
    await locking
    s.cloud.hook = null
    expect(s.session.vault()).not.toBeNull()
  })

  test('a seal that fails puts the notes back and stays unlocked', async () => {
    const s = await loggedIn()
    s.cloud.fail(() => true, 'network', 1000)
    s.model.newNote()
    s.model.editTitle('Not lost')
    const seal = s.crypto.client.seal
    s.crypto.client.seal = async () => {
      throw new Error('the crypto worker stopped')
    }
    await expect(s.session.lock('manual')).rejects.toThrow('the crypto worker stopped')
    s.crypto.client.seal = seal
    expect(s.session.state.value.kind).toBe('unlocked')
    expect(titles(s.model)).toEqual(['Not lost'])
    expect(s.session.hasUnsynced()).toBe(true)
  })

  test('a seal that fails says so: "Something went wrong. Try again." (Lock now, or the idle lock)', async () => {
    const s = await loggedIn()
    s.cloud.fail(() => true, 'network', 1000)
    s.model.newNote()
    s.model.editTitle('Still here')
    const seal = s.crypto.client.seal
    s.crypto.client.seal = async () => {
      throw new Error('the crypto worker stopped')
    }
    await expect(s.session.lock('manual')).rejects.toThrow()
    expect(s.model.error.value).toBe('Something went wrong. Try again.')
    s.model.clearError()
    // the idle lock fails the same way, with the same message
    s.timers.tick(30 * MINUTE + 1)
    await settle()
    s.crypto.client.seal = seal
    expect(s.session.state.value.kind).toBe('unlocked')
    expect(s.model.error.value).toBe('Something went wrong. Try again.')
    expect(titles(s.model)).toEqual(['Still here'])
  })

  test('a second logIn or begin while one is pending is refused, and nothing more is sent', async () => {
    const s = await setup()
    const signer = new AccountService({ base: s.cloud.base, fetch: s.cloud.fetch, crypto: s.crypto.client })
    const other = await signer.signIn(EMAIL, PASSWORD, 'Mac')
    const first = s.session.logIn(EMAIL, PASSWORD)
    await expect(s.session.logIn(EMAIL, PASSWORD)).rejects.toThrow('already signing in')
    await expect(s.session.begin(other)).rejects.toThrow('already signing in')
    // the refused account's key isn't left in the worker, nor its session on the server
    await settle()
    expect(s.crypto.calls.some((c) => c.op === 'forget' && c.args[0] === other.session)).toBe(true)
    expect(s.cloud.tokens.has(other.token)).toBe(false)
    await first
    expect(s.session.state.value).toEqual({ kind: 'unlocked', email: EMAIL })
    expect(s.cloud.calls.filter((c) => c.path === '/auth/login')).toHaveLength(2)
    // once signed in, a log-in is refused before it reaches the server
    const before = s.cloud.calls.length
    await expect(s.session.logIn(EMAIL, PASSWORD)).rejects.toThrow('already signed in')
    expect(s.cloud.calls.slice(before).filter((c) => c.path.startsWith('/auth/'))).toEqual([])
    // a failed log-in frees the way for the next
    await s.session.signOut({ force: true })
    await expect(s.session.logIn(EMAIL, 'not the password')).rejects.toBeInstanceOf(AccountError)
    await s.session.logIn(EMAIL, PASSWORD)
    expect(s.session.state.value.kind).toBe('unlocked')
  })

  test('the device name and the server info, for the screens', async () => {
    const s = await setup()
    expect(s.session.deviceName()).toBe('Chrome on macOS')
    s.cloud.billingEnabled = true
    await expect(s.session.serverInfo()).resolves.toMatchObject({ billingEnabled: true })
  })

  test('changes count as unsynced all through the seal', async () => {
    const s = await loggedIn()
    s.cloud.fail(() => true, 'network', 1000)
    s.model.newNote()
    s.model.editTitle('Not synced')
    const seen: boolean[] = []
    const seal = s.crypto.client.seal
    s.crypto.client.seal = async (...a) => {
      seen.push(s.session.hasUnsynced(), s.session.shouldWarnOnClose())
      return seal(...a)
    }
    const locking = s.session.lock('manual')
    seen.push(s.session.hasUnsynced())
    await locking
    seen.push(s.session.hasUnsynced())
    expect(seen).toEqual([true, true, true, true])
  })

  test('signing in again into an account whose key can\'t open the vault leaves the vault as it was', async () => {
    const s = await loggedIn()
    s.model.newNote()
    s.model.editTitle('Kept through it all')
    s.model.flush()
    for (const t of [...s.cloud.devices.keys()]) if (s.cloud.devices.get(t)!.name === 'Chrome on macOS') s.cloud.tokens.delete(t)
    s.session.pageHidden()
    s.timers.tick(0)
    await settle()
    expect(s.session.state.value).toMatchObject({ kind: 'locked', reason: 'signedOut' })
    const before = s.session.vault()!
    const kept = { token: before.token, deviceId: before.deviceId, wrapped: [...before.wrappedMasterPassword], salt: [...before.salt], kdf: { ...before.kdf } }
    // the account was deleted and made again with the same email and password: another master key
    s.cloud.accounts.delete(EMAIL)
    const again = new AccountService({ base: s.cloud.base, fetch: s.cloud.fetch, crypto: keyringCrypto().client })
    await again.startSignup(EMAIL, PASSWORD, LIBRARY)
    await again.verify(EMAIL, s.cloud.codes.get(EMAIL)!, 'Mac')
    const tokens = new Set(s.cloud.tokens)
    expect(await s.session.unlock(PASSWORD).catch((e: unknown) => e)).toBeInstanceOf(AccountError)
    await settle()
    const after = s.session.vault()!
    expect({ token: after.token, deviceId: after.deviceId, wrapped: [...after.wrappedMasterPassword], salt: [...after.salt], kdf: { ...after.kdf } }).toEqual(kept)
    expect(s.session.state.value).toMatchObject({ kind: 'locked', reason: 'signedOut' })
    // the session that sign-in made is ended, not left behind
    expect(s.cloud.tokens).toEqual(tokens)
  })

  test('Keep is off by default: lock and sign-out store nothing', async () => {
    const s = await loggedIn()
    expect(s.session.keep.value).toBe(false)
    s.model.newNote()
    s.model.editTitle('Secret plan')
    s.session.pageHidden()
    s.timers.tick(0)
    await settle()
    await s.session.lock('manual')
    expect(await databases(s)).toEqual([])
    await s.session.unlock(PASSWORD)
    expect(await s.session.signOut()).toBe('done')
    expect(await databases(s)).toEqual([])
  })

  test('Keep on saves the vault after every sync pass and every lock; a reload opens it offline', async () => {
    const s = await loggedIn()
    await s.session.setKeep(true)
    expect(s.session.keep.value).toBe(true)
    expect(s.session.shouldWarnOnClose()).toBe(false)
    expect(await databases(s)).toEqual(['feathermark'])
    s.model.newNote()
    s.model.editTitle('Secret plan')
    s.model.editBody('the treasure is under the oak')
    const id = s.model.openNote.value!.id
    // offline: the pass fails, and the kept copy still has the edit
    let offline = true
    s.cloud.fail(() => offline, 'network', 1000)
    s.session.pageHidden()
    s.timers.tick(0)
    await settle()
    expect((await keptVault(s))!.items.has(id)).toBe(true)
    // the tab closes (Keep on: the session stays) and a new one opens on the kept copy
    const tokens = s.cloud.tokens.size
    s.session.pageClosing(false)
    s.session.dispose()
    await settle()
    expect(s.cloud.tokens.size).toBe(tokens)
    const t = s.newTab()
    const before = s.cloud.calls.length
    await t.session.resume()
    expect(t.session.state.value).toEqual({ kind: 'locked', email: EMAIL, reason: 'kept' })
    expect(t.session.keep.value).toBe(true)
    await t.session.unlock(PASSWORD)
    expect(s.cloud.calls.slice(before)).toEqual([])
    expect(t.model.rows.value.map((r) => r.note.title)).toEqual(['Secret plan'])
    // and once the server answers again, the edit made offline in the closed tab syncs
    offline = false
    t.session.pageHidden()
    s.timers.tick(0)
    await settle()
    expect(s.cloud.items.has(id)).toBe(true)
    t.session.dispose()
  })

  test('a lock with Keep on saves the sealed vault: the kept copy is the in-memory vault', async () => {
    const s = await loggedIn()
    await s.session.setKeep(true)
    s.model.newNote()
    s.model.editTitle('Typed just before locking')
    await s.session.lock('manual')
    const v = (await keptVault(s))!
    expect([...v.items.keys()]).toEqual([...s.session.vault()!.items.keys()])
    expect(v.items.get(s.session.vault()!.items.keys().next().value!)!.meta).toEqual([...s.session.vault()!.items.values()][0]!.meta)
  })

  test('a second tab waits until it takes over; the first turns read-only and stops writing', async () => {
    const s = await loggedIn()
    await s.session.setKeep(true)
    s.model.newNote()
    s.model.editTitle('From the first tab')
    s.session.pageHidden()
    s.timers.tick(0)
    await settle()

    const t = s.newTab()
    await t.session.resume()
    expect(t.session.state.value).toEqual({ kind: 'locked', email: EMAIL, reason: 'otherTab' })
    expect(lockedTitle(EMAIL, 'otherTab')).toBe('FeatherMark is open in another tab.')
    // it can't unlock (and so can't write) from there
    await t.session.unlock(PASSWORD)
    expect(t.session.state.value).toMatchObject({ reason: 'otherTab' })

    // the first tab is typing when the second takes over: what it typed stays and is pushed
    s.model.editBody('typed in the first tab')
    await t.session.takeOver()
    await settle()
    expect(s.session.tab.value).toBe('lost')
    expect(s.model.readOnly.value).toBe(true)
    const first = s.model.openNote.value!
    expect(first.body).toBe('typed in the first tab')
    expect(s.cloud.items.has(first.id)).toBe(true)
    // nothing here changes the library any more, and nothing is saved from here
    s.model.newNote()
    s.model.editTitle('refused')
    expect(s.model.rows.value.map((r) => r.note.title)).toEqual(['From the first tab'])
    expect(t.session.state.value).toEqual({ kind: 'locked', email: EMAIL, reason: 'kept' })
    await t.session.unlock(PASSWORD)
    expect(t.model.rows.value.map((r) => r.note.title)).toEqual(['From the first tab'])
    t.model.newNote()
    t.model.editTitle('From the second tab')
    t.session.pageHidden()
    s.timers.tick(0)
    await settle()
    const saved = (await keptVault(s))!
    expect(saved.items.has(t.model.openNote.value!.id)).toBe(true)

    // "Use it here" in the first tab: back, with what the second tab kept, and no password
    await s.session.takeOver()
    await settle()
    expect(s.session.tab.value).toBe('here')
    expect(s.model.readOnly.value).toBe(false)
    expect(s.model.rows.value.map((r) => r.note.title).sort()).toEqual(['From the first tab', 'From the second tab'])
    expect(t.session.tab.value).toBe('lost')
    t.session.dispose()
  })

  test('turning Keep off removes the copy and lets the tab lock go', async () => {
    const s = await loggedIn()
    await s.session.setKeep(true)
    expect(await databases(s)).toEqual(['feathermark'])
    await s.session.setKeep(false)
    expect(s.session.keep.value).toBe(false)
    expect(await databases(s)).toEqual([])
    // a pass after that saves nothing
    s.model.newNote()
    s.session.pageHidden()
    s.timers.tick(0)
    await settle()
    expect(await databases(s)).toEqual([])
    expect(await new TabLock({ locks: s.locks }).acquire({ steal: false })).toBe('owner')
  })

  test('sign-out removes the kept copy', async () => {
    const s = await loggedIn()
    await s.session.setKeep(true)
    await s.session.lock('manual')
    expect(await databases(s)).toEqual(['feathermark'])
    expect(await s.session.signOut()).toBe('done')
    expect(await databases(s)).toEqual([])
    expect(s.session.keep.value).toBe(false)
    expect(await new TabLock({ locks: s.locks }).acquire({ steal: false })).toBe('owner')
  })

  test('Keep on: typing not yet in the kept copy warns on close, and hiding the tab keeps it at once', async () => {
    const s = await loggedIn()
    await s.session.setKeep(true)
    s.cloud.fail(() => true, 'network', 1000)
    expect(s.session.shouldWarnOnClose()).toBe(false)
    s.model.newNote()
    s.model.editTitle('Typed just before closing')
    s.model.editBody('every word of it')
    const id = s.model.openNote.value!.id
    // neither pushed nor kept: closing now would lose it
    expect(s.session.shouldWarnOnClose()).toBe(true)
    // hidden (a tab switch, or the first step of closing): kept at once, no timer needed
    s.session.pageHidden()
    await settle()
    expect((await keptVault(s))!.items.has(id)).toBe(true)
    expect(s.session.shouldWarnOnClose()).toBe(false)
    s.session.dispose()
    const t = s.newTab()
    await t.session.resume()
    await t.session.unlock(PASSWORD)
    t.model.selectNote(id)
    expect(t.model.openNote.value).toMatchObject({ title: 'Typed just before closing', body: 'every word of it' })
    t.session.dispose()
  })

  test('the tab that loses the library hands over its unpushed edits in the kept copy', async () => {
    const s = await loggedIn()
    await s.session.setKeep(true)
    // offline: nothing typed from here reaches the server, and no pass has saved it
    s.cloud.fail(() => true, 'network', 1000)
    s.model.newNote()
    s.model.editTitle('Typed offline in the first tab')
    const id = s.model.openNote.value!.id
    const t = s.newTab()
    await t.session.resume()
    await t.session.takeOver()
    await settle()
    expect(s.session.tab.value).toBe('lost')
    // handed over: in the kept copy, so closing the first tab loses nothing
    expect(s.session.shouldWarnOnClose()).toBe(false)
    await t.session.unlock(PASSWORD)
    t.model.selectNote(id)
    expect(t.model.openNote.value?.title).toBe('Typed offline in the first tab')
    // and back in the first tab, the second tab's offline edit comes along the same way
    t.model.editTitle('Typed offline in the first tab, then the second')
    await s.session.takeOver()
    await settle()
    s.model.selectNote(id)
    expect(s.model.openNote.value?.title).toBe('Typed offline in the first tab, then the second')
    t.session.dispose()
  })

  test("Keep is refused while another account's notes are kept on this browser", async () => {
    const s = await loggedIn()
    await s.session.setKeep(true)
    await s.session.lock('manual')
    s.session.dispose()
    // another account, in another tab of this browser
    const other = new AccountService({ base: s.cloud.base, fetch: s.cloud.fetch, crypto: keyringCrypto().client })
    await other.startSignup('bob@example.com', PASSWORD, '01JC8ZQ6V4N1XG2H3K5M7P9R0V')
    await other.verify('bob@example.com', s.cloud.codes.get('bob@example.com')!, 'Mac')
    const t = s.newTab()
    await t.session.logIn('bob@example.com', PASSWORD)
    const e = await t.session.setKeep(true).catch((x: unknown) => x)
    expect(t.session.message(e)).toBe(`The notes of ${EMAIL} are kept on this browser. Sign out of ${EMAIL} here first.`)
    expect(t.session.keep.value).toBe(false)
    expect((await keptVault(s))!.email).toBe(EMAIL)
    t.session.dispose()
  })

  test("a tab that lost the library can't sign out or turn Keep off; the owner's sign-out leaves no database", async () => {
    const s = await loggedIn()
    await s.session.setKeep(true)
    const t = s.newTab()
    await t.session.resume()
    await t.session.takeOver()
    await t.session.unlock(PASSWORD)
    await settle()
    expect(s.session.tab.value).toBe('lost')
    await expect(s.session.signOut({ force: true })).rejects.toThrow()
    await expect(s.session.setKeep(false)).rejects.toThrow()
    expect(s.session.state.value.kind).toBe('unlocked')
    expect(await databases(s)).toEqual(['feathermark'])
    // the owner signs out: the copy goes, and nothing in the other tab brings it back
    expect(await t.session.signOut({ force: true })).toBe('done')
    await settle()
    expect(await databases(s)).toEqual([])
    s.session.pageHidden()
    s.timers.tick(5 * MINUTE)
    await settle()
    await s.session.lock('idle').catch(() => undefined)
    await settle()
    expect(await databases(s)).toEqual([])
    s.session.dispose()
  })

  test('a late handover after the taker gave up writes nothing; that tab warns on close and pushes its edits', async () => {
    const s = await loggedIn()
    await s.session.setKeep(true)
    let offline = true
    s.cloud.fail(() => offline, 'network', 1000)
    s.model.newNote()
    s.model.editTitle('Late in the first tab')
    const id = s.model.openNote.value!.id
    const held = gate()
    s.store.gate = held.promise
    const t = s.newTab()
    await t.session.resume()
    const taking = t.session.takeOver()
    await settle()
    // the first tab is frozen in its save: the second gives up waiting and takes the copy as it was
    s.timers.tick(HANDOVER_MS)
    await settle()
    await taking
    expect(t.session.state.value).toEqual({ kind: 'locked', email: EMAIL, reason: 'kept' })
    // the first tab wakes: its save is refused, so the copy stays the second tab's
    held.open()
    s.store.gate = null
    await settle()
    expect((await keptVault(s))!.items.has(id)).toBe(false)
    // its edit is still only here: closing asks, and once online it reaches the server
    expect(s.session.shouldWarnOnClose()).toBe(true)
    offline = false
    s.timers.tick(5 * MINUTE)
    await settle()
    expect(s.cloud.items.has(id)).toBe(true)
    t.session.dispose()
    s.session.dispose()
  })

  test('a stale handedOver for another taker is ignored', async () => {
    const s = await loggedIn()
    await s.session.setKeep(true)
    s.cloud.fail(() => true, 'network', 1000)
    s.model.newNote()
    s.model.editTitle('Saved by the handover')
    const id = s.model.openNote.value!.id
    const held = gate()
    s.store.gate = held.promise
    const t = s.newTab()
    await t.session.resume()
    const taking = t.session.takeOver()
    await settle()
    // an answer meant for some other "Use it here"
    const bus = s.channels()
    bus.postMessage({ kind: 'handedOver', id: 'another-takeover' })
    await settle()
    expect(t.session.state.value).toMatchObject({ reason: 'otherTab' })
    held.open()
    s.store.gate = null
    await settle()
    await taking
    bus.close()
    expect(t.session.state.value).toMatchObject({ reason: 'kept' })
    await t.session.unlock(PASSWORD)
    t.model.selectNote(id)
    expect(t.model.openNote.value?.title).toBe('Saved by the handover')
    t.session.dispose()
    s.session.dispose()
  })

  test('two takeovers at once end with exactly one owner and no lost text', async () => {
    const s = await loggedIn()
    await s.session.setKeep(true)
    s.cloud.fail(() => true, 'network', 1000)
    s.model.newNote()
    s.model.editTitle('Typed in the first tab')
    const id = s.model.openNote.value!.id
    const b = s.newTab()
    const c = s.newTab()
    await b.session.resume()
    await c.session.resume()
    // the first tab is slow to save: both takers are waiting on it when it answers
    const held = gate()
    s.store.gate = held.promise
    const both = Promise.all([b.session.takeOver(), c.session.takeOver()].map((p) => p.catch((e: unknown) => e)))
    await settle()
    held.open()
    s.store.gate = null
    await settle()
    s.timers.tick(HANDOVER_MS)
    await settle()
    await both
    const states = [b, c].map((x) => (x.session.state.value as { reason?: string }).reason).sort()
    expect(states).toEqual(['kept', 'otherTab'])
    const [winner, loser] = (b.session.state.value as { reason?: string }).reason === 'kept' ? [b, c] : [c, b]
    await winner.session.unlock(PASSWORD)
    winner.model.selectNote(id)
    expect(winner.model.openNote.value?.title).toBe('Typed in the first tab')
    // only the winner writes the copy
    winner.model.newNote()
    winner.model.editTitle('Typed in the winner')
    winner.session.pageHidden()
    await settle()
    const kept = (await keptVault(s))!
    expect(kept.items.has(winner.model.openNote.value!.id)).toBe(true)
    await loser.session.unlock(PASSWORD)
    expect(loser.session.state.value).toMatchObject({ kind: 'locked', reason: 'otherTab' })
    for (const x of [s, b, c]) x.session.dispose()
  })

  test("a tab whose handover failed takes the copy back with the other tab's edits, and keeps its own", async () => {
    const s = await loggedIn()
    await s.session.setKeep(true)
    s.cloud.fail(() => true, 'network', 1000)
    s.model.newNote()
    s.model.editTitle('Typed in the first tab')
    s.store.failing = true
    const t = s.newTab()
    await t.session.resume()
    const taking = t.session.takeOver()
    await settle()
    s.timers.tick(HANDOVER_MS)
    await settle()
    await taking
    expect(s.session.shouldWarnOnClose()).toBe(true)
    s.store.failing = false
    await t.session.unlock(PASSWORD)
    t.model.newNote()
    t.model.editTitle('Typed in the second tab')
    t.session.pageHidden()
    await settle()
    // back in the first tab: the second hands over, and both texts are there
    await s.session.takeOver()
    await settle()
    expect(s.session.tab.value).toBe('here')
    expect(titles(s.model).sort()).toEqual(['Typed in the first tab', 'Typed in the second tab'])
    s.session.pageHidden()
    await settle()
    expect(s.session.shouldWarnOnClose()).toBe(false)
    t.session.dispose()
    s.session.dispose()
  })

  test('after sign-out, a late save does not bring the "feathermark" database back', async () => {
    const s = await loggedIn()
    await s.session.setKeep(true)
    s.model.newNote()
    s.model.editTitle('Synced already')
    s.session.pageHidden()
    s.timers.tick(0)
    await settle()
    const held = gate()
    s.store.gate = held.promise
    const t = s.newTab()
    await t.session.resume()
    const taking = t.session.takeOver()
    await settle()
    s.timers.tick(HANDOVER_MS)
    await settle()
    await taking
    await t.session.unlock(PASSWORD)
    expect(await t.session.signOut({ force: true })).toBe('done')
    expect(await databases(s)).toEqual([])
    // the first tab wakes and tries to save
    held.open()
    s.store.gate = null
    await settle()
    s.session.pageHidden()
    await settle()
    expect(await databases(s)).toEqual([])
    t.session.dispose()
    s.session.dispose()
  })

  test('a handover request while signing out leaves no database, and the taker finds nothing', async () => {
    const s = await loggedIn()
    await s.session.setKeep(true)
    s.model.newNote()
    s.model.editTitle('Synced already')
    s.session.pageHidden()
    s.timers.tick(0)
    await settle()
    const t = s.newTab()
    await t.session.resume()
    // the sign-out is under way (the worker forgetting the key) when the other tab asks for the copy
    const held = gate()
    const forget = s.crypto.client.forget
    s.crypto.client.forget = async (h: number) => (await held.promise, forget(h))
    const out = s.session.signOut({ force: true })
    const taking = t.session.takeOver()
    await settle()
    held.open()
    expect(await out).toBe('done')
    await settle()
    s.timers.tick(HANDOVER_MS)
    await settle()
    await taking
    expect(await databases(s)).toEqual([])
    expect(t.session.state.value).toEqual({ kind: 'demo' })
    t.session.dispose()
    s.session.dispose()
  })

  /** A tab that handed the copy over, and the tab that took it and added a note of its own, saved. */
  async function handedToSecondTab() {
    const s = await loggedIn()
    await s.session.setKeep(true)
    const t = s.newTab()
    await t.session.resume()
    await t.session.takeOver()
    await settle()
    await t.session.unlock(PASSWORD)
    t.model.newNote()
    t.model.editTitle('Written in the second tab')
    const id = t.model.openNote.value!.id
    t.session.pageHidden()
    await settle()
    expect((await keptVault(s))!.items.has(id)).toBe(true)
    return { s, t, id }
  }

  test("taking the copy back when it won't open leaves it as it is, and keeps this tab's notes", async () => {
    const { s, t, id } = await handedToSecondTab()
    const open = s.crypto.client.open
    s.crypto.client.open = () => Promise.reject(new Error('the worker died'))
    const e = await s.session.takeOver().catch((x: unknown) => x)
    s.crypto.client.open = open
    expect(e).toBeInstanceOf(Error)
    await settle()
    s.session.pageHidden()
    s.timers.tick(5 * MINUTE)
    await settle()
    // the second tab's note is still in the copy: nothing wrote over it
    expect((await keptVault(s))!.items.has(id)).toBe(true)
    expect(s.session.tab.value).toBe('lost')
    t.session.dispose()
    s.session.dispose()
  })

  test("taking the copy back when the claimed copy is another account's leaves it as it is", async () => {
    const { s, t, id } = await handedToSecondTab()
    s.store.onClaim = (v) => Object.assign(v, { email: 'bob@example.com' })
    const e = await s.session.takeOver().catch((x: unknown) => x)
    s.store.onClaim = null
    expect(s.session.message(e)).toBe(`The notes of bob@example.com are kept on this browser. Sign out of bob@example.com here first.`)
    await settle()
    s.session.pageHidden()
    s.timers.tick(5 * MINUTE)
    await settle()
    expect((await keptVault(s))!.items.has(id)).toBe(true)
    expect(s.session.tab.value).toBe('lost')
    t.session.dispose()
    s.session.dispose()
  })

  test('a title changed offline on a note whose body never loaded comes along when the copy is taken back', async () => {
    const s = await loggedIn()
    // another device writes a note; this tab gets its title but never its body
    const model2 = createAppModel(new Library(s.clock), { clock: s.clock, setTimer: s.timers })
    const other = createSession({
      model: model2, cloudOrigin: 'https://cloud.test', fetch: s.cloud.fetch, clock: s.clock, timers: s.timers, random: () => 0.5,
      deviceName: 'Mac', crypto: () => keyringCrypto().client, demoLibrary: () => new Library(s.clock),
    })
    await other.logIn(EMAIL, PASSWORD)
    await settle()
    model2.newNote()
    model2.editTitle('From the Mac')
    model2.editBody('its body')
    const id = model2.openNote.value!.id
    other.pageHidden()
    s.timers.tick(0)
    await settle()
    other.dispose()
    s.cloud.fail((c) => c.method === 'GET' && c.path.startsWith('/blobs/'), 'network', 1000)
    s.session.pageHidden()
    s.timers.tick(0)
    await settle()
    await s.session.setKeep(true)
    // offline from here; the title changes in this tab only, and its handover fails
    s.cloud.fail(() => true, 'network', 1000)
    s.model.selectNote(id)
    s.model.editTitle('Retitled offline')
    s.model.flush()
    s.store.failing = true
    const t = s.newTab()
    await t.session.resume()
    const taking = t.session.takeOver()
    await settle()
    s.timers.tick(HANDOVER_MS)
    await settle()
    await taking
    s.store.failing = false
    // taken back: the copy, with this tab's new title on it
    await s.session.takeOver()
    await settle()
    s.model.selectNote(id)
    expect(s.model.openNote.value?.title).toBe('Retitled offline')
    // the body is still the loader's to fetch: none was made up
    const item = (await keptVault(s))?.items.get(id)
    expect(s.session.vault()).toBeNull()
    expect(item?.blob ?? null).toBeNull()
    t.session.dispose()
    s.session.dispose()
  })

  test('a damaged kept copy opens nothing: the tab stays in the demo', async () => {
    const s = await loggedIn()
    await s.session.setKeep(true)
    await s.session.lock('manual')
    s.session.dispose()
    // the header written by something else
    const db = await new Promise<IDBDatabase>((ok) => (s.idb.open('feathermark').onsuccess = (e) => ok((e.target as IDBOpenDBRequest).result)))
    const tx = db.transaction('vault', 'readwrite')
    tx.objectStore('vault').put({ format: 1 }, 'vault')
    await new Promise((ok) => (tx.oncomplete = ok))
    db.close()
    const t = s.newTab()
    await t.session.resume()
    expect(t.session.state.value).toEqual({ kind: 'demo' })
    expect(await new TabLock({ locks: s.locks }).acquire({ steal: false })).toBe('owner')
  })

  test('after a pull, note bodies load in the background (BodyLoader started from onPulled)', async () => {
    const s = await loggedIn()
    // a second tab on the same account
    const model2 = createAppModel(new Library(s.clock), { clock: s.clock, setTimer: s.timers })
    const second = createSession({
      model: model2, cloudOrigin: 'https://cloud.test', fetch: s.cloud.fetch, clock: s.clock, timers: s.timers, random: () => 0.5,
      deviceName: 'Safari on iOS', crypto: () => keyringCrypto().client, demoLibrary: () => new Library(s.clock),
    })
    await second.logIn(EMAIL, PASSWORD)
    await settle()
    s.model.newNote()
    s.model.editTitle('From the first tab')
    s.model.editBody('its body')
    s.session.pageHidden()
    s.timers.tick(0)
    await settle()
    second.pageHidden()
    s.timers.tick(0)
    await settle()
    expect(model2.rows.value.map((r) => [r.note.title, r.note.preview])).toEqual([['From the first tab', 'its body']])
    second.dispose()
  })
})

describe('unsyncedCount', () => {
  const item = (o: Partial<SyncItem>): SyncItem => ({ id: 'X', type: 'note', serverVersion: 1, dirtySeq: 1, bodyDirty: false, deleted: false, blobSha: 'aa', extra: null, metaVersion: 1, bodyLoaded: true, ...o })
  test('counts what would be lost; not what has no text here or never reached the server', () => {
    expect(unsyncedCount([item({ dirtySeq: null })])).toBe(0)
    expect(unsyncedCount([item({})])).toBe(1)
    // a body that never loaded here, and that no server has: nothing here to lose, and it can never push
    expect(unsyncedCount([item({ bodyLoaded: false, blobSha: null, serverVersion: 0 })])).toBe(0)
    expect(unsyncedCount([item({ type: 'attachment', bodyLoaded: false, blobSha: null })])).toBe(0)
    // a body not loaded but with a blob on the server can still push its metadata change: counted
    expect(unsyncedCount([item({ bodyLoaded: false })])).toBe(1)
    // deleting something the server never saw loses nothing
    expect(unsyncedCount([item({ deleted: true, serverVersion: 0 })])).toBe(0)
    expect(unsyncedCount([item({ deleted: true })])).toBe(1)
  })
})

describe('Settings › Sync and the demo notes (Task 12)', () => {
  /** A tab in the demo where the visitor wrote two notes: one filed in a sample notebook, one with a sample tag. */
  async function demoWithTwoNotes() {
    const s = await setup()
    const sampleNotebook = s.model.notebooks.value.find((n) => n.origin === 'sample')!
    const sampleTag = s.model.tags.value.find((t) => t.origin === 'sample')!
    s.model.select({ kind: 'notebook', id: sampleNotebook.id })
    s.model.newNote()
    s.model.editTitle('Filed in a sample')
    s.model.select({ kind: 'tag', id: sampleTag.id })
    s.model.newNote()
    s.model.editTitle('Tagged with a sample')
    s.model.flush()
    return s
  }

  test('logging in offers the notes written in the demo; "Add notes" brings them, at the root and untagged', async () => {
    const s = await demoWithTwoNotes()
    await s.session.logIn(EMAIL, PASSWORD)
    await settle()
    expect(s.session.demoOffer.value).toEqual({ count: 2 })
    expect(titles(s.model)).toEqual([])
    s.session.addDemoNotes()
    expect(s.session.demoOffer.value).toBeNull()
    expect(titles(s.model).sort()).toEqual(['Filed in a sample', 'Tagged with a sample'])
    expect(s.model.notebooks.value).toEqual([])
    expect(s.model.tags.value).toEqual([])
    // and they sync
    s.session.pageHidden()
    s.timers.tick(0)
    await settle()
    expect(s.session.hasUnsynced()).toBe(false)
    expect(s.cloud.items.size).toBe(2)
  })

  test('the offer waits for the first sync; a tag the account already has is used, not made twice', async () => {
    const s = await setup()
    // the account already has a tag "work", from another device
    const model2 = createAppModel(new Library(s.clock), { clock: s.clock, setTimer: s.timers })
    const other = createSession({
      model: model2, cloudOrigin: 'https://cloud.test', fetch: s.cloud.fetch, clock: s.clock, timers: s.timers, random: () => 0.5,
      deviceName: 'Mac', crypto: () => keyringCrypto().client, demoLibrary: () => new Library(s.clock),
    })
    await other.logIn(EMAIL, PASSWORD)
    await settle()
    const work = model2.createTag('work')!
    other.pageHidden()
    s.timers.tick(0)
    await settle()
    other.dispose()
    // in the demo: a note tagged with the visitor's own tag "Work"
    const mine = s.model.createTag('Work')!
    s.model.select({ kind: 'tag', id: mine.id })
    s.model.newNote()
    s.model.editTitle('Tagged by me')
    s.model.flush()

    await s.session.logIn(EMAIL, PASSWORD)
    // not before the first sync has pulled the account
    expect(s.session.demoOffer.value).toBeNull()
    await settle()
    expect(s.session.demoOffer.value).toEqual({ count: 1 })
    s.session.addDemoNotes()
    expect(s.model.tags.value.map((t) => t.id)).toEqual([work.id])
    const note = s.model.rows.value.find((r) => r.note.title === 'Tagged by me')!.note
    s.model.selectNote(note.id)
    expect(s.model.openNote.value?.tagIds).toEqual([work.id])
  })

  test('the offer stays back while the first sync fails (offline), and comes once one succeeds', async () => {
    const s = await setup()
    s.model.newNote()
    s.model.editTitle('Written in the demo')
    s.model.flush()
    // the first pass's pull gets no answer
    s.cloud.fail((c) => c.path.startsWith('/sync/'), 'network', 1)
    await s.session.logIn(EMAIL, PASSWORD)
    await settle()
    expect(s.session.status.value.kind).toBe('offline')
    expect(s.session.demoOffer.value).toBeNull()
    // the retry (backoff from 2 s) gets through
    s.timers.tick(10_000)
    await settle()
    expect(s.session.demoOffer.value).toEqual({ count: 1 })
  })

  test('"Don\'t add" leaves them out; a demo without notes of its own offers nothing', async () => {
    const s = await demoWithTwoNotes()
    await s.session.logIn(EMAIL, PASSWORD)
    await settle()
    s.session.dismissDemoNotes()
    expect(s.session.demoOffer.value).toBeNull()
    expect(titles(s.model)).toEqual([])
    const plain = await setup()
    await plain.session.logIn(EMAIL, PASSWORD)
    expect(plain.session.demoOffer.value).toBeNull()
  })

  test('locking drops the offer (the demo notes are gone with the screen)', async () => {
    const s = await demoWithTwoNotes()
    await s.session.logIn(EMAIL, PASSWORD)
    await settle()
    await s.session.lock('manual')
    expect(s.session.demoOffer.value).toBeNull()
  })

  test('changing the password keeps this tab signed in and syncing, and unlocks with the new password', async () => {
    const s = await loggedIn()
    await expect(s.session.changePassword('wrong password!!', 'a brand new password')).rejects.toMatchObject({ kind: 'wrongPassword' })
    await s.session.changePassword(PASSWORD, 'a brand new password')
    expect(s.session.state.value).toEqual({ kind: 'unlocked', email: EMAIL })
    s.model.newNote()
    s.model.editTitle('after the change')
    s.session.pageHidden()
    s.timers.tick(0)
    await settle()
    expect(s.session.state.value.kind).toBe('unlocked')
    expect(s.session.hasUnsynced()).toBe(false)
    await s.session.lock('manual')
    await expect(s.session.unlock(PASSWORD)).rejects.toMatchObject({ kind: 'wrongPassword' })
    await s.session.unlock('a brand new password')
    expect(titles(s.model)).toEqual(['after the change'])
  })

  test('deleting the account asks for the password, then returns to the demo', async () => {
    const s = await loggedIn()
    await expect(s.session.deleteAccount('wrong password!!')).rejects.toMatchObject({ kind: 'wrongPassword' })
    expect(s.session.state.value.kind).toBe('unlocked')
    await s.session.deleteAccount(PASSWORD)
    expect(s.session.state.value).toEqual({ kind: 'demo' })
    expect(s.cloud.accounts.has(EMAIL)).toBe(false)
    expect(titles(s.model).length).toBeGreaterThan(0)
  })

  test('download everything waits for bodies that have not arrived', async () => {
    const s = await loggedIn()
    // another device writes a note; this tab gets its metadata, and its body only on request
    const model2 = createAppModel(new Library(s.clock), { clock: s.clock, setTimer: s.timers })
    const other = createSession({
      model: model2, cloudOrigin: 'https://cloud.test', fetch: s.cloud.fetch, clock: s.clock, timers: s.timers, random: () => 0.5,
      deviceName: 'Mac', crypto: () => keyringCrypto().client, demoLibrary: () => new Library(s.clock),
    })
    await other.logIn(EMAIL, PASSWORD)
    await settle()
    model2.newNote()
    model2.editTitle('From the Mac')
    model2.editBody('its body')
    other.pageHidden()
    s.timers.tick(0)
    await settle()
    other.dispose()
    s.cloud.fail((c) => c.method === 'GET' && c.path.startsWith('/blobs/'), 'network', 1)
    s.session.pageHidden()
    s.timers.tick(0)
    await settle()
    const entries = await s.session.exportLibrary()
    const md = entries.find((e) => e.path === 'FeatherMark Export/From the Mac.md')!
    expect(new TextDecoder().decode(md.bytes)).toMatch(/\n\nits body$/)
  })

  /** Another device writes a note with a picture; this tab gets its metadata. Returns the picture's bytes. */
  async function pictureFromAnotherDevice(s: Setup) {
    const model2 = createAppModel(new Library(s.clock), { clock: s.clock, setTimer: s.timers })
    const other = createSession({
      model: model2, cloudOrigin: 'https://cloud.test', fetch: s.cloud.fetch, clock: s.clock, timers: s.timers, random: () => 0.5,
      deviceName: 'Mac', crypto: () => keyringCrypto().client, demoLibrary: () => new Library(s.clock),
    })
    await other.logIn(EMAIL, PASSWORD)
    await settle()
    const bytes = new Uint8Array([9, 8, 7, 6])
    model2.newNote()
    model2.editTitle('With a picture')
    const file = { name: 'p.png', type: 'image/png', size: 4, arrayBuffer: async () => bytes.slice().buffer } as unknown as File
    const [snippet] = await model2.addFiles([file])
    model2.editBody(snippet!)
    other.pageHidden()
    s.timers.tick(0)
    await settle()
    other.dispose()
    s.session.pageHidden()
    s.timers.tick(0)
    await settle()
    return bytes
  }

  test('download everything carries attachments from another device', async () => {
    const s = await loggedIn()
    const bytes = await pictureFromAnotherDevice(s)
    const entries = await s.session.exportLibrary()
    expect(entries.find((e) => e.path === 'FeatherMark Export/_attachments/With a picture/p.png')?.bytes).toEqual(bytes)
  })

  test('download everything refuses rather than save an attachment it could not download as an empty file', async () => {
    const s = await loggedIn()
    await pictureFromAnotherDevice(s)
    // offline from here: the picture's content can't be fetched (the note's body still can, from the loader's retry)
    s.cloud.fail((c) => c.method === 'GET' && c.path.startsWith('/blobs/'), 'network', 1000)
    const note = s.model.rows.value[0]!.note
    s.model.selectNote(note.id)
    const e = await s.session.exportLibrary().catch((x: unknown) => x)
    expect(e).toBeInstanceOf(Error)
    expect(s.session.message(e)).toBe("Some notes or attachments haven't downloaded yet. Try again when you're online.")
  })

  test('a note a pull brings in during the export is never saved as an empty file', async () => {
    const s = await loggedIn()
    // blob downloads: all fail at first; later all but A's
    let mode: 'all' | 'notA' = 'all'
    let aPath = ''
    s.cloud.fail((c) => c.method === 'GET' && c.path.startsWith('/blobs/') && (mode === 'all' || c.path !== aPath), 'network', 10_000)
    const model2 = createAppModel(new Library(s.clock), { clock: s.clock, setTimer: s.timers })
    const other = createSession({
      model: model2, cloudOrigin: 'https://cloud.test', fetch: s.cloud.fetch, clock: s.clock, timers: s.timers, random: () => 0.5,
      deviceName: 'Mac', crypto: () => keyringCrypto().client, demoLibrary: () => new Library(s.clock),
    })
    await other.logIn(EMAIL, PASSWORD)
    await settle()
    const write = async (title: string, body: string) => {
      model2.newNote()
      model2.editTitle(title)
      model2.editBody(body)
      other.pageHidden()
      s.timers.tick(0)
      await settle()
    }
    await write('Note A', 'body A')
    // this tab gets A's metadata; its body can't be downloaded yet
    s.session.pageHidden()
    s.timers.tick(0)
    await settle()
    const lib = s.model.currentLibrary()
    const a = lib.notes({ kind: 'all' }).find((n) => n.title === 'Note A')!
    aPath = `/blobs/${lib.syncItem(a.id)!.blobSha}`
    // the export waits on A's download, held here; meanwhile the Mac writes B and this tab pulls it (B's body fails)
    mode = 'notA'
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    s.cloud.hook = async (c) => {
      if (c.method === 'GET' && c.path === aPath) await held
    }
    const exporting = s.session.exportLibrary().then(
      (entries) => ({ entries }),
      (e: unknown) => ({ error: e }),
    )
    await settle()
    await write('Note B', 'body B')
    s.session.syncNow()
    s.timers.tick(0)
    await settle()
    expect(lib.notes({ kind: 'all' }).some((n) => n.title === 'Note B')).toBe(true)
    release()
    const result = await exporting
    other.dispose()
    if ('error' in result) {
      expect(s.session.message(result.error)).toBe("Some notes or attachments haven't downloaded yet. Try again when you're online.")
    } else {
      const b = result.entries.find((e) => e.path === 'FeatherMark Export/Note B.md')
      expect(b === undefined || new TextDecoder().decode(b.bytes).endsWith('\n\nbody B')).toBe(true)
      for (const e of result.entries) if (e.path.endsWith('.md')) expect(new TextDecoder().decode(e.bytes)).not.toMatch(/---\n\n$/)
    }
  })

  test('the sync conflicts list and devices come from the account', async () => {
    const s = await loggedIn()
    expect(s.session.conflicts()).toEqual([])
    const devices = await s.session.account().devices()
    expect(devices.find((d) => d.current)?.name).toBe('Chrome on macOS')
  })
})

describe('final review: logging in while a kept copy is being resumed (I3)', () => {
  /** A tab with Keep on that closed with an edit the server never got (offline): the kept copy holds it, dirty. */
  async function keptWithUnsynced() {
    const s = await loggedIn()
    await s.session.setKeep(true)
    s.model.newNote()
    s.model.editTitle('Only in the kept copy')
    const id = s.model.openNote.value!.id
    let offline = true
    s.cloud.fail(() => offline, 'network', 1000)
    s.session.pageHidden()
    s.timers.tick(0)
    await settle()
    s.session.pageClosing(false)
    s.session.dispose()
    await settle()
    const before = (await keptVault(s))!
    expect(before.items.get(id)!.sync.dirtySeq).not.toBeNull()
    offline = false
    return { s, id, before }
  }
  const snapshot = (v: Vault) => [...v.items.values()].map((i) => [i.id, i.sync.dirtySeq, Buffer.from(i.meta ?? []).toString('hex')])
  /** A store whose claim (resume's step after peeking) waits for `open`. */
  class SlowClaim extends KeptStore {
    constructor(private readonly wait: Promise<void>, o: ConstructorParameters<typeof KeptStore>[0]) {
      super(o)
    }
    override async claim(...a: Parameters<KeptStore['claim']>): Promise<Vault | null> {
      await this.wait
      return super.claim(...a)
    }
  }

  test('a log-in submitted while resume loads the copy waits for it, is refused, and the copy stays as it was', async () => {
    const { s, before } = await keptWithUnsynced()
    const g = gate()
    const t = s.newTab({ kept: () => new SlowClaim(g.promise, { indexedDB: s.idb }) })
    const resumed = t.session.resume()
    await settle()
    const logins = s.cloud.calls.filter((c) => c.path.startsWith('/auth/login')).length
    const login = t.session.logIn(EMAIL, PASSWORD).then(() => 'logged in', (e: unknown) => e)
    await settle()
    g.open()
    await resumed
    expect(await login).toBeInstanceOf(Error)
    await settle()
    s.timers.tick(0)
    await settle()
    expect(t.session.state.value).toEqual({ kind: 'locked', email: EMAIL, reason: 'kept' })
    // no session was made on the server for the refused log-in
    expect(s.cloud.calls.filter((c) => c.path.startsWith('/auth/login')).length).toBe(logins)
    const after = (await keptVault(s))!
    expect(snapshot(after)).toEqual(snapshot(before))
    // and unlocking opens it, the unsynced edit included
    await t.session.unlock(PASSWORD)
    expect(titles(t.model)).toContain('Only in the kept copy')
    t.session.dispose()
  })

  test('a log-in under way when resume starts: resume waits, then leaves the kept copy alone', async () => {
    const { s, before } = await keptWithUnsynced()
    const t = s.newTab()
    const g = gate()
    s.cloud.hook = async (c) => {
      if (c.path.startsWith('/auth/login')) await g.promise
    }
    const login = t.session.logIn(EMAIL, PASSWORD)
    await settle()
    const resumed = t.session.resume()
    await settle()
    g.open()
    await login
    await resumed
    s.cloud.hook = null
    await settle()
    s.timers.tick(0)
    await settle()
    expect(t.session.state.value).toEqual({ kind: 'unlocked', email: EMAIL })
    // the copy isn't this tab's: never written over, and Keep stays off here (turning it on is refused as usual)
    expect(t.session.keep.value).toBe(false)
    expect(snapshot((await keptVault(s))!)).toEqual(snapshot(before))
    t.session.dispose()
  })
})
