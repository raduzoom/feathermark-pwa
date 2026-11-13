// sync-protocol.md "Client sync algorithm" for one library and account, plus the schedule it runs on. Ported step for
// step from SyncEngine.swift: the pass (push, pull, one repeat), push in batches, pull with deferred references, take
// with three tries, resolve, and the schedule. Where the web differs (note bodies load after metadata, bodies.ts) the
// conflict path still downloads what it compares, so a dirty note always has its body when compared.
import { signal, type ReadonlySignal } from '@preact/signals'
import type { Clock } from '../clock.ts'
import { CryptoError } from '../crypto/errors.ts'
import type { Library } from '../library/library.ts'
import type { SyncItem } from '../library/sync-state.ts'
import type { Note } from '../library/types.ts'
import type { TimerFns } from '../../model/app-model.ts'
import type { CryptoClient } from '../../worker/crypto-client.ts'
import type { OpenResult } from '../../worker/crypto-protocol.ts'
import { sha256Hex } from '../library/attachments.ts'
import { ApiError, type ApiClient, type Change, type PulledItem } from './api.ts'
import { Backoff } from './backoff.ts'
import { bodyText, openBlob } from './bodies.ts'
import { CodecError, metaJson, readMeta, type DecodedMeta, type ItemType } from './codec.ts'
import { conflictTitle, resolveName, resolveNote, resolveParent } from './conflict.ts'

/** What the status line shows about sync (ui-copy.md "Sync status lines"). */
export type SyncStatus =
  | { kind: 'idle'; lastSynced: number | null }
  | { kind: 'syncing'; done: number; total: number }
  | { kind: 'loading'; done: number; total: number }
  | { kind: 'offline' }
  | { kind: 'error'; message: string }
  /** The plan is read-only: changes stay here, pulls continue. */
  | { kind: 'readOnly' }
  /** A change didn't fit the quota; it stays here until there is room. */
  | { kind: 'quotaFull' }
  /** The server ended the session (401): the app signs out and keeps its notes. */
  | { kind: 'signedOut' }

/** What one pass did. */
export type SyncReport = {
  pushed: number
  pulled: number
  conflictCopies: string[]
  nameConflicts: number
  /** Rejected changes: item id → error code. They stay dirty. */
  rejected: Record<string, string>
  readOnly: boolean
  quotaFull: boolean
  /** Pulled items (or push conflicts) that couldn't be stored, because this device kept changing them: the cursor
   *  stays before them, the pass isn't shown as synced, and the next pass comes soon. */
  skipped: number
}

/** Tests only: called after the push ("afterPush") and between a pulled item's decode and its apply ("beforeApply",
 *  with its id), so a test can make a local edit at exactly that moment (SyncEngine.swift setTestHook). */
export type SyncTestHook = (event: 'afterPush' | 'beforeApply', id?: string) => void | Promise<void>

export type SyncHooks = {
  /** Saves pending edits before each pass. */
  beforeSync(): void | Promise<void>
  /** The ids pulled or changed by resolution in a pass. */
  onPulled(ids: Set<string>): void
  /** The server answered 401: the schedule stops; local notes stay. */
  onSignedOut(): void
  /** A scheduled pass ended, synced or not (offline, an error): "Keep my notes on this browser" saves the vault. */
  afterPass?(ok: boolean): void
}

const ORDER: Record<ItemType, number> = { attachment: 0, notebook: 1, tag: 1, note: 2 }
const BATCH = 100
const EVERY_MS = 300_000
const DEBOUNCE_MS = 2_000
const defaultTimers: TimerFns = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }

type Pending = { item: SyncItem; change: Change; blobSha: string | null }
/** A pulled item opened and read; `body` is the note's text when its blob was downloaded (forceBlob), else null. */
type Decoded = { meta: DecodedMeta; body: string | null }
/** What one take of a pulled item did: stored it (`applied`), had nothing to do or resolved a conflict (`none`), or
 *  couldn't store it because this device kept changing the item (`skipped`). */
