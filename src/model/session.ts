// The app's account state (web design "Logged in"): demo, unlocked, locked. It ties the crypto worker, the library,
// the vault and the sync engine together; the screens only read its signals and call its actions.
//
// - Logging in starts a new, empty library for the account (the demo's samples never go into it) and syncs it.
// - Locking (Lock now, 30 minutes idle, or the server's 401) seals every item into the vault, unsynced edits
//   included, puts an empty library in the app (which drops the open note, unsaved typing, search and every
//   attachment object URL), drops the master key in the worker, and only then shows the unlock screen.
// - Unlocking opens the vault from memory: no request before the notes show, and it works offline. After a 401 it
//   signs in again first (the old token is dead), then carries on and pushes what was unsynced.
// - Signing out returns to the demo and drops the session, its keys and the vault, and the kept copy.
// - "Keep my notes on this browser" (Task 10) keeps the vault in IndexedDB ("feathermark", kept-store.ts): saved after
//   every sync pass and every lock, by the one tab that owns it (the Web Lock "feathermark-vault", tab-lock.ts). A
//   reload opens the unlock screen from it, offline too. A second tab says "FeatherMark is open in another tab." until
//   "Use it here" takes the lock; the tab that lost it stops syncing and saving and its notes turn read-only.
//
// This module and everything it imports load only through import(), when someone logs in: the demo's first load
// carries no crypto or sync code (scripts/bundle-size.ts --check).
import { computed, effect, signal, type ReadonlySignal } from '@preact/signals'
import { systemClock, type Clock } from '../core/clock.ts'
import { CryptoError } from '../core/crypto/errors.ts'
import { Library } from '../core/library/library.ts'
import { carryDemoNotes, demoNotesToOffer } from '../core/library/demo-notes.ts'
import { libraryZip } from '../core/library/export.ts'
import type { SyncConflict, SyncItem } from '../core/library/sync-state.ts'
import { AccountError, accountMessage, AccountService, tooWeak, type AccountErrorKind, type SignedIn } from '../core/sync/account.ts'
import { ApiClient, type CloudAccount, type ServerInfo } from '../core/sync/api.ts'
import { BodyLoader } from '../core/sync/bodies.ts'
import { deviceName as browserDeviceName } from '../core/sync/device-name.ts'
import { conflictTitle } from '../core/sync/conflict.ts'
import { SyncEngine, type SyncStatus } from '../core/sync/engine.ts'
import { KeptStore, KeptVaultDamaged, NotKeptOwner } from '../core/vault/kept-store.ts'
import { mergeUnsynced } from '../core/vault/merge.ts'
import { TabLock } from '../core/vault/tab-lock.ts'
import { Vault, type VaultCredentials } from '../core/vault/vault.ts'
import { createCryptoClient, type CryptoClient } from '../worker/crypto-client.ts'
import type { AppModel, TimerFns } from './app-model.ts'

/** `kept`: the tab opened on a kept copy. `otherTab`: another tab owns the kept copy; "Use it here" takes it. */
export type LockReason = 'idle' | 'manual' | 'signedOut' | 'otherTab' | 'kept'
export type SessionState =
  | { kind: 'demo' }
  | { kind: 'unlocked'; email: string }
  | { kind: 'locked'; email: string; reason: LockReason }
  /** This browser can't run Argon2id at 256 MiB: the screen says so; the demo still works. */
  | { kind: 'unsupported' }

export type SessionModel = {
  state: ReadonlySignal<SessionState>
  status: ReadonlySignal<SyncStatus>
  keep: ReadonlySignal<boolean>
  /** 'lost': another tab took the kept library while this one was unlocked; its notes are read-only here. */
  tab: ReadonlySignal<'here' | 'lost'>
  /** The account as the server last described it (plan, storage, billing); null until known. */
  cloudAccount: ReadonlySignal<CloudAccount | null>
  /** After logging in from a demo where notes were written: "Add the <count> notes you wrote here to your account?" */
  demoOffer: ReadonlySignal<{ count: number } | null>
  /** "Add notes": the demo notes (never a sample item) go into the account as new notes. */
  addDemoNotes(): void
  /** "Don't add". */
  dismissDemoNotes(): void
  /** Asks the server for the account again (Settings › Sync opening). */
  refreshAccount(): Promise<void>
  /** "Try again": syncs now. */
  syncNow(): void
  /** Notebook and tag renames that lost to another device's, newest first. */
  conflicts(): SyncConflict[]
  /** "Change password…": this tab stays signed in (the server gives it a new token); the vault unlocks with the new one. */
  changePassword(current: string, next: string): Promise<void>
  /** "Delete account…": deletes it on the server, then returns to the demo. */
  deleteAccount(password: string): Promise<void>
  /** "Download all notes (.zip)": the library as a Markdown folder (zip entries), every body downloaded first. */
  exportLibrary(): Promise<Array<{ path: string; bytes: Uint8Array }>>
  /** The message a screen shows for a failed action, or for an AccountError kind (ui-copy.md, word for word). */
  message(e: unknown): string
  /** The account service, for the log-in, create-account, recovery and settings screens. */
  account(): AccountService
  /** This browser's device name ("Chrome on macOS"), sent when signing in. */
  deviceName(): string
  /** What the server says about itself (whether it bills, for the create-account intro). */
  serverInfo(): Promise<ServerInfo>
  /** Refused while another logIn or begin is pending, or once signed in. */
  logIn(email: string, password: string): Promise<void>
  /** Starts the session for an account a screen signed in (create account, recovery). Refused while a logIn or begin
   *  is pending. */
  begin(s: SignedIn): Promise<void>
  unlock(password: string): Promise<void>
  lock(reason: LockReason): Promise<void>
  signOut(o?: { force: boolean }): Promise<'done' | 'unsynced'>
  /** "Keep my notes on this browser": on takes the tab lock (from another tab too) and saves the vault; off removes
   *  the kept copy and lets the lock go. */
  setKeep(on: boolean): Promise<void>
  /** On opening the app with a kept copy: the unlock screen, or "FeatherMark is open in another tab." */
  resume(): Promise<void>
  /** "Use it here": takes the kept library from the tab that has it. */
  takeOver(): Promise<void>
  /** A key press, click or touch in the tab: the idle lock starts again. */
  noteActivity(): void
  /** The tab was hidden: push at once (a phone may kill a background tab). */
  pageHidden(): void
  /** The tab is going away (pagehide). With Keep off and not kept for back/forward, the session ends on the server. */
  pageClosing(persisted: boolean): void
  /** What the locked tab keeps (null while unlocked or in the demo); with Keep on it is also in IndexedDB. */
  vault(): Vault | null
  /** Changes here that haven't reached the server and would be lost. */
  hasUnsynced(): boolean
  /** Whether closing the tab should ask first (Keep off, and something unsynced). */
  shouldWarnOnClose(): boolean
  dispose(): void
}

