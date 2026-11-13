// The account menu in the app bar while unlocked (ui-copy.md "Web app" › "Accounts (Phase 20)"): "<email>",
// "Lock now", "Settings…", "Sign out".
import type { SessionModel } from '../../model/session.ts'
import { confirm, type DialogScreen } from '../Dialog.tsx'
import { MenuButton } from '../Menu.tsx'
import { openSettings } from './SettingsSync.tsx'

/** Signs out, asking first when changes haven't synced ("Sign out anyway? They'll be lost."). */
export async function signOutAsking(session: SessionModel, screen: DialogScreen = 'app'): Promise<void> {
  if ((await session.signOut()) === 'done') return
  confirm({
    screen,
    title: "Some changes haven't synced yet. Sign out anyway?",
    message: "They'll be lost.",
    button: 'Sign out',
    onConfirm: () => void session.signOut({ force: true }),
  })
}

export function AccountMenu({ session }: { session: SessionModel }) {
  const state = session.state.value
  if (state.kind !== 'unlocked') return null
  return (
    <MenuButton
      class="account-menu-trigger"
      label={state.email}
      ariaLabel={`Account, ${state.email}`}
      items={() =>
        session.tab.value === 'lost'
          ? // another tab owns the kept library: signing out or Keep from here would delete its copy under it
            [{ label: 'Lock now', onSelect: () => void session.lock('manual').catch(() => undefined) }]
          : [
              // a lock that can't seal leaves the notes as they were and shows why (the session puts it in the error toast)
              { label: 'Lock now', onSelect: () => void session.lock('manual').catch(() => undefined) },
              { label: 'Settings…', onSelect: openSettings },
              'separator',
              { label: 'Sign out', onSelect: () => void signOutAsking(session) },
            ]
      }
    />
  )
}