type Taken = 'applied' | 'none' | 'skipped'
/** How often a take tries to store an item after everything it needs has been downloaded. */
const TRIES = 3
/** A pass that skipped an item comes again after this long. */
const SKIPPED_RETRY_MS = DEBOUNCE_MS
/** What a take has downloaded so far. `decoded`: undefined until read, null when the item has no metadata. */
type Prep = { decoded: Decoded | null | undefined; body: 'none' | 'have' | 'failed'; ownBodyTried: boolean; hooked: boolean }

export class SyncEngine {
  private readonly library: Library
  private readonly api: ApiClient
  private readonly crypto: CryptoClient
  private readonly session: number
  private readonly libraryId: string
  private readonly deviceName: string
  private readonly clock: Clock
  private readonly timers: TimerFns
  private readonly random: () => number
  private readonly testHook: SyncTestHook | null

  private readonly current = signal<SyncStatus>({ kind: 'idle', lastSynced: null })
  readonly status: ReadonlySignal<SyncStatus> = this.current

  constructor(o: {
    library: Library
    api: ApiClient
    crypto: CryptoClient
    session: number
    libraryId: string
    deviceName: string
    clock: Clock
    timers?: TimerFns
    random?: () => number
    /** Tests only; never set by app code. */
    testHook?: SyncTestHook
  }) {
    this.library = o.library
    this.api = o.api
    this.crypto = o.crypto
    this.session = o.session
    this.libraryId = o.libraryId
    this.deviceName = o.deviceName
    this.clock = o.clock
    this.timers = o.timers ?? defaultTimers
    this.random = o.random ?? Math.random
    this.testHook = o.testHook ?? null
  }

  private set(s: SyncStatus): void {
    this.current.value = s
  }

  /** Body loading progress (BodyLoader's onProgress): shown while nothing more pressing is. */
  loading(done: number, total: number): void {
    const kind = this.current.value.kind
    if (kind !== 'idle' && kind !== 'syncing' && kind !== 'loading') return
    if (done < total) this.set({ kind: 'loading', done, total })
    else if (kind === 'loading') this.set({ kind: 'idle', lastSynced: this.lastSynced })
  }

  // ---- one pass

  private chain: Promise<unknown> = Promise.resolve()
  private changedIds = new Set<string>()
  /** The schedule generation the current pass started under. */
  private passGeneration = 0
  /** The scheduled run in flight, if any (stop() waits for it). */
  private running: Promise<void> = Promise.resolve()

  /** Whether stop() was called since the pass started under `generation` (only for a scheduled engine). */
  private stopped(generation: number): boolean {
    return generation !== this.generation && this.hooks === null
  }

  /** Pushes, pulls, resolves conflicts, and repeats once if resolving made new changes. One pass at a time: a second
   *  call waits for the first (they would share state and push twice). `changed`: ids pulled or changed by resolution. */
  syncOnce(): Promise<{ report: SyncReport; changed: Set<string> }> {
    const run = this.chain.then(() => this.pass())
    this.chain = run.catch(() => undefined)
    return run
  }

  private async pass(): Promise<{ report: SyncReport; changed: Set<string> }> {
    // stop() ends the pass early: between push batches and between pull pages, never inside a page
    const generation = this.generation
    this.passGeneration = generation
    const report: SyncReport = { pushed: 0, pulled: 0, conflictCopies: [], nameConflicts: 0, rejected: {}, readOnly: false, quotaFull: false, skipped: 0 }
    this.changedIds = new Set()
    for (let pass = 0; pass < 2; pass++) {
      const dirty = this.library.dirtyItems()
      if (pass === 1 && dirty.length === 0 && report.skipped === 0) break
      // only the last round's skips count: a skip the repeat healed is gone
      report.skipped = 0
      const conflicts: PulledItem[] = []
      if (!report.readOnly) {
        try {
          await this.push(dirty, report, conflicts)
          await this.testHook?.('afterPush')
        } catch (e) {
          if (e instanceof ApiError && e.code === 'read_only') report.readOnly = true
          else throw e
        }
      }
      // stopped during the push: no pull (lock waits for this pass to end)
      if (this.stopped(generation)) break
      await this.pull(report)
      if (this.stopped(generation)) break
      // sync-protocol.md step 3: a push conflict is resolved against the server's current item. After the pull, so
      // anything it references (a tag, a notebook) has arrived; an item the pull already resolved is skipped by
      // take's version check. This also heals an item whose newer version the pull won't return again.
      for (const current of conflicts) if ((await this.take(current, report, true)) === 'skipped') report.skipped++
      if (report.skipped === 0 && (report.readOnly || this.library.dirtyItems().every((s) => s.metaVersion > 1))) break
    }
    return { report, changed: this.changedIds }
  }

