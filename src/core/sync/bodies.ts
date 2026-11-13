// Note bodies after metadata (web design "Loading a library"): a pull stores every note's metadata first, so the
// list shows at once; the bodies download here in the background, newest `modified` first, and the opened note jumps
// the queue. Attachments download only when shown (`loadAttachment`). The Mac downloads blobs inside the pull step;
// the web defers them, and the engine's conflict path downloads what it compares (engine.ts, forceBlob).
import { CryptoError } from '../crypto/errors.ts'
import type { Part } from '../crypto/envelope.ts'
import type { Library } from '../library/library.ts'
import type { TimerFns } from '../../model/app-model.ts'
import type { CryptoClient } from '../../worker/crypto-client.ts'
import { ApiError, type ApiClient } from './api.ts'
import { Backoff } from './backoff.ts'

/** Downloads at once: enough to keep the connection busy while each body is opened in the worker. */
const PARALLEL = 4
const defaultTimers: TimerFns = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }

/** Downloads a blob and opens it. A blob that fails to open throws CryptoError. */
export async function openBlob(api: ApiClient, crypto: CryptoClient, session: number, id: string, sha: string, part: Part): Promise<Uint8Array> {
  const envelope = await api.getBlob(sha)
  const [r] = await crypto.open(session, [{ envelope, part, id }])
  if (r instanceof Uint8Array) return r
  throw new CryptoError(r && 'error' in r ? r.error : 'malformed')
}

/** A note body's text (UTF-8, as on the Mac: invalid bytes become U+FFFD). */
export const bodyText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/** A failure worth trying again: no answer, the server's own error, or too many requests. */
export const transient = (e: unknown): boolean => e instanceof ApiError && (e.status === 0 || e.status === 429 || e.status >= 500)

export class BodyLoader {
  private readonly library: Library
  private readonly api: ApiClient
  private readonly crypto: CryptoClient
  private readonly session: number
  private readonly onProgress: (done: number, total: number) => void
  private readonly timers: TimerFns
  private readonly random: () => number
  private readonly backoff = new Backoff()

  /** Opened notes, the latest first; they go before `queue`. */
  private urgent: string[] = []
  /** Every other note to load, newest `modified` first. */
  private queue: string[] = []
  /** Downloads under way (up to PARALLEL). */
  private inFlight = new Set<string>()
  private waiters = new Map<string, Array<() => void>>()
  private started = false
  private retryTimer: unknown = null
  /** Bumped by stop(): a download that finishes after it is dropped. */
  private generation = 0
  private done = 0
  private total = 0

  constructor(o: {
    library: Library
    api: ApiClient
    crypto: CryptoClient
    session: number
    onProgress(done: number, total: number): void
    timers?: TimerFns
    random?: () => number
  }) {
    this.library = o.library
    this.api = o.api
    this.crypto = o.crypto
    this.session = o.session
    this.onProgress = o.onProgress
    this.timers = o.timers ?? defaultTimers
    this.random = o.random ?? Math.random
  }

  /** Loads, in the background, every note whose body hasn't arrived. Call it again after a pull: it adds the new ones. */
  start(): void {
    this.started = true
    const known = new Set([...this.urgent, ...this.queue, ...this.inFlight])
    const fresh = this.unloaded().filter((n) => !known.has(n.id))
    if (fresh.length > 0) {
      const modified = new Map(this.unloaded().map((n) => [n.id, n.modified]))
      this.queue = [...this.queue, ...fresh.map((n) => n.id)].sort((a, b) => (modified.get(b) ?? 0) - (modified.get(a) ?? 0) || (a < b ? 1 : -1))
      this.total += fresh.length
      this.onProgress(this.done, this.total)
    }
    if (this.retryTimer === null) this.pump()
  }

