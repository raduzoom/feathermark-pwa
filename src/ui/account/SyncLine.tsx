// The sync status line in the app bar while unlocked (ui-copy.md "Sync status lines"; SyncStatusText.swift): "Synced
// 2 min ago", "Syncing… 12 of 40", "Loading notes… 120 of 400", "Offline", "Couldn't sync" with "Try again".
import { useEffect, useState } from 'preact/hooks'
import type { SessionModel } from '../../model/session.ts'
import { syncStatusText } from '../../model/sync-text.ts'

export function SyncLine({ session }: { session: SessionModel }) {
  // "2 min ago" moves on by itself
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const account = session.cloudAccount.value
  const text = syncStatusText({ status: session.status.value, plan: account?.plan ?? null, billingEnabled: account?.billingEnabled ?? false, now })
  return (
    <p class="sync-line">
      <span class="sync-line-title">{text.title}</span>
      {text.detail && <span class="sync-line-detail">{text.detail}</span>}
      {text.action && (
        <button type="button" class="link-button" onClick={() => session.syncNow()}>
          {text.action}
        </button>
      )}
    </p>
  )
}