  // ---- push

  private async push(dirty: SyncItem[], report: SyncReport, conflicts: PulledItem[]): Promise<void> {
    // an item whose metadata is newer than this app (v > 1) is read-only here: never pushed
    const items = dirty.filter((s) => s.metaVersion <= 1).sort((a, b) => ORDER[a.type] - ORDER[b.type] || a.dirtySeq! - b.dirtySeq!)
    const pending: Pending[] = []
    for (const item of items) {
      const dirtySeq = item.dirtySeq
      if (dirtySeq === null) continue
      if (item.deleted) {
        if (item.serverVersion === 0) {
          // never reached the server: nothing to tell it
          this.library.markPushed(item.id, 0, null, dirtySeq)
          continue
        }
        pending.push({ item, change: { id: item.id, type: item.type, baseVersion: item.serverVersion, deleted: true, meta: null, blobSha256: null }, blobSha: null })
        continue
      }
      let encoded: { meta: Uint8Array; blob: Uint8Array | null } | null
      try {
        encoded = await this.encode(item)
      } catch (e) {
        // a title too long for the 64 KiB metadata limit: it stays here, the rest still syncs
        if (e instanceof CodecError) {
          report.rejected[item.id] = e.kind
          continue
        }
        throw e
      }
      if (!encoded) continue
      let blobSha = item.blobSha
      if (encoded.blob) {
        // stopped: no more uploads (each may take minutes); everything not pushed stays dirty
        if (this.stopped(this.passGeneration)) return
        const sha = await sha256Hex(encoded.blob)
        try {
          await this.api.putBlob(sha, encoded.blob) // attachments come first: `items` is sorted
        } catch (e) {
          if (e instanceof ApiError && (e.code === 'quota_exceeded' || e.code === 'blob_too_large')) {
            report.rejected[item.id] = e.code // stays dirty; the rest still syncs
            if (e.code === 'quota_exceeded') report.quotaFull = true
            continue
          }
          throw e
        }
        blobSha = sha
      }
      const needsBlob = item.type === 'note' || item.type === 'attachment'
      // a body that hasn't arrived and has no blob on the server: nothing to push it with
      if (needsBlob && blobSha === null) continue
      pending.push({
        item,
        change: { id: item.id, type: item.type, baseVersion: item.serverVersion, deleted: false, meta: encoded.meta, blobSha256: needsBlob ? blobSha : null },
        blobSha,
      })
    }
    const total = pending.length
    let done = 0
    if (total > 0) this.set({ kind: 'syncing', done: 0, total })
    for (let i = 0; i < pending.length; i += BATCH) {
      if (this.stopped(this.passGeneration)) return
      const batch = pending.slice(i, i + BATCH)
      const results = await this.api.push(this.libraryId, batch.map((p) => p.change))
      batch.forEach((p, j) => {
        const r = results[j]
        if (!r) return
        switch (r.status) {
          case 'accepted':
            this.library.markPushed(p.item.id, r.version, p.blobSha, p.item.dirtySeq!)
            report.pushed++
            break
          case 'conflict':
            // left dirty; resolved against r.current after the pull (pass)
            conflicts.push(r.current)
            break
          case 'rejected':
            report.rejected[p.item.id] = r.code
            // upload it again next pass; a body that hasn't arrived here can't be uploaded
            if (r.code === 'blob_missing' && p.item.bodyLoaded) this.library.markBodyDirty(p.item.id)
            if (r.code === 'quota_exceeded') report.quotaFull = true
            break
        }
      })
      done += batch.length
      this.set({ kind: 'syncing', done, total })
    }
  }

