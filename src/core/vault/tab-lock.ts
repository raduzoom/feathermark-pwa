// One tab at a time owns the kept library (web design "Logged in": "One tab at a time owns the kept library; a second
// tab says so"). Ownership is a Web Lock named "feathermark-vault", held for as long as the tab owns it; "Use it here"
// takes it with `steal`, and the tab it was taken from learns at once through onLost.
export const TAB_LOCK = 'feathermark-vault'

type Locks = Pick<LockManager, 'request'>

export class TabLock {
  private readonly locks: Locks | null
  private readonly name: string
  /** Ends the current hold (resolves the promise the lock callback returned); null while not held. */
  private releaseHold: (() => void) | null = null
  private readonly lost = new Set<() => void>()

  constructor(o: { locks?: Locks | null; name?: string } = {}) {
    this.locks = o.locks !== undefined ? o.locks : (globalThis.navigator?.locks ?? null)
    this.name = o.name ?? TAB_LOCK
  }

  /** Whether this tab owns the lock now. */
  get held(): boolean {
    return this.releaseHold !== null
  }

  /** Takes the lock: 'busy' when another tab holds it and `steal` is false. With `steal`, the other tab loses it. A
   *  browser without Web Locks has nothing to share it with: the tab owns it. */
  acquire(o: { steal: boolean }): Promise<'owner' | 'busy'> {
    if (this.releaseHold) return Promise.resolve('owner')
    const locks = this.locks
    if (!locks) {
      this.releaseHold = () => (this.releaseHold = null)
      return Promise.resolve('owner')
    }
    return new Promise((resolve, reject) => {
      let mine: (() => void) | null = null
      let granted = false
      const options: LockOptions = o.steal ? { steal: true } : { ifAvailable: true }
      locks
        .request(this.name, options, (lock) => {
          if (!lock) {
            resolve('busy')
            return undefined
          }
          granted = true
          return new Promise<void>((end) => {
            mine = () => {
              if (this.releaseHold === mine) this.releaseHold = null
              end()
            }
            this.releaseHold = mine
            resolve('owner')
          })
        })
        .catch((e: unknown) => {
          // another tab stole it: the request's promise rejects (AbortError) while this tab still thought it held it
          if (granted && mine !== null && this.releaseHold === mine) {
            this.releaseHold = null
            for (const cb of [...this.lost]) cb()
          } else if (!granted) reject(e)
        })
    })
  }

  /** Lets the lock go (signing out, Keep turned off). */
  release(): void {
    this.releaseHold?.()
  }

  /** Called when another tab takes the lock. Returns a function that stops listening. */
  onLost(cb: () => void): () => void {
    this.lost.add(cb)
    return () => void this.lost.delete(cb)
  }
}
