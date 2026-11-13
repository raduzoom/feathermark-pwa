// What to do with an item that changed here and on the server (sync-protocol.md "Conflict resolution"; Swift:
// ConflictRules.swift). Pure functions; the engine applies them.
import type { Note } from '../library/types.ts'

export type NoteResolution =
  /** Take the server's version; nothing local is worth keeping (a local delete lost to an edit). */
  | { kind: 'keepServer' }
  /** Title or body differ: take the server's, save the local one as a conflict copy. */
  | { kind: 'copyLocal' }
  /** Only metadata differs: push this merge on top of the server's version. */
  | { kind: 'mergeMeta'; note: Note }
  /** The server deleted it while it was edited here: push the local version again (it comes back everywhere). */
  | { kind: 'repushLocal' }

export function resolveNote(local: Note, server: Note, o: { localDeleted: boolean; serverDeleted: boolean }): NoteResolution {
  if (o.localDeleted) return { kind: 'keepServer' }
  if (o.serverDeleted) return { kind: 'repushLocal' }
  if (local.title !== server.title || local.body !== server.body) return { kind: 'copyLocal' }
  return { kind: 'mergeMeta', note: { ...server, tagIds: [...new Set([...local.tagIds, ...server.tagIds])].sort() } }
}

/** `<title> (conflict, <device>, <d MMM HH:mm>)`, 24-hour, in this device's time zone (or `timeZone`). */
export function conflictTitle(title: string, device: string, at: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return `${title} (conflict, ${device}, ${part('day')} ${part('month')} ${part('hour')}:${part('minute')})`
}

/** Notebook and tag renames: the server's name wins; `lost` is the local name that lost, if it differed. */
export function resolveName(localName: string, serverName: string): { lost: string | null } {
  return { lost: localName === serverName ? null : localName }
}

/** The server's parent, unless putting the notebook there would place it inside its own sub-notebook; then it goes to
 *  the top level (and the caller pushes that). `parents` maps each notebook here to its parent. */
export function resolveParent(serverParent: string | null, notebookId: string, parents: ReadonlyMap<string, string | null>): string | null {
  let current = serverParent
  const seen = new Set<string>()
  while (current !== null) {
    if (current === notebookId || seen.has(current)) return null
    seen.add(current)
    current = parents.get(current) ?? null
  }
  return serverParent
}