  /** The sealed metadata, and the sealed blob when it must be uploaded (body changed, or never uploaded). A body or
   *  content that hasn't arrived from the server is never uploaded: its placeholder isn't the text. */
  private async encode(item: SyncItem): Promise<{ meta: Uint8Array; blob: Uint8Array | null } | null> {
    const upload = (item.bodyDirty || item.blobSha === null) && item.bodyLoaded
    let plain: Uint8Array
    let blob: { plain: Uint8Array; part: 'noteBody' | 'attachment' } | null = null
    switch (item.type) {
      case 'note': {
        const note = this.library.note(item.id)
        if (!note) return null
        plain = metaJson(note, 'note', item.extra)
        if (upload) blob = { plain: new TextEncoder().encode(note.body), part: 'noteBody' }
        break
      }
      case 'notebook': {
        const nb = this.library.notebooks().find((n) => n.id === item.id)
        if (!nb) return null
        plain = metaJson(nb, 'notebook', item.extra)
        break
      }
      case 'tag': {
        const tag = this.library.tags().find((t) => t.id === item.id)
        if (!tag) return null
        plain = metaJson(tag, 'tag', item.extra)
        break
      }
      case 'attachment': {
        const a = this.library.attachment(item.id)
        if (!a) return null
        const { bytes, origin: _origin, ...meta } = a
        plain = metaJson(meta, 'attachment', item.extra)
        if (upload) blob = { plain: bytes, part: 'attachment' }
        break
      }
    }
    const sealed = await this.crypto.seal(this.session, [
      { plain, part: 'metadata', id: item.id },
      ...(blob ? [{ plain: blob.plain, part: blob.part, id: item.id }] : []),
    ])
    return { meta: sealed[0]!, blob: blob ? sealed[1]! : null }
  }

  // ---- pull

  /** Notes and notebooks whose notebook, tags or parent hadn't arrived yet: applied again after the pull. */
  private deferred: PulledItem[] = []

  private async pull(report: SyncReport): Promise<void> {
    let cursor = this.library.syncValue('pull_cursor')
    this.deferred = []
    for (;;) {
      const page = await this.api.pull(this.libraryId, cursor)
      // the page's metadata opened in one call to the worker (one round trip per page, not per item)
      await this.openPage(page.items)
      let skipped = 0
      try {
        for (const remote of page.items) {
          const taken = await this.take(remote, report)
          if (taken === 'applied') report.pulled++
          else if (taken === 'skipped') skipped++
        }
      } finally {
        this.opened = new Map()
      }
      if (skipped > 0) {
        // never store the cursor past an item that wasn't stored: the next pass pulls this page again (what landed is
        // skipped there by take's version check) and no later page is pulled now
        report.skipped += skipped
        break
      }
      cursor = page.cursor
      this.library.setSyncValue('pull_cursor', cursor)
      if (!page.hasMore || this.stopped(this.passGeneration)) break
    }
    // references arrive in seq order, so a note can come before a notebook renamed after it was filed there
    const again = this.deferred
    this.deferred = []
    for (const remote of again) if ((await this.take(remote, report, true)) === 'skipped') report.skipped++
  }