export type SessionDeps = {
  model: AppModel
  /** The Feather Cloud origin built in (VITE_FEATHER_CLOUD_URL); the API is at `<origin>/v1`. */
  cloudOrigin: string
  /** The demo's library again, for signing out. */
  demoLibrary: () => Library
  crypto?: () => CryptoClient
  fetch?: typeof fetch
  clock?: Clock
  timers?: TimerFns
  random?: () => number
  deviceName?: string
  idleMs?: number
  /** Where "Keep my notes on this browser" keeps the vault; IndexedDB "feathermark" when not given. */
  kept?: () => KeptStore
  /** Which tab owns the kept library; the Web Lock "feathermark-vault" when not given. */
  tabLock?: () => TabLock
  /** Where tabs hand the kept library over; the BroadcastChannel "feathermark-vault" when not given. */
  channel?: () => HandoverChannel | null
  /** This tab's id for the kept copy's owner; random when not given. */
  tabId?: string
}

const newTabId = (): string =>
  typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

/** The part of a BroadcastChannel the handover uses. */
export type HandoverChannel = Pick<BroadcastChannel, 'postMessage' | 'addEventListener' | 'removeEventListener' | 'close'>

/** "Keep my notes on this browser" can't be turned on here (copy for approval: ui-copy.md has none yet). */
export class KeepRefused extends Error {
  constructor(
    readonly kind: 'otherAccount' | 'otherTab' | 'unsyncedKept',
    readonly email: string | null = null,
  ) {
    super(`keep refused: ${kind}`)
    this.name = 'KeepRefused'
  }
}

/** "Download all notes (.zip)" while some note bodies or attachments couldn't be downloaded (offline). */
export class ExportIncomplete extends Error {
  constructor() {
    // copy for approval (ui-copy.md has none)
    super("Some notes or attachments haven't downloaded yet. Try again when you're online.")
    this.name = 'ExportIncomplete'
  }
}

/** Signing out or turning Keep off from a tab that doesn't own the kept library: the owner does it. */
export class NotOwner extends Error {
  constructor() {
    super('another tab owns the kept library')
    this.name = 'NotOwner'
  }
}

function keepMessage(e: KeepRefused): string {
  switch (e.kind) {
    case 'otherAccount':
      return `The notes of ${e.email} are kept on this browser. Sign out of ${e.email} here first.`
    case 'otherTab':
      return 'Your notes are already kept on this browser, by another tab.'
    case 'unsyncedKept':
      return "This browser keeps changes that haven't synced yet. Reload FeatherMark to open them first."
  }
}

/** How long "Use it here" waits for the tab that had the kept library to hand it over. */
const HANDOVER_MS = 10_000

const IDLE_MS = 30 * 60_000
const defaultTimers: TimerFns = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }

/** How many changes would be lost on sign-out. Not counted: an item whose body or content never loaded here and that
 *  no server has (it has no text here and can never push; after signing in to another account), and a deletion the
 *  server never saw. Neither is dropped from the library; they just aren't changes anyone would lose. */
export function unsyncedCount(items: Iterable<Omit<SyncItem, 'extra'>>): number {
  let n = 0
  for (const s of items) {
    if (s.dirtySeq === null) continue
    if ((s.type === 'note' || s.type === 'attachment') && !s.bodyLoaded && s.blobSha === null) continue
    if (s.deleted && s.serverVersion === 0) continue
    n++
  }
  return n
}

type Live = {
  library: Library
  session: number
  engine: SyncEngine
  loader: BodyLoader
  client: ApiClient
  /** Stops syncing and loading for a moment (a password change), without letting the library go. */
  pause: () => Promise<void>
  /** Starts again after pause(). */
  restart: () => void
  /** Settles once a sync pass in flight has ended. */
  stop: () => Promise<void>
  /** Syncs again after stop(), without the body loader or local-change triggers: a tab whose handover failed keeps
   *  pushing what only it holds. */
  resume: () => void
}