  /** Loads this note's body now, ahead of the rest. Resolves once it has been tried (loaded, not needed, or failed). */
  openNote(id: string): Promise<void> {
    const item = this.library.syncItem(id)
    if (!item || item.type !== 'note' || item.bodyLoaded) return Promise.resolve()
    const wait = new Promise<void>((resolve) => this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]))
    if (!this.inFlight.has(id)) {
      const queued = this.queue.includes(id) || this.urgent.includes(id)
      this.queue = this.queue.filter((q) => q !== id)
      this.urgent = [id, ...this.urgent.filter((q) => q !== id)]
      if (!queued) {
        this.total++
        this.onProgress(this.done, this.total)
      }
    }
    // an opened note doesn't wait for a retry timer
    this.pump(true)
    return wait
  }

  /** An attachment's content, downloading it the first time it is shown. Null if there is no such attachment or the
   *  server doesn't have its content. */
  async loadAttachment(id: string): Promise<Uint8Array | null> {
    const a = this.library.attachment(id)
    const item = this.library.syncItem(id)
    if (!a) return null
    if (!item || item.bodyLoaded) return a.bytes
    if (item.blobSha === null) return null
    const sha = item.blobSha
    let content: Uint8Array
    try {
      content = await openBlob(this.api, this.crypto, this.session, id, sha, 'attachment')
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null
      throw e
    }
    // store it only if nothing changed meanwhile
    const now = this.library.syncItem(id)
    const meta = this.library.attachment(id)
    if (now && meta && now.blobSha === sha && !now.bodyLoaded && now.dirtySeq === null) {
      const { bytes: _bytes, origin: _origin, ...rest } = meta
      this.library.applyRemoteAttachment(rest, content, { version: now.serverVersion, extra: now.extra, metaVersion: now.metaVersion, blobSha: sha, ifDirtySeq: null })
    }
    return content
  }

  stop(): void {
    this.started = false
    this.generation++
    if (this.retryTimer !== null) this.timers.clear(this.retryTimer)
    this.retryTimer = null
    this.inFlight = new Set()
    this.urgent = []
    this.queue = []
    this.done = 0
    this.total = 0
    for (const id of [...this.waiters.keys()]) this.settle(id)
  }

  private unloaded() {
    const notes = [...this.library.notes({ kind: 'all' }), ...this.library.notes({ kind: 'trash' })]
    return notes.filter((n) => this.library.syncItem(n.id)?.bodyLoaded === false)
  }

  private settle(id: string): void {
    for (const resolve of this.waiters.get(id) ?? []) resolve()
    this.waiters.delete(id)
  }

  private finish(id: string): void {
    this.done++
    this.onProgress(this.done, this.total)
    if (this.urgent.length === 0 && this.queue.length === 0 && this.inFlight.size === 0) {
      this.done = 0
      this.total = 0
    }
    this.settle(id)
  }

  /** Starts downloads until PARALLEL are under way: opened notes first, then (unless a retry is waiting, or
   *  `urgentOnly`) the queue. */
  private pump(urgentOnly = false): void {
    while (this.inFlight.size < PARALLEL) {
      const waiting = this.retryTimer !== null
      const id = this.urgent.shift() ?? (this.started && !waiting && !urgentOnly ? this.queue.shift() : undefined)
      if (id === undefined) return
      this.inFlight.add(id)
      void this.run(id, this.generation)
    }
  }

  private async run(id: string, generation: number): Promise<void> {
    const outcome = await this.loadOne(id, generation).catch(() => 'done' as const)
    // stopped meanwhile: everything was let go, this download too
    if (generation !== this.generation) return
    this.inFlight.delete(id)
    if (outcome === 'retry') {
      // try again later: back in front, the opened note released so it doesn't hang; opened notes still go
      this.queue.unshift(id)
      this.settle(id)
      this.scheduleRetry()
      this.pump(true)
      return
    }
    if (outcome === 'again') this.urgent.unshift(id)
    else this.finish(id)
    this.pump()
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return
    this.retryTimer = this.timers.set(() => {
      this.retryTimer = null
      this.pump()
    }, this.backoff.next(this.random()))
  }

  /** 'done': loaded, or nothing to load (the body here wins, or the note is gone); 'again': a newer blob arrived
   *  meanwhile; 'retry': no answer, try later. A missing or unreadable blob is dropped until the next start(). */
  private async loadOne(id: string, generation: number): Promise<'done' | 'again' | 'retry'> {
    const item = this.library.syncItem(id)
    if (!item || item.type !== 'note' || item.bodyLoaded || item.blobSha === null) return 'done'
    const sha = item.blobSha
    let body: string
    try {
      body = bodyText(await openBlob(this.api, this.crypto, this.session, id, sha, 'noteBody'))
    } catch (e) {
      if (transient(e)) return 'retry'
      return 'done'
    }
    // stopped meanwhile (a lock, a sign-out): the library was let go; its text doesn't go back into it
    if (generation !== this.generation) return 'done'
    this.backoff.reset()
    if (this.library.setRemoteBody(id, body, sha)) return 'done'
    // refused: a body typed here or a delete here wins and nothing needs loading; a newer blob needs loading
    const now = this.library.syncItem(id)
    return now && !now.bodyLoaded && !now.bodyDirty && !now.deleted && now.blobSha !== null && now.blobSha !== sha ? 'again' : 'done'
  }
}