  /** Applies one pulled item, or resolves it against a local change. Everything the decision needs is downloaded
   *  first (the metadata, the note's body, the body this note had here); then the check and the write happen with no
   *  await between them, so typing can't get in. A write refused anyway (beforeWrite turned a pending keystroke into a
   *  local change) is looked at again at once: up to TRIES times, then the item is skipped. */
  private async take(remote: PulledItem, report: SyncReport, reapply = false): Promise<Taken> {
    const prep: Prep = { decoded: undefined, body: 'none', ownBodyTried: false, hooked: false }
    for (let tries = 0; tries < TRIES; ) {
      const local = this.library.syncItem(remote.id)
      const dirty = local !== null && local.dirtySeq !== null
      if (local && dirty) {
        // our own push coming back, with a later edit on top: the next pass pushes that edit
        if (remote.version <= local.serverVersion) return 'none'
      } else if (local && (reapply ? local.serverVersion > remote.version : local.serverVersion >= remote.version)) {
        // our own push coming back; on a reapply, the same version again is expected, but an older one (the item moved
        // on in a later page) must never roll the copy here back behind the cursor
        return 'none'
      }
      // fetch what this attempt needs, then look again (each piece is fetched at most once, so this ends)
      if (await this.prepare(remote, local, dirty, prep)) continue
      if (this.testHook && !prep.hooked) {
        prep.hooked = true
        await this.testHook('beforeApply', remote.id)
        continue
      }
      tries++
      if (local && dirty) {
        if (this.resolve(local, remote, prep, report)) return 'none'
      } else if (this.apply(remote, prep.decoded ?? null, !reapply)) return 'applied'
    }
    return 'skipped'
  }

  /** Downloads one missing piece for the next attempt; true when it awaited (the caller looks again). */
  private async prepare(remote: PulledItem, local: SyncItem | null, dirty: boolean, prep: Prep): Promise<boolean> {
    const ownBody = (l: SyncItem) => l.type === 'note' && !l.deleted && !l.bodyLoaded && !prep.ownBodyTried && this.library.note(l.id) !== undefined
    if (remote.deleted) {
      // rule 3 needs the text this note had here, to bring it back
      if (local && dirty && ownBody(local)) {
        prep.ownBodyTried = true
        await this.loadOwnBody(local)
        return true
      }
      return false
    }
    if (prep.decoded === null) return false // nothing to read
    // the conflict path compares texts; the open note's body comes with it (never shown as loading because another
    // device changed it)
    const needBody = remote.type === 'note' && remote.blob !== null && (dirty || this.library.wantsBody(remote.id))
    if (needBody && dirty && prep.body !== 'have') {
      // a failure here fails the pass, as before: a conflict is never resolved against a body that didn't download
      prep.decoded = await this.decode(remote, true)
      prep.body = 'have'
      return true
    }
    if (needBody && prep.body === 'none') {
      prep.decoded = await this.decode(remote, true).catch((e: unknown) => {
        // a body the server lacks or that won't open: the metadata still lands, the body loads (or fails) as any other
        if ((e instanceof ApiError && e.status === 404) || e instanceof CryptoError) return this.decode(remote, false)
        throw e
      })
      prep.body = prep.decoded?.body != null ? 'have' : 'failed'
      return true
    }
    if (prep.decoded === undefined) {
      prep.decoded = await this.decode(remote, false)
      return true
    }
    // compare real text: the body this note had before it changed here
    if (local && dirty && ownBody(local) && prep.decoded.meta.metaVersion <= 1 && local.metaVersion <= 1) {
      prep.ownBodyTried = true
      await this.loadOwnBody(local)
      return true
    }
    return false
  }

  /** Each pulled item's metadata, opened ahead for the page being taken. */
  private opened = new Map<PulledItem, OpenResult>()

  private async openPage(items: PulledItem[]): Promise<void> {
    const withMeta = items.filter((r) => !r.deleted && r.meta)
    if (withMeta.length === 0) return
    const results = await this.crypto.open(this.session, withMeta.map((r) => ({ envelope: r.meta!, part: 'metadata' as const, id: r.id })))
    this.opened = new Map(withMeta.map((r, i) => [r, results[i]!]))
  }

  /** Opens and reads a pulled item's metadata. `forceBlob` also downloads a note's body (the conflict path, where the
   *  text is compared); otherwise bodies load later (bodies.ts) and attachments when shown. */
  private async decode(remote: PulledItem, forceBlob: boolean): Promise<Decoded | null> {
    if (!remote.meta) return null
    const plain = this.opened.get(remote) ?? (await this.crypto.open(this.session, [{ envelope: remote.meta, part: 'metadata', id: remote.id }]))[0]
    if (!(plain instanceof Uint8Array)) throw new CryptoError(plain && 'error' in plain ? plain.error : 'malformed')
    const meta = readMeta(remote.type, remote.id, plain)
    let body: string | null = null
    if (forceBlob && remote.type === 'note' && remote.blob) body = bodyText(await openBlob(this.api, this.crypto, this.session, remote.id, remote.blob.sha256, 'noteBody'))
    return { meta, body }
  }

