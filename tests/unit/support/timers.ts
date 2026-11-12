// Timers a test runs by hand: tick(ms) fires everything due, in order.
export function fakeTimers(clock?: { advance: (ms: number) => void }) {
  let now = 0
  let next = 1
  const pending = new Map<number, { at: number; fn: () => void }>()
  return {
    set: (fn: () => void, ms: number) => {
      const id = next++
      pending.set(id, { at: now + ms, fn })
      return id
    },
    clear: (id: unknown) => void pending.delete(id as number),
    tick(ms: number) {
      const end = now + ms
      for (;;) {
        const due = [...pending].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        clock?.advance(due[1].at - now)
        now = due[1].at
        pending.delete(due[0])
        due[1].fn()
      }
      clock?.advance(end - now)
      now = end
    },
    get count() {
      return pending.size
    },
  }
}
