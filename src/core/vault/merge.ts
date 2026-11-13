// What a tab alone holds, joined into the kept copy it takes back ("Use it here" after its own handover didn't
// land): its notes changed here and in neither the copy nor the server, added to the copy's library as local changes,
// the way two devices' edits meet (sync-protocol.md "Conflict resolution": no text is lost; a note both sides changed
// keeps both, the other as "<title> (conflict, <device>, <d MMM HH:mm>)").
//
// A note whose body never loaded here carries its metadata only (title, pinned, notebook, tags): applied in place when
// the copy has it unchanged since, otherwise its title goes to the copy's sync-conflicts list (Settings › Sync), so
// the text typed here is still there. Its body stays the body loader's to fetch; none is made up.
//
// Notes only: a note whose text equals the copy's is skipped; one the copy has unchanged since (not dirty there, same
// server version) takes this tab's text in place; one the copy changed too, or doesn't have, comes in as a new note
// (a conflict copy when the copy still has the original). Attachments a carried note links to and the copy lacks come
// along. Deletions, moves to the Trash, notebooks and tags made here are not carried: nothing is lost by that, a note
// at worst comes back.
import type { Clock } from '../clock.ts'
import { attachmentRefs } from '../library/links.ts'
import type { Library } from '../library/library.ts'
import type { Note } from '../library/types.ts'
import { conflictTitle } from '../sync/conflict.ts'

/** Joins `from`'s unsynced note changes into `into`. Returns how many notes changed in `into`. */
export function mergeUnsynced(into: Library, from: Library, device: string, clock: Clock): number {
  let changed = 0
  for (const s of from.dirtyItems()) {
    if (s.type !== 'note' || s.deleted) continue
    const n = from.note(s.id)
    if (!n || n.origin === 'sample') continue
    const there = into.note(s.id)
    if (!s.bodyLoaded) {
      if (mergeMetadata(into, n, s.serverVersion, device, clock)) changed++
      continue
    }
    if (there && there.title === n.title && there.body === n.body) continue
    let body = n.body
    for (const ref of attachmentRefs(n.body)) {
      if (into.attachment(ref.id)) continue
      const a = from.attachment(ref.id)
      if (!a) continue
      const copy = into.addAttachment({ bytes: a.bytes, filename: a.filename, mime: a.mime, sha256: a.sha256 })
      body = body.split(ref.id).join(copy.id)
    }
    const theirs = there ? into.syncItem(s.id) : null
    if (there && theirs && theirs.dirtySeq === null && theirs.serverVersion === s.serverVersion) {
      into.updateNote(s.id, { title: n.title, body })
    } else {
      const title = there ? conflictTitle(n.title, device, new Date(clock())) : n.title
      const notebookId = n.notebookId && into.notebooks().some((b) => b.id === n.notebookId) ? n.notebookId : null
      const tagIds = n.tagIds.filter((t) => into.tags().some((x) => x.id === t))
      into.createNote({ title, body, notebookId, tagIds, created: n.created, modified: n.modified })
    }
    changed++
  }
  return changed
}

/** A note whose body this tab never had: its metadata only. Returns whether `into` changed. */
function mergeMetadata(into: Library, n: Note, serverVersion: number, device: string, clock: Clock): boolean {
  const there = into.note(n.id)
  const theirs = there ? into.syncItem(n.id) : null
  const same =
    there !== undefined && there.title === n.title && there.pinned === n.pinned && there.notebookId === n.notebookId && there.tagIds.join() === n.tagIds.join()
  if (same) return false
  if (there && theirs && theirs.dirtySeq === null && theirs.serverVersion === serverVersion) {
    if (there.title !== n.title) into.updateNote(n.id, { title: n.title })
    if (there.pinned !== n.pinned) into.setPinned(n.id, n.pinned)
    if (there.notebookId !== n.notebookId && (n.notebookId === null || into.notebooks().some((b) => b.id === n.notebookId))) into.moveNote(n.id, n.notebookId)
    const tagIds = n.tagIds.filter((t) => into.tags().some((x) => x.id === t))
    if (tagIds.join() !== there.tagIds.join()) into.setTags(n.id, tagIds)
    return true
  }
  // changed (or deleted) in the copy too: the title typed here is kept where people look for names that lost
  if (there?.title === n.title) return false
  into.recordSyncConflict({ itemId: n.id, type: 'note', lostName: n.title, device, at: clock() })
  return true
}