  /** Applies a remote item to a clean local one. False when a local edit got in first. No await: the caller checked
   *  the item a moment ago. */
  private apply(remote: PulledItem, decoded: Decoded | null, deferIncomplete: boolean): boolean {
    if (remote.deleted) {
      const ok = this.library.applyRemoteDelete(remote.id, remote.type, remote.version)
      if (ok) this.changedIds.add(remote.id)
      return ok
    }
    if (!decoded) return true
    if (deferIncomplete && !this.referencesResolve(decoded.meta) && !this.deferred.includes(remote)) this.deferred.push(remote)
    const ok = this.store(decoded, remote, null)
    if (ok) this.changedIds.add(remote.id)
    return ok
  }

  private referencesResolve(m: DecodedMeta): boolean {
    if (m.type === 'note') return this.library.referencesResolve(m.note.notebookId, m.note.tagIds)
    if (m.type === 'notebook') return this.library.referencesResolve(m.notebook.parentId, [])
    return true
  }

  private store(d: Decoded, remote: PulledItem, ifDirtySeq: number | null): boolean {
    const { meta: m } = d
    const base = { version: remote.version, extra: m.extra, metaVersion: m.metaVersion, ifDirtySeq }
    switch (m.type) {
      case 'note': {
        const blobSha = remote.blob?.sha256 ?? null
        let note: Note = m.note
        let bodyLoaded: boolean
        if (d.body !== null) {
          note = { ...note, body: d.body }
          bodyLoaded = true
        } else if (blobSha === null) {
          bodyLoaded = true
        } else {
          // the same blob as here: keep the body (and whether it has arrived); a new one loads in the background
          const here = this.library.syncItem(m.note.id)
          if (here && here.blobSha === blobSha) {
            note = { ...note, body: this.library.note(m.note.id)?.body ?? '' }
            bodyLoaded = here.bodyLoaded
          } else {
            bodyLoaded = false
          }
        }
        return this.library.applyRemoteNote(note, { ...base, blobSha, bodyLoaded })
      }
      case 'notebook': {
        const nb = m.notebook
        const parents = new Map(this.library.notebooks().map((n) => [n.id, n.parentId]))
        const parentId = resolveParent(nb.parentId, nb.id, parents)
        if (!this.library.applyRemoteNotebook({ ...nb, parentId }, base)) return false
        // the cycle guard put it at the top level: this device moved it, so push that (next pass)
        if (parentId !== nb.parentId && m.metaVersion <= 1) this.library.moveNotebook(nb.id, null)
        return true
      }
      case 'tag':
        return this.library.applyRemoteTag(m.tag, base)
      case 'attachment':
        return this.library.applyRemoteAttachment(m.attachment, null, { ...base, blobSha: remote.blob?.sha256 ?? null })
    }
  }

  // ---- conflicts

  /** Downloads the body this note had before it changed here (its last blob), so it can be compared or pushed again.
   *  False when there is none, the server no longer has it, or it can't be opened. */
  private async loadOwnBody(local: SyncItem): Promise<boolean> {
    if (local.blobSha === null) return false
    let body: string
    try {
      body = bodyText(await openBlob(this.api, this.crypto, this.session, local.id, local.blobSha, 'noteBody'))
    } catch (e) {
      if ((e instanceof ApiError && e.status === 404) || e instanceof CryptoError) return false
      throw e
    }
    return this.library.setRemoteBody(local.id, body, local.blobSha)
  }

