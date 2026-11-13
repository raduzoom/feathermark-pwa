// Retry delays after a failed sync: 2 s doubling to 5 min, ±20% jitter (sync-protocol.md "Errors and retries";
// Swift: Backoff.swift).
export class Backoff {
  private attempt = 0

  /** The next delay in milliseconds; `random` in 0…1 picks the jitter. */
  next(random: number): number {
    const base = Math.min(300, 2 * 2 ** Math.min(this.attempt, 20))
    this.attempt++
    return Math.round(base * (0.8 + 0.4 * random) * 1000)
  }

  reset(): void {
    this.attempt = 0
  }
}
