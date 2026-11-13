// A Web Locks manager for tests, shared by the "tabs" of one test: exclusive locks, `ifAvailable` and `steal` as the
// spec has them (a stolen holder's request promise rejects with AbortError; its callback's promise is left alone).
type Holder = { reject: (e: unknown) => void }
type Waiter = { name: string; run: () => void }

export function fakeLocks(): Pick<LockManager, 'request'> {
  const held = new Map<string, Holder>()
  const queue: Waiter[] = []

  const next = (name: string) => {
    const i = queue.findIndex((w) => w.name === name)
    if (i >= 0) queue.splice(i, 1)[0]!.run()
  }

  function request(name: string, a: unknown, b?: unknown): Promise<unknown> {
    const options = (typeof a === 'function' ? {} : a) as LockOptions
    const cb = (typeof a === 'function' ? a : b) as (lock: Lock | null) => unknown
    return new Promise((resolve, reject) => {
      const grant = () => {
        const me: Holder = { reject }
        held.set(name, me)
        Promise.resolve(cb({ name, mode: 'exclusive' } as Lock)).then(
          (v) => {
            if (held.get(name) === me) {
              held.delete(name)
              next(name)
            }
            resolve(v)
          },
          (e) => {
            if (held.get(name) === me) {
              held.delete(name)
              next(name)
            }
            reject(e)
          },
        )
      }
      const current = held.get(name)
      if (!current) return grant()
      if (options.steal) {
        held.delete(name)
        current.reject(new DOMException('stolen', 'AbortError'))
        return grant()
      }
      if (options.ifAvailable) return void Promise.resolve(cb(null)).then(resolve, reject)
      queue.push({ name, run: grant })
    })
  }
  return { request: request as LockManager['request'] }
}

/** BroadcastChannel endpoints for the tabs of one test: a message reaches every other open endpoint, a task later. */
export function fakeChannels() {
  const open = new Set<FakeChannel>()
  class FakeChannel extends EventTarget {
    constructor() {
      super()
      open.add(this)
    }
    postMessage(data: unknown): void {
      for (const c of open) if (c !== this) setImmediate(() => open.has(c) && c.dispatchEvent(new MessageEvent('message', { data })))
    }
    close(): void {
      open.delete(this)
    }
  }
  return () => new FakeChannel() as unknown as BroadcastChannel
}