  /** An item changed here (dirty) and on the server: the rules of sync-protocol.md "Conflict resolution". False when a
   *  newer local edit arrived meanwhile (the caller looks again). No await: take downloaded what it needs. */
  private resolve(local: SyncItem, remote: PulledItem, prep: Prep, report: SyncReport): boolean {
    const seq = local.dirtySeq
    this.changedIds.add(local.id)
    if (remote.deleted) {
      const edited = local.type === 'note' && !local.deleted ? this.library.note(local.id) : undefined
      if (edited) {
        // rule 3: it comes back everywhere, with its text; without its text there is nothing to bring back
        if (!local.bodyLoaded) return this.library.applyRemoteDelete(local.id, local.type, remote.version, seq)
        this.library.rebase(local.id, remote.version)
        return true
      }
      // a deletion wins over a local edit to a notebook, tag or attachment, and over a local delete
      return this.library.applyRemoteDelete(local.id, local.type, remote.version, seq)
    }
    const decoded = prep.decoded
    if (!decoded) return true
    // read-only here: the server's version wins
    if (local.metaVersion > 1) return this.store(decoded, remote, seq)
    const m = decoded.meta
    switch (m.type) {
      case 'note': {
        let mine = local.deleted ? undefined : this.library.note(local.id)
        // rule 4: a local delete loses to an edit
        if (!mine) return this.store(decoded, remote, seq)
        // a body that never arrived here (and couldn't be downloaded) can't have been edited here: compare the server's
        if (!local.bodyLoaded) mine = { ...mine, body: decoded.body ?? mine.body }
        const server: Note = { ...m.note, body: decoded.body ?? '' }
        const r = resolveNote(mine, server, { localDeleted: false, serverDeleted: false })
        if (r.kind === 'copyLocal') {
          if (!this.store(decoded, remote, seq)) return false
          const title = conflictTitle(mine.title, this.deviceName, new Date(this.clock()))
          const copy = this.library.createConflictCopy(mine, title)
          report.conflictCopies.push(copy.id)
          this.changedIds.add(copy.id)
          return true
        }
        if (r.kind === 'mergeMeta') {
          if (!this.store(decoded, remote, seq)) return false
          const known = new Set(this.library.tags().map((t) => t.id))
          const tags = r.note.tagIds.filter((t) => known.has(t))
          const applied = this.library.note(local.id)?.tagIds ?? []
          if (tags.join() !== applied.join()) this.library.setTags(local.id, tags) // pushed next pass
          return true
        }
        return this.store(decoded, remote, seq)
      }
      case 'notebook':
        return this.resolveName(local, m.notebook.name, decoded, remote, report)
      case 'tag':
        return this.resolveName(local, m.tag.name, decoded, remote, report)
      case 'attachment':
        return this.store(decoded, remote, seq)
    }
  }

  /** Notebook and tag renames: the server's name wins; the losing local name is listed once. */
  private resolveName(local: SyncItem, serverName: string, decoded: Decoded, remote: PulledItem, report: SyncReport): boolean {
    const localName = local.type === 'notebook' ? this.library.notebooks().find((n) => n.id === local.id)?.name : this.library.tags().find((t) => t.id === local.id)?.name
    if (!this.store(decoded, remote, local.dirtySeq)) return false
    if (localName !== undefined && !local.deleted) {
      const { lost } = resolveName(localName, serverName)
      if (lost !== null) {
        this.library.recordSyncConflict({ itemId: local.id, type: local.type, lostName: lost, device: this.deviceName, at: this.clock() })
        report.nameConflicts++
      }
    }
    return true
  }

  // ---- schedule

  private hooks: SyncHooks | null = null
  /** Bumped by start() and stop(), so a pass from an earlier schedule doesn't reschedule this one. */
  private generation = 0
  private timer: unknown = null
  private debounce: unknown = null
  private inFlight = false
  private again = false
  /** No pass before this time (Retry-After). */
  private notBefore = 0
  private readonly backoff = new Backoff()
  private lastSynced: number | null = null

  /** Syncs now, then every 5 minutes, 2 s after local changes, and on demand. A 401 stops it; a later start() begins a
   *  new schedule. */
  start(hooks: SyncHooks): void {
    if (this.hooks) return
    this.hooks = hooks
    this.generation++
    void this.run()
  }