export function createSession(deps: SessionDeps): SessionModel {
  const { model } = deps
  const clock = deps.clock ?? systemClock
  const timers = deps.timers ?? defaultTimers
  const random = deps.random ?? Math.random
  const idleMs = deps.idleMs ?? IDLE_MS
  const base = `${deps.cloudOrigin.replace(/\/+$/, '')}/v1`
  const device = () => deps.deviceName ?? browserDeviceName(navigator as Parameters<typeof browserDeviceName>[0])

  const state = signal<SessionState>({ kind: 'demo' })
  const keep = signal(false)
  const tab = signal<'here' | 'lost'>('here')
  const cloudAccount = signal<CloudAccount | null>(null)
  const demoOffer = signal<{ count: number } | null>(null)
  /** The demo's library and the notes in it to offer, while the offer stands. */
  let demoCarry: { demo: Library; ids: string[] } | null = null
  /** The offer, kept back until the first sync of the new sign-in has pulled the account (its tags, so a demo tag
   *  joins the account's tag of the same name). */
  let offerAfterSync: { library: Library; carry: { demo: Library; ids: string[] } } | null = null
  const dropDemoOffer = () => {
    demoCarry = null
    offerAfterSync = null
    demoOffer.value = null
  }
  const engine = signal<SyncEngine | null>(null)
  const status = computed<SyncStatus>(() => engine.value?.status.value ?? { kind: 'idle', lastSynced: null })

  let crypto: CryptoClient | null = null
  let account: AccountService | null = null
  let creds: VaultCredentials | null = null
  let vault: Vault | null = null
  let live: Live | null = null
  /** The library being sealed by lock(): its changes still count as unsynced until the vault holds them. */
  let sealing: Library | null = null
  /** One lock, unlock or sign-out at a time. */
  let busy: Promise<unknown> = Promise.resolve()
  /** A logIn or begin is running: a second one (a double click) is refused. */
  let signingIn = false
  /** The sign-in under way, once it passed the resume of a kept copy: resume() waits for it. */
  let signInRun: Promise<unknown> = Promise.resolve()
  let lastActivity = clock()
  let idleTimer: unknown = null
  /** Made on first use: a session that never kept anything never touches IndexedDB or the lock. */
  let keptStore: KeptStore | null = null
  let lockHolder: TabLock | null = null
  /** One store operation at a time, in order: a save that started before "Keep" went off ends before the removal. */
  let storeChain: Promise<unknown> = Promise.resolve()
  /** The last vault sealed or opened for this library: unchanged items keep its envelopes (Vault.create). */
  let lastSealed: Vault | null = null
  /** The running library's localChangeSeq when the kept copy last caught up with it. */
  let keptSeq = 0
  /** This tab lost the kept library and saved everything it held into it before letting go. */
  let handedOver = false
  /** This tab's id: the kept copy names its owner by it, and every write checks it (KeptStore). */
  const tabId = deps.tabId ?? newTabId()
  /** This tab owns the kept copy (it created or claimed it, and hasn't handed it over). Every write still checks. */
  let ownerHere = false
  /** Handovers whose taker stopped waiting: a save for them would be too late. */
  const gaveUp = new Set<string>()
  /** The last vault (this tab's own) was kept: a locked tab closing loses nothing. */
  let vaultKept = false
  /** This tab's own sealed edits, waiting for the unlock that merges them into the kept copy it took back. */
  let pendingMerge: Vault | null = null
  let channel: HandoverChannel | null = null
  let channelMade = false

  const cryptoClient = (): CryptoClient => (crypto ??= (deps.crypto ?? (() => createCryptoClient()))())
  const accountService = (): AccountService =>
    (account ??= new AccountService({ base, crypto: cryptoClient(), ...(deps.fetch ? { fetch: deps.fetch } : {}) }))
  const kept = (): KeptStore => (keptStore ??= deps.kept?.() ?? new KeptStore())
  const tabLock = (): TabLock => {
    if (lockHolder) return lockHolder
    lockHolder = deps.tabLock?.() ?? new TabLock()
    lockHolder.onLost(lockLost)
    bus()
    return lockHolder
  }
  const bus = (): HandoverChannel | null => {
    if (channelMade) return channel
    channelMade = true
    try {
      channel = deps.channel ? deps.channel() : typeof BroadcastChannel === 'function' ? new BroadcastChannel('feathermark-vault') : null
    } catch {
      channel = null
    }
    channel?.addEventListener('message', onBus)
    return channel
  }
  const stored = <T>(body: () => Promise<T>): Promise<T> => {
    const run = storeChain.then(body)
    storeChain = run.catch(() => undefined)
    return run
  }
  const api = (token: string) => new ApiClient({ base, token, ...(deps.fetch ? { fetch: deps.fetch } : {}) })

  const serial = <T>(body: () => Promise<T>): Promise<T> => {
    const run = busy.then(body)
    busy = run.catch(() => undefined)
    return run
  }

  // ---- idle lock

  /** Checks for idleness `ms` from now; locks once nothing happened in the tab for `idleMs`. */
  const armIdle = (ms = idleMs) => {
    disarmIdle()
    idleTimer = timers.set(() => {
      idleTimer = null
      if (state.value.kind !== 'unlocked') return
      const idle = clock() - lastActivity
      // a failed lock shows its message (lock does) and leaves the notes as they were
      if (idle >= idleMs) void lock('idle').catch(() => undefined)
      else armIdle(idleMs - idle)
    }, ms)
  }
  const disarmIdle = () => {
    if (idleTimer !== null) timers.clear(idleTimer)
    idleTimer = null
  }

  // ---- running: a library with its engine and body loader

  /** The opened note's body loads ahead of the rest. */
  let openedId: string | null = null
  const opened = effect(() => {
    const id = model.openNote.value?.id ?? null
    if (id === openedId) return
    openedId = id
    if (id !== null && live) void live.loader.openNote(id)
  })

  function run(library: Library, session: number): void {
    const c = creds!
    const client = api(c.token)
    let bodiesMarked = false
    const e = new SyncEngine({ library, api: client, crypto: cryptoClient(), session, libraryId: c.libraryId, deviceName: device(), clock, timers, random })
    const loader = new BodyLoader({
      library, api: client, crypto: cryptoClient(), session, timers, random,
      onProgress: (d, t) => {
        e.loading(d, t)
        // for the speed test (tests/cloud/keep-speed.spec.ts): every body is in, once per run; it records no text
        if (t > 0 && d >= t && !bodiesMarked) {
          bodiesMarked = true
          performance.mark('feather:bodies-loaded')
        }
      },
    })
    // a local change syncs 2 s later; a remote write (which changes no seq) doesn't
    let seq = library.localChangeSeq
    const unsubscribe = library.subscribe(() => {
      if (library.localChangeSeq === seq) return
      seq = library.localChangeSeq
      e.localChanged()
    })
    const hooks = {
      beforeSync: () => model.flush(),
      // BodyLoader rescans only when started: after every pull
      onPulled: () => loader.start(),
      onSignedOut: () => void lock('signedOut').catch(() => undefined),
      afterPass: (ok: boolean) => {
        // the demo notes are offered once the first sync of this sign-in has pulled the account
        if (ok && offerAfterSync && offerAfterSync.library === library && live?.library === library) {
          demoCarry = offerAfterSync.carry
          offerAfterSync = null
          demoOffer.value = { count: demoCarry.ids.length }
        }
        // "Keep my notes on this browser": every pass, synced or not, leaves the kept copy current
        void saveKept().catch(() => undefined)
        // a tab whose handover failed syncs only until what it alone held has reached the server
        if (tab.value === 'lost' && live?.library === library && unsyncedCount(library.syncItems()) === 0) void e.stop()
      },
    }
    live = {
      library,
      session,
      engine: e,
      loader,
      client,
      pause: () => {
        loader.stop()
        return e.stop()
      },
      restart: () => {
        e.start(hooks)
        loader.start()
      },
      stop: () => {
        unsubscribe()
        loader.stop()
        return e.stop()
      },
      resume: () => e.start({ ...hooks, onPulled: () => undefined }),
    }
    engine.value = e
    // attachments from another device download the first time they are shown
    model.setLibrary(library, { loadAttachment: (id) => loader.loadAttachment(id), conflictTitle: (t) => conflictTitle(t, device(), new Date(clock())) })
    // a library opened from the vault is what the vault holds; a new one has nothing to keep yet
    keptSeq = library.localChangeSeq
    openedId = null
    lastActivity = clock()
    armIdle()
    e.start(hooks)
    loader.start()
    const id = model.openNote.value?.id
    if (id) void loader.openNote(id)
  }

  /** Stops syncing; `stopped` settles once a pass in flight has ended. */
  function halt(): { live: Live | null; stopped: Promise<void> } {
    dropDemoOffer()
    const l = live
    live = null
    engine.value = null
    disarmIdle()
    return { live: l, stopped: l ? l.stop() : Promise.resolve() }
  }

  // ---- the kept copy and the tab that owns it
  //
  // The kept copy names its owner (a tab id), and every write checks it in its own transaction (KeptStore): only the
  // owner writes, however late another tab wakes, and nothing brings a removed copy back.
  //
  // "Use it here" moves ownership by handover, with an id. The taker posts { handover, id } on the BroadcastChannel
  // "feathermark-vault" and steals the Web Lock (which only says a tab is alive and holding it). The owner turns
  // read-only, saves everything it holds as the owner, and answers { handedOver, id }. The taker accepts only its own
  // id; after HANDOVER_MS it posts { gaveUp, id } and goes on. Either way it then claims the copy from the owner it
  // saw (compare-and-set, with the read, in one transaction), so of two takers exactly one wins; the other shows
  // "FeatherMark is open in another tab." A tab whose handover didn't land keeps its edits: they count as unsynced
  // (closing asks), it keeps pushing them to the server, and taking the copy back merges them in as local changes.

  const credsOf = (v: Vault): VaultCredentials => ({
    email: v.email, serverOrigin: v.serverOrigin, token: v.token, deviceId: v.deviceId, libraryId: v.libraryId,
    wrappedMasterPassword: v.wrappedMasterPassword, salt: v.salt, kdf: v.kdf,
  })
  /** Whether a kept copy is this account's (same server, email and library). */
  const ours = (v: Vault, c: VaultCredentials | null) =>
    c !== null && v.serverOrigin === deps.cloudOrigin && v.email === c.email && v.libraryId === c.libraryId

  /** This tab no longer owns the copy: a write was refused, or it handed it over. */
  function notOwnerAnyMore(): void {
    ownerHere = false
    if (state.value.kind === 'unlocked' && live) {
      model.setReadOnly(true)
      tab.value = 'lost'
    } else if (state.value.kind === 'locked' && state.value.reason !== 'signedOut') {
      state.value = { kind: 'locked', email: state.value.email, reason: 'otherTab' }
    }
  }

  /** With Keep on, in the tab that owns the kept copy: seals the running library and keeps it. */
  function saveKept(): Promise<void> {
    const l = live
    if (!l || !keep.value || !ownerHere) return Promise.resolve()
    return stored(async () => {
      if (live !== l || !keep.value || !ownerHere || !creds) return
      const seq = l.library.localChangeSeq
      // for the speed test (tests/cloud/keep-speed.spec.ts): how long a save takes; it records no note text
      const t0 = performance.now()
      const v = await Vault.create(l.library, cryptoClient(), l.session, creds, lastSealed)
      if (!keep.value || !ownerHere) return
      const t1 = performance.now()
      try {
        await kept().save(v, { as: tabId })
      } catch (e) {
        // another tab owns the copy now: this tab's changes stay here, unsynced, and closing asks
        if (e instanceof NotKeptOwner) notOwnerAnyMore()
        throw e
      }
      lastSealed = v
      if (live === l) keptSeq = Math.max(keptSeq, seq)
      performance.measure('feather:kept-seal', { start: t0, end: t1 })
      performance.measure('feather:kept-save', { start: t0 })
    })
  }

  /** What is kept on this browser, any account's, and its owner; null when nothing (or nothing readable) is. */
  async function peekKept(): Promise<Vault | null> {
    try {
      return await kept().load()
    } catch (e) {
      if (e instanceof KeptVaultDamaged) return null
      throw e
    }
  }

  const post = (m: { kind: 'handover' | 'handedOver' | 'gaveUp'; id: string }) => {
    try {
      channel?.postMessage(m)
    } catch {
      // no channel: the taker waits HANDOVER_MS
    }
  }

  /** Messages from other tabs of this browser. */
  function onBus(e: Event): void {
    const m = (e as MessageEvent).data as { kind?: unknown; id?: unknown } | null
    if (!m || typeof m.id !== 'string') return
    if (m.kind === 'gaveUp') gaveUp.add(m.id)
    else if (m.kind === 'handover') handOver(m.id)
  }

  /** The Web Lock went to another tab: stop editing at once (the handover message says what to save). */
  function lockLost(): void {
    if (!ownerHere) return
    if (state.value.kind === 'unlocked' && live) {
      model.setReadOnly(true)
      tab.value = 'lost'
    }
  }

  /** Another tab asked for the copy ("Use it here" there, request `id`): if it is this tab's, save everything this tab
   *  holds as its owner, then answer that request. Too late (it gave up), or refused: the edits stay here. */
  function handOver(id: string): void {
    if (!ownerHere) return
    // in turn with lock, unlock and sign-out: a sign-out under way removes the copy first, and then there is nothing
    // to hand over (the taker finds no copy)
    void serial(async () => {
      if (!ownerHere) return
      ownerHere = false
      handedOver = false
      // an unlock that ran before this (serial) made the tab editable: not any more
      const now = state.value
      if (now.kind === 'unlocked' && live) {
        model.setReadOnly(true)
        tab.value = 'lost'
      }
      let saved = false
      let l: Live | null = null
      try {
        if (now.kind === 'unlocked' && live) {
          l = live
          // no more syncing here while the copy changes hands
          await l.stop()
          if (keep.value && creds && !gaveUp.has(id)) {
            const v = await Vault.create(l.library, cryptoClient(), l.session, creds, lastSealed)
            if (!gaveUp.has(id)) {
              await stored(() => kept().save(v, { as: tabId }))
              lastSealed = v
              saved = true
            }
          }
        } else if (now.kind === 'locked' && vault && !gaveUp.has(id)) {
          await stored(() => kept().save(vault!, { as: tabId }))
          saved = true
        } else if (now.kind === 'locked' && !vault) {
          // nothing held beyond the copy itself (the unlock screen of a reopened tab)
          saved = !gaveUp.has(id)
        }
      } catch {
        saved = false
      }
      // a save that landed after the taker gave up still counts as not handed over: the edits stay unsynced here
      handedOver = saved && !gaveUp.has(id)
      vaultKept = handedOver
      if (handedOver) post({ kind: 'handedOver', id })
      else if (l && l === live) l.resume()
      if (state.value.kind === 'locked' && state.value.reason !== 'signedOut') {
        state.value = { kind: 'locked', email: state.value.email, reason: 'otherTab' }
      }
    })
  }

  /** Asks the owner for the copy (if a live tab holds it), waiting until it answers this request or HANDOVER_MS. */
  async function askForCopy(): Promise<void> {
    if ((await tabLock().acquire({ steal: false })) === 'owner') return
    const id = newTabId()
    const c = bus()
    const answered = new Promise<boolean>((resolve) => {
      let timer: unknown = null
      const finish = (ok: boolean) => {
        if (timer !== null) timers.clear(timer)
        c?.removeEventListener('message', onMessage)
        resolve(ok)
      }
      const onMessage = (e: Event) => {
        const m = (e as MessageEvent).data as { kind?: unknown; id?: unknown } | null
        if (m?.kind === 'handedOver' && m.id === id) finish(true)
      }
      c?.addEventListener('message', onMessage)
      timer = timers.set(() => finish(false), HANDOVER_MS)
    })
    post({ kind: 'handover', id })
    await tabLock().acquire({ steal: true })
    if (!(await answered)) post({ kind: 'gaveUp', id })
  }

  /** Becomes the owner of the copy if its owner is still `from`. 'lost': another tab claimed it first. */
  async function claimCopy(from: string | null): Promise<Vault | null | 'lost' | 'damaged'> {
    try {
      const v = await stored(() => kept().claim(tabId, from))
      if (v) {
        ownerHere = true
        // a tab that won the copy while another held the Web Lock takes the lock too (it says who is alive)
        await tabLock().acquire({ steal: true })
      }
      return v
    } catch (e) {
      if (e instanceof NotKeptOwner) return 'lost'
      if (e instanceof KeptVaultDamaged) return 'damaged'
      throw e
    }
  }

  /** Back to the demo, dropping everything this tab holds for the account (not the server's session). */
  function toDemo(): void {
    halt()
    crypto?.terminate()
    crypto = null
    account = null
    creds = null
    vault = null
    lastSealed = null
    pendingMerge = null
    keep.value = false
    tab.value = 'here'
    cloudAccount.value = null
    model.setReadOnly(false)
    model.setLibrary(deps.demoLibrary())
    state.value = { kind: 'demo' }
  }

  /** The crypto worker loads now, while the page's own files are reachable: unlocking then needs no network (an
   *  answer means its script and everything it imports are in). */
  const warmCrypto = () => cryptoClient().forget(0).catch(() => undefined)

  function resume(): Promise<void> {
    return serial(async () => {
      // a log-in under way goes first; if it signs in, the kept copy is left alone (never opened or written over by
      // that sign-in: Keep stays off and turning it on is refused by the usual rules)
      await signInRun
      if (state.value.kind !== 'demo') return
      const got = await tabLock().acquire({ steal: false })
      const peek = await peekKept().catch(() => null)
      if (!peek || peek.serverOrigin !== deps.cloudOrigin) {
        if (got === 'owner') tabLock().release()
        return
      }
      creds = credsOf(peek)
      keep.value = true
      if (got === 'busy') {
        vault = null
        state.value = { kind: 'locked', email: peek.email, reason: 'otherTab' }
        return
      }
      // no live tab holds it: the copy is this tab's from now on (the tab that kept it is gone)
      const v = await claimCopy(kept().owner)
      if (!(v instanceof Vault)) {
        vault = null
        tabLock().release()
        if (v === 'lost') state.value = { kind: 'locked', email: peek.email, reason: 'otherTab' }
        else toDemo()
        return
      }
      vault = v
      lastSealed = v
      vaultKept = true
      await warmCrypto()
      state.value = { kind: 'locked', email: v.email, reason: 'kept' }
    })
  }

  function takeOver(): Promise<void> {
    return serial(async () => {
      const st = state.value
      const lostHere = st.kind === 'unlocked' && tab.value === 'lost' && live !== null
      if (!lostHere && !(st.kind === 'locked' && st.reason === 'otherTab')) return
      // another account's copy is never opened over this tab's notes, nor replaced by them
      const peek = await peekKept()
      if (peek && creds && !ours(peek, creds)) throw new KeepRefused('otherAccount', peek.email)
      const from = peek ? kept().owner : null
      await askForCopy()
      const v = peek ? await claimCopy(from) : null
      if (v === 'lost') {
        // another tab claimed it first: this one shows so, and keeps what it holds
        tabLock().release()
        if (st.kind === 'locked') state.value = { kind: 'locked', email: st.email, reason: 'otherTab' }
        return
      }
      const copy = v instanceof Vault && ours(v, creds) ? v : null
      // a tab whose own handover landed has nothing of its own to merge: its dirty notes are in the copy already
      const ownHandedOver = handedOver
      handedOver = false
      if (lostHere) {
        const l = live!
        await l.stop()
        let library: Library | null = null
        let failure: unknown = null
        if (copy) {
          // the copy (with every edit handed over to it), opened with this tab's key: no password
          library = await copy.open(cryptoClient(), l.session, clock).catch((e: unknown) => ((failure = e), null))
        } else if (v instanceof Vault) {
          failure = new KeepRefused('otherAccount', v.email)
        }
        if (v instanceof Vault && !library) {
          // claimed, but it won't open, or it is another account's: never written over. This tab lets it go untouched
          // and stays as it was: read-only, its own edits unsynced (closing asks) and pushed when it can
          ownerHere = false
          tabLock().release()
          handedOver = ownHandedOver
          // its edits: in the copy already (handed over), or only here, pushed when it can and counted till then
          if (!ownHandedOver) l.resume()
          throw failure ?? new Error('the kept copy would not open')
        }
        if (library) {
          if (copy) {
            // what only this tab holds (its own handover didn't land, nor the push) joins it as local changes
            if (!ownHandedOver) mergeUnsynced(library, l.library, device(), clock)
            creds = { ...credsOf(copy) }
            lastSealed = copy
            accountService().use({ email: creds.email, token: creds.token, session: l.session })
          }
        }
        if (!v) {
          // nobody keeps a copy any more (Keep turned off or signed out there): carry on here, Keep off
          keep.value = false
          ownerHere = false
          tabLock().release()
        }
        halt()
        model.setReadOnly(false)
        tab.value = 'here'
        run(library ?? l.library, l.session)
        // the merged changes (or, with a damaged copy, this whole library) aren't in the copy yet
        if (!library || library !== l.library) keptSeq = -1
        if (v === 'damaged' && creds) {
          const sealed = await Vault.create(l.library, cryptoClient(), l.session, creds, null)
          await stored(() => kept().save(sealed, { as: tabId, force: true })).then(() => (ownerHere = true), () => undefined)
        }
        if (keep.value) await saveKept().catch(() => undefined)
        return
      }
      if (!copy) {
        // nothing kept, or (claimed) another account's: left as it is
        tabLock().release()
        ownerHere = false
        keep.value = false
        // this tab's own sealed library, if it had one; else nothing is left to open here
        if (vault && creds && st.kind === 'locked') state.value = { kind: 'locked', email: st.email, reason: 'manual' }
        else toDemo()
        return
      }
      // this tab's own sealed edits that no handover carried: merged in when it unlocks
      if (vault && !vaultKept && unsyncedCount([...vault.items.values()].map((i) => i.sync)) > 0) pendingMerge = vault
      creds = credsOf(copy)
      vault = copy
      lastSealed = copy
      vaultKept = true
      keep.value = true
      await warmCrypto()
      state.value = { kind: 'locked', email: copy.email, reason: 'kept' }
    })
  }

  // ---- actions

  /** Refuses a second sign-in while one runs, or once this tab is signed in. */
  /** Signed in here: unlocked, or locked over a vault. */
  const signedInHere = (): boolean => {
    const kind = state.value.kind
    return kind === 'unlocked' || kind === 'locked'
  }

  async function signingInOnce<T>(body: () => Promise<T>): Promise<T> {
    if (signingIn) throw new Error('already signing in')
    if (signedInHere()) throw new Error('already signed in')
    signingIn = true
    try {
      // a kept copy being resumed (the page just opened, at a bookmarked /login, say) goes first: it shows its unlock
      // screen, and this sign-in is refused before it reaches the server rather than replace the copy's session
      await busy
      if (signedInHere()) throw new Error('already signed in')
      const run = body()
      signInRun = run.catch(() => undefined)
      return await run
    } finally {
      signingIn = false
    }
  }

  function start(s: SignedIn): void {
    // never over a session this tab already holds (a kept copy resumed meanwhile): the caller discards `s`
    if (signedInHere()) throw new Error('already signed in')
    // the notes written in the demo, offered once the account's notes are on screen (never a sample item)
    const demo = state.value.kind === 'demo' ? model.currentLibrary() : null
    const offered = demo ? demoNotesToOffer(demo) : []
    cloudAccount.value = s.account
    creds = {
      email: s.email, serverOrigin: deps.cloudOrigin, token: s.token, deviceId: s.deviceId, libraryId: s.libraryId,
      wrappedMasterPassword: s.wrappedMasterPassword, salt: s.salt, kdf: s.kdf,
    }
    vault = null
    lastSealed = null
    accountService().use({ email: s.email, token: s.token, session: s.session })
    run(new Library(clock), s.session)
    state.value = { kind: 'unlocked', email: s.email }
    if (demo && offered.length > 0) offerAfterSync = { library: live!.library, carry: { demo, ids: offered } }
  }

  function begin(s: SignedIn): Promise<void> {
    return signingInOnce(async () => start(s)).catch((e: unknown) => {
      // refused: the account handed in won't be used, so its key and its session on the server go
      if (live?.session !== s.session) void accountService().discard(s)
      throw e
    })
  }

  function logIn(email: string, password: string): Promise<void> {
    return signingInOnce(async () => {
      let s: SignedIn
      try {
        s = await accountService().signIn(email, password, device())
      } catch (e) {
        if (e instanceof AccountError && e.kind === 'deviceTooWeak') state.value = { kind: 'unsupported' }
        throw e
      }
      try {
        start(s)
      } catch (e) {
        void accountService().discard(s)
        throw e
      }
    })
  }

  function lock(reason: LockReason): Promise<void> {
    return serial(async () => {
      const st = state.value
      if (st.kind !== 'unlocked' || !live || !creds) return
      // typing up to now goes into the library being sealed; its changes count as unsynced until the vault holds them
      model.flush()
      sealing = live.library
      // a tab that lost the kept library to another tab locks to "FeatherMark is open in another tab."
      const wasLost = tab.value === 'lost'
      const { live: halted, stopped } = halt()
      const l = halted!
      // the notes leave the screen at once: no open note, no search, no object URLs ...
      model.setLibrary(new Library(clock))
      model.setReadOnly(false)
      tab.value = 'here'
      // ... and the unlock screen replaces the app, so nothing can be made in the empty library while the seal
      // finishes behind it (unlock and sign-out wait for it; hasUnsynced counts `sealing` until the vault is set)
      state.value = { kind: 'locked', email: st.email, reason: wasLost ? 'otherTab' : reason }
      const c = cryptoClient()
      let sealed: Vault
      try {
        // a pass in flight would move the cursor past items the snapshot never saw: let it end first (it stops at the
        // next page, batch or upload)
        await stopped
        sealed = await Vault.create(l.library, c, l.session, creds, lastSealed)
      } catch (e) {
        // nothing could be sealed (the worker is gone): back to the notes rather than lose the edits
        sealing = null
        run(l.library, l.session)
        if (wasLost) {
          model.setReadOnly(true)
          tab.value = 'lost'
          void live!.stop()
        }
        state.value = { kind: 'unlocked', email: st.email }
        // whoever asked (Lock now, the idle timer) learns it didn't happen
        model.showError(accountMessage(e))
        throw e
      }
      vault = sealed
      lastSealed = sealed
      sealing = null
      // "Keep my notes on this browser": the kept copy is this vault (only the owning tab writes it); a refused or failed
      // save leaves the edits in this vault only, so closing asks (vaultKept)
      vaultKept = false
      if (keep.value && ownerHere) {
        await stored(() => kept().save(sealed, { as: tabId })).then(
          () => (vaultKept = true),
          (e: unknown) => {
            if (e instanceof NotKeptOwner) notOwnerAnyMore()
          },
        )
      }
      // then the worker drops the master key; the unlock screen was already up
      await c.forget(l.session).catch(() => undefined)
      accountService().forget()
      // and whatever an abandoned log-in or create-account screen left behind (best effort, in the background)
      void accountService().discardLoose()
    })
  }

  function unlock(password: string): Promise<void> {
    return serial(async () => {
      const st = state.value
      if (st.kind !== 'locked' || st.reason === 'otherTab' || !vault || !creds) return
      const c = cryptoClient()
      let session: number
      // what a sign-in again changes; taken into the credentials and the vault together, once the vault has opened
      let next: VaultCredentials = creds
      if (st.reason === 'signedOut') {
        // the token is dead: sign in again, then carry on with what the vault kept
        const s = await accountService().signIn(st.email, password, device())
        session = s.session
        next = { ...creds, token: s.token, deviceId: s.deviceId, wrappedMasterPassword: s.wrappedMasterPassword, salt: s.salt, kdf: s.kdf }
      } else {
        let kek: number
        try {
          ;({ kek } = await c.logInKeys(password, vault.salt, vault.kdf))
        } catch (e) {
          throw tooWeak(e) ? new AccountError('deviceTooWeak') : e
        }
        try {
          ;({ session } = await c.unwrap(vault.wrappedMasterPassword, kek, 'password'))
        } catch {
          await c.forget(kek).catch(() => undefined)
          throw new AccountError('wrongPassword')
        }
      }
      let library: Library
      try {
        library = await vault.open(c, session, clock)
      } catch (e) {
        await c.forget(session).catch(() => undefined)
        // signed in again but the vault won't open with this account's key (it was deleted and made again): end
        // that new session rather than leave it behind
        if (st.reason === 'signedOut') void accountService().signOut()
        throw e instanceof CryptoError ? new AccountError('server', 'vault_unreadable') : e
      }
      creds = next
      Object.assign(vault, { token: next.token, deviceId: next.deviceId, wrappedMasterPassword: next.wrappedMasterPassword, salt: next.salt, kdf: next.kdf })
      accountService().use({ email: creds.email, token: creds.token, session })
      lastSealed = vault
      vault = null
      // this tab's own edits that no handover carried, from before it took the copy back: they join as local changes
      let merged = false
      if (pendingMerge) {
        const own = await pendingMerge.open(c, session, clock).catch(() => null)
        if (own) merged = mergeUnsynced(library, own, device(), clock) > 0
        // not merged (it wouldn't open): it stays, counted as unsynced, rather than be dropped
        if (own) pendingMerge = null
      }
      run(library, session)
      // the merged changes aren't in the kept copy yet: closing asks until a save has them
      if (merged) keptSeq = -1
      state.value = { kind: 'unlocked', email: creds.email }
      // another tab asked for the copy while this unlock ran (handOver waits behind it): read-only at once
      if (keep.value && !ownerHere && lockHolder) {
        model.setReadOnly(true)
        tab.value = 'lost'
      }
    })
  }

  /** Whether another tab owns the kept library this tab shows (or would open). */
  const notOwner = () => tab.value === 'lost' || (state.value.kind === 'locked' && state.value.reason === 'otherTab')

  function signOut(o?: { force: boolean }): Promise<'done' | 'unsynced'> {
    // the tab that owns the kept library signs out (its copy and session would come back from it otherwise)
    if (notOwner()) return Promise.reject(new NotOwner())
    // asks at once, even while a lock is still sealing (its library's changes count until the vault holds them)
    if (!o?.force && hasUnsynced()) return Promise.resolve('unsynced')
    return serial(async () => {
      if (!o?.force && hasUnsynced()) return 'unsynced'
      const l = halt().live
      const c = creds
      if (c && state.value.kind !== 'unsupported') void api(c.token).logout().catch(() => undefined)
      if (l && crypto) await crypto.forget(l.session).catch(() => undefined)
      // what an abandoned screen left: its keys go with the worker below; its sessions are ended on the server
      if (account) void account.discardLoose()
      crypto?.terminate()
      crypto = null
      account = null
      creds = null
      vault = null
      lastSealed = null
      // the kept copy goes with the account (after any save still running), if it is this tab's, and the tab lock
      if (keptStore) await stored(() => kept().remove(tabId)).catch(() => undefined)
      ownerHere = false
      pendingMerge = null
      lockHolder?.release()
      tab.value = 'here'
      model.setReadOnly(false)
      keep.value = false
      cloudAccount.value = null
      model.setLibrary(deps.demoLibrary())
      state.value = { kind: 'demo' }
      return 'done'
    })
  }

  function hasUnsynced(): boolean {
    if (pendingMerge && unsyncedCount([...pendingMerge.items.values()].map((i) => i.sync)) > 0) return true
    if (sealing) return unsyncedCount(sealing.syncItems()) > 0
    if (live) return unsyncedCount(live.library.syncItems()) > 0
    if (vault) return unsyncedCount([...vault.items.values()].map((i) => i.sync)) > 0
    return false
  }

  /** Every note body and attachment the export needs, downloaded (Download all notes). Returns the content of
   *  attachments that arrived but couldn't be stored (edited here meanwhile). refuseIfMissing then checks the library as
   *  it is by then: nothing is ever saved as an empty file. */
  async function loadEverything(l: Live): Promise<Map<string, Uint8Array>> {
    const lib = l.library
    const unloaded = (id: string) => lib.syncItem(id)?.bodyLoaded === false
    const live = lib.notes({ kind: 'all' })
    await Promise.all(live.filter((n) => unloaded(n.id)).map((n) => l.loader.openNote(n.id)))
    const used = new Map(live.flatMap((n) => lib.attachmentsOf(lib.note(n.id)?.body ?? '')).map((a) => [a.id, a]))
    const content = new Map<string, Uint8Array>()
    await Promise.all(
      [...used.keys()].filter(unloaded).map(async (id) => {
        const bytes = await l.loader.loadAttachment(id).catch(() => null)
        if (bytes && unloaded(id)) content.set(id, bytes)
      }),
    )
    return content
  }

  /** Refuses the export if anything it would write hasn't arrived. Run on the library as it is now, right before the
   *  zip is made (synchronously after): a pull during the downloads may have brought notes or attachments in. */
  function refuseIfMissing(lib: Library, content: Map<string, Uint8Array>): void {
    const unloaded = (id: string) => lib.syncItem(id)?.bodyLoaded === false
    const live = lib.notes({ kind: 'all' })
    if (live.some((n) => unloaded(n.id))) throw new ExportIncomplete()
    for (const n of live) {
      for (const a of lib.attachmentsOf(lib.note(n.id)?.body ?? '')) if (unloaded(a.id) && !content.has(a.id)) throw new ExportIncomplete()
    }
  }

  return {
    state,
    status,
    keep,
    tab,
    cloudAccount,
    demoOffer,
    addDemoNotes() {
      const carry = demoCarry
      dropDemoOffer()
      if (!carry || !live || tab.value === 'lost') return
      model.flush()
      carryDemoNotes(carry.demo, live.library, carry.ids)
    },
    dismissDemoNotes: dropDemoOffer,
    async refreshAccount() {
      if (state.value.kind !== 'unlocked') return
      const a = await accountService().account()
      if (state.value.kind === 'unlocked') cloudAccount.value = a
    },
    syncNow() {
      if (live && tab.value !== 'lost') live.engine.syncNow()
    },
    conflicts: () => live?.library.syncConflicts() ?? [],
    changePassword(current, next) {
      if (notOwner()) return Promise.reject(new NotOwner())
      return serial(async () => {
        const l = live
        if (state.value.kind !== 'unlocked' || !l || !creds) throw new AccountError('server', 'signed_out')
        // nothing in flight with the old token: the server ends every other session, and this one's token changes
        model.flush()
        await l.pause()
        try {
          const c = await accountService().changePassword(current, next)
          creds = { ...creds, token: c.token, wrappedMasterPassword: c.wrappedMasterPassword, salt: c.salt, kdf: c.kdf }
          l.client.setToken(c.token)
        } finally {
          if (live === l) l.restart()
        }
        // "Keep my notes on this browser": the kept copy unlocks with the new password from now on
        if (keep.value) await saveKept().catch(() => undefined)
      })
    },
    async deleteAccount(password) {
      if (notOwner()) throw new NotOwner()
      if (state.value.kind !== 'unlocked') throw new AccountError('server', 'signed_out')
      await accountService().deleteAccount(password)
      // gone on the server: nothing left to sync, and what is here goes with it
      await signOut({ force: true })
    },
    async exportLibrary() {
      const l = live
      if (!l) throw new AccountError('server', 'signed_out')
      model.flush()
      const content = await loadEverything(l)
      refuseIfMissing(l.library, content)
      return libraryZip(l.library, (id) => content.get(id))
    },
    message: (e) =>
      e instanceof KeepRefused
        ? keepMessage(e)
        : e instanceof ExportIncomplete
          ? e.message
        : e instanceof NotOwner
          ? 'FeatherMark is now open in another tab.'
          : accountMessage(typeof e === 'string' ? new AccountError(e as AccountErrorKind) : e),
    account: accountService,
    deviceName: device,
    serverInfo: () => new ApiClient({ base, ...(deps.fetch ? { fetch: deps.fetch } : {}) }).server(),
    logIn,
    begin,
    unlock,
    lock,
    signOut,
    setKeep(on) {
      if (notOwner()) return Promise.reject(new NotOwner())
      return serial(async () => {
        if (on) {
          if (state.value.kind !== 'unlocked' || !live || !creds) return
          if (keep.value && ownerHere) return
          // never over another account's copy, a copy another tab keeps, or changes kept here that haven't synced
          const peek = await peekKept()
          if (peek && !ours(peek, creds)) throw new KeepRefused('otherAccount', peek.email)
          if ((await tabLock().acquire({ steal: false })) === 'busy') throw new KeepRefused('otherTab')
          if (peek && unsyncedCount([...peek.items.values()].map((i) => i.sync)) > 0) {
            tabLock().release()
            throw new KeepRefused('unsyncedKept')
          }
          model.flush()
          try {
            // the copy is created (or the leftover one, all synced, replaced) as this tab's, if no other tab got there
            const seq = live.library.localChangeSeq
            const v = await Vault.create(live.library, cryptoClient(), live.session, creds, null)
            await stored(() => kept().save(v, { as: tabId, from: peek ? kept().owner : null }))
            lastSealed = v
            keptSeq = seq
            ownerHere = true
            keep.value = true
          } catch (e) {
            // another tab got there first, or the browser refused to store it (private window, no space): Keep stays off
            tabLock().release()
            throw e instanceof NotKeptOwner ? new KeepRefused('otherTab') : e
          }
        } else {
          if (!keep.value) return
          if (!ownerHere) throw new NotOwner()
          await stored(() => kept().remove(tabId)).catch((e: unknown) => {
            if (e instanceof NotKeptOwner) notOwnerAnyMore()
            throw e instanceof NotKeptOwner ? new NotOwner() : e
          })
          keep.value = false
          ownerHere = false
          lastSealed = null
          lockHolder?.release()
        }
      })
    },
    resume,
    takeOver,
    noteActivity() {
      lastActivity = clock()
    },
    pageHidden() {
      if (!live || tab.value === 'lost') return
      model.flush()
      live.engine.syncNow()
      // "Keep my notes on this browser": kept at once (a hidden tab may be closed next, and pagehide can't wait)
      void saveKept().catch(() => undefined)
    },
    pageClosing(persisted) {
      if (persisted || keep.value || !creds) return
      if (state.value.kind !== 'unlocked' && state.value.kind !== 'locked') return
      void api(creds.token).logout({ keepalive: true }).catch(() => undefined)
    },
    vault: () => vault,
    hasUnsynced,
    shouldWarnOnClose() {
      // typing still in the 500 ms save delay counts
      if (live && tab.value !== 'lost') model.flush()
      // a tab that lost the kept library: warns only if its handover didn't save what it held
      if (tab.value === 'lost') return !handedOver && hasUnsynced()
      if (!keep.value || sealing) return hasUnsynced()
      if (pendingMerge && hasUnsynced()) return true
      // Keep on, locked: the vault's edits are kept, or only here
      if (!live) return !vaultKept && hasUnsynced()
      // Keep on: changes neither pushed nor yet in the kept copy
      return unsyncedCount(live.library.syncItems().filter((s) => s.dirtySeq !== null && s.dirtySeq > keptSeq)) > 0
    },
    dispose() {
      lockHolder?.release()
      channel?.close()
      halt()
      opened()
      crypto?.terminate()
      crypto = null
    },
  }
}
