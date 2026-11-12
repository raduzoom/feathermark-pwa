// A clock tests move by hand. Starts at 2026-11-12T10:00:00.000Z.
export function fakeClock(start = Date.UTC(2026, 10, 12, 10, 0, 0)) {
  let now = start
  const clock = () => now
  return Object.assign(clock, {
    advance: (ms: number) => void (now += ms),
    set: (ms: number) => void (now = ms),
  })
}
export const DAY = 86_400_000