  /** A local edit: sync 2 s after the last one. */
  localChanged(): void {
    if (!this.hooks) return
    if (this.debounce !== null) this.timers.clear(this.debounce)
    this.debounce = this.timers.set(() => {
      this.debounce = null
      this.syncNow()
    }, DEBOUNCE_MS)
  }

  /** Syncs as soon as it may (not before a server's Retry-After). */
  syncNow(): void {
    if (!this.hooks) return
    if (this.inFlight) this.again = true
    else this.schedule(0)
  }

  /** Stops the schedule. A pass in flight ends at its next page or batch boundary, and calls no hook; the promise
   *  settles once it has (lock waits for it, so nothing lands in the library after its snapshot). */
  stop(): Promise<void> {
    this.hooks = null
    this.generation++
    this.again = false
    if (this.timer !== null) this.timers.clear(this.timer)
    if (this.debounce !== null) this.timers.clear(this.debounce)
    this.timer = null
    this.debounce = null
    return Promise.all([this.chain, this.running]).then(() => undefined)
  }

  private schedule(ms: number): void {
    if (!this.hooks) return
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = this.timers.set(() => {
      this.timer = null
      void this.run()
    }, Math.max(ms, this.notBefore - this.clock()))
  }

  private async run(): Promise<void> {
    const hooks = this.hooks
    if (!hooks) return
    if (this.inFlight) {
      this.again = true
      return
    }
    const generation = this.generation
    this.inFlight = true
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
    let delay: number | null
    let done!: () => void
    this.running = new Promise<void>((r) => (done = r))
    try {
      delay = await this.runOne(hooks, generation)
    } finally {
      this.inFlight = false
      done()
    }
    if (generation !== this.generation) {
      // stopped meanwhile, perhaps started again: the new schedule runs now
      if (this.hooks) {
        this.again = false
        void this.run()
      }
      return
    }
    if (delay === null) return this.stop()
    if (this.again) {
      this.again = false
      this.schedule(0)
    } else {
      this.schedule(delay)
    }
  }

  /** One scheduled pass; returns how long to wait for the next one, or null to stop (signed out). */
  private async runOne(hooks: SyncHooks, generation: number): Promise<number | null> {
    const next = await this.runPass(hooks, generation)
    if (next !== null && generation === this.generation) hooks.afterPass?.(this.passOk)
    return next
  }

  /** Whether the last scheduled pass synced (pushed and pulled to the end). */
  private passOk = false

  private async runPass(hooks: SyncHooks, generation: number): Promise<number | null> {
    try {
      await hooks.beforeSync()
      const { report, changed } = await this.syncOnce()
      // stopped meanwhile: the library this schedule ran for may be gone; tell no one
      if (generation !== this.generation) return null
      this.backoff.reset()
      this.notBefore = 0
      if (report.skipped === 0) this.lastSynced = this.clock()
      if (changed.size > 0) hooks.onPulled(changed)
      if (report.skipped > 0) {
        // not synced: something here kept changing an item the server changed too. Never "Synced"; again soon.
        this.passOk = false
        this.set({ kind: 'syncing', done: 0, total: report.skipped })
        return SKIPPED_RETRY_MS
      }
      this.passOk = true
      this.set(report.readOnly ? { kind: 'readOnly' } : report.quotaFull ? { kind: 'quotaFull' } : { kind: 'idle', lastSynced: this.lastSynced })
      return EVERY_MS
    } catch (e) {
      this.passOk = false
      if (generation !== this.generation) return null
      if (e instanceof ApiError) {
        if (e.status === 401) {
          this.set({ kind: 'signedOut' })
          hooks.onSignedOut()
          return null
        }
        if (e.status === 429) {
          this.set({ kind: 'error', message: 'Too many requests.' })
          const wait = (e.retryAfter ?? 60) * 1000
          this.notBefore = this.clock() + wait
          return wait
        }
        this.set(e.status === 0 ? { kind: 'offline' } : { kind: 'error', message: "The server didn't respond." })
      } else {
        this.set({ kind: 'error', message: "The server didn't respond." })
      }
      return this.backoff.next(this.random())
    }
  }
}
