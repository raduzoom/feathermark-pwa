// The sync status lines (ui-copy.md "Sync status lines"; SyncStatusText.swift) and Feather Cloud sizes and times
// (CloudFormat.swift), in the web's sentence case, with "this browser" for "this Mac". Type imports only: the app bar
// shows the line, and the demo's first load carries no sync code.
import type { CloudPlan } from '../core/sync/api.ts'
import type { SyncStatus } from '../core/sync/engine.ts'

export type StatusText = { title: string; detail: string | null; action: string | null }

const line = (title: string, detail: string | null = null, action: string | null = null): StatusText => ({ title, detail, action })

/** The status line. The trial line shows only where the server bills (`billing_enabled`). */
export function syncStatusText(o: { status: SyncStatus; plan: CloudPlan | null; billingEnabled: boolean; now: number }): StatusText {
  const { status, plan, now } = o
  if (plan?.state === 'read_only' || status.kind === 'readOnly') {
    return line('Read-only sync', 'Notes still arrive. Changes here stay on this browser.')
  }
  switch (status.kind) {
    case 'syncing':
      return line(`Syncing… ${status.done} of ${status.total}`)
    case 'loading':
      return line(`Loading notes… ${status.done} of ${status.total}`)
    case 'offline':
      return line('Offline', "Changes sync when you're back online.")
    case 'error':
      return line("Couldn't sync", status.message, 'Try again')
    case 'quotaFull':
      return line('Storage full', 'New changes stay on this browser.')
    case 'signedOut':
      return line('Sync with Feather Cloud')
    case 'idle':
      break
  }
  const ago = status.lastSynced === null ? null : cloudAgo(status.lastSynced, now)
  if (o.billingEnabled && plan?.state === 'trial' && plan.trialEndsAt) {
    const days = Math.max(0, Math.ceil((Date.parse(plan.trialEndsAt) - now) / 86_400_000))
    let detail = `${cloudSize(plan.usedBytes)} of ${cloudSize(plan.quotaBytes)}`
    if (ago) detail += ` · synced ${ago}`
    return line(`Trial: ${days} ${days === 1 ? 'day' : 'days'} left`, detail)
  }
  return line('Synced', ago)
}

/** The one line under the email in Settings › Sync. */
export const settingsLine = (t: StatusText): string => [t.title, t.detail].filter((s) => s !== null).join(' ')

/** Powers of 1,024; one decimal under 10 unless whole; "MB" or "GB". */
export function cloudSize(bytes: number): string {
  const gb = bytes / 1_073_741_824
  const [value, unit] = gb >= 1 ? [gb, 'GB'] : [bytes / 1_048_576, 'MB']
  const rounded = Math.round(value * 10) / 10
  if (value >= 10 || rounded === Math.round(rounded)) return `${Math.round(value)} ${unit}`
  return `${rounded.toFixed(1)} ${unit}`
}

export const cloudUsage = (used: number, quota: number): string => `${cloudSize(used)} of ${cloudSize(quota)} used`

const dayMonth = new Map<string, Intl.DateTimeFormat>()

/** "just now", "2 min ago", "3 h ago", "yesterday", "9 Nov". */
export function cloudAgo(ms: number, now: number, o: { timeZone?: string } = {}): string {
  const s = Math.max(0, (now - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  if (s < 172_800) return 'yesterday'
  const key = o.timeZone ?? ''
  let f = dayMonth.get(key)
  if (!f) dayMonth.set(key, (f = new Intl.DateTimeFormat('en-US', { timeZone: o.timeZone, day: 'numeric', month: 'short' })))
  const parts = f.formatToParts(ms)
  return `${parts.find((p) => p.type === 'day')?.value} ${parts.find((p) => p.type === 'month')?.value}`
}
