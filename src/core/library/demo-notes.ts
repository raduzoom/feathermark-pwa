// Bringing demo notes along when someone logs in or creates an account (web design "The demo"): the notes the visitor
// wrote during this visit are offered ("Add the 2 notes you wrote here to your account?"), with the notebooks, tags and
// attachments they made. Sample notes, notebooks, tags and attachments never go to an account, edited or not: a note
// filed in a sample notebook lands at the top level, a sample tag on it is dropped, and so is a link's sample picture.
import type { Library } from './library.ts'
import { tagKey } from './names.ts'

/** The ids of the notes worth offering: written here (origin 'user'), not empty, not in the Trash. */
export function demoNotesToOffer(demo: Library): string[] {
  return demo
    .notes({ kind: 'all' })
    .filter((s) => s.origin === 'user')
    .map((s) => demo.note(s.id)!)
    .filter((n) => n.title.trim() !== '' || n.body.trim() !== '')
    .map((n) => n.id)
}

/** Copies the notes `ids` from the demo into the account's library as new local changes; returns how many. A tag goes
 *  to the account's tag of the same name if it has one. */
export function carryDemoNotes(demo: Library, account: Library, ids: string[]): number {
  const demoNotebooks = new Map(demo.notebooks().map((n) => [n.id, n]))
  const demoTags = new Map(demo.tags().map((t) => [t.id, t]))
  const notebookIds = new Map<string, string>()
  const tagIds = new Map<string, string>()

  /** The account's copy of a demo notebook the visitor made (and of its own ancestors); null for a sample one. */
  const notebook = (id: string | null): string | null => {
    const nb = id === null ? undefined : demoNotebooks.get(id)
    if (!nb || nb.origin !== 'user') return null
    const known = notebookIds.get(nb.id)
    if (known) return known
    const made = account.createNotebook(nb.name, notebook(nb.parentId))
    notebookIds.set(nb.id, made.id)
    return made.id
  }
  const tag = (id: string): string | null => {
    const t = demoTags.get(id)
    if (!t || t.origin !== 'user') return null
    const known = tagIds.get(id)
    if (known) return known
    const same = account.tags().find((x) => tagKey(x.name) === tagKey(t.name))
    const made = same ?? account.createTag(t.name)
    tagIds.set(id, made.id)
    return made.id
  }

  let carried = 0
  for (const id of ids) {
    const n = demo.note(id)
    if (!n || n.origin !== 'user') continue
    for (const a of demo.attachmentsOf(n.body)) {
      if (a.origin !== 'user' || account.attachment(a.id)) continue
      account.addAttachment({ id: a.id, created: a.created, bytes: a.bytes, filename: a.filename, mime: a.mime, sha256: a.sha256 })
    }
    const copy = account.createNote({
      title: n.title,
      body: n.body,
      notebookId: notebook(n.notebookId),
      tagIds: n.tagIds.flatMap((t) => tag(t) ?? []),
      created: n.created,
      modified: n.modified,
    })
    if (n.pinned) account.setPinned(copy.id, true)
    carried++
  }
  return carried
}
