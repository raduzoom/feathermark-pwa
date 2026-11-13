// The item codec (data-model.md "Encrypted metadata"; Swift: ItemCodec.swift). It builds and reads the metadata JSON
// (`v: 1`) of notes, notebooks, tags and attachments; the crypto worker seals and opens the envelopes. Unknown fields
// round-trip as `extra`. Note bodies and attachment bytes are blobs, handled by the sync engine.
import type { Attachment } from '../library/attachments.ts'
import type { Note, Notebook, Tag } from '../library/types.ts'

export type ItemType = 'note' | 'notebook' | 'tag' | 'attachment'
export type AttachmentMeta = Omit<Attachment, 'bytes' | 'origin'>
export type Extra = Record<string, unknown> | null

type Info = { extra: Extra; metaVersion: number }
/** What `readMeta` returns: the item without its blob (a note's body is '', an attachment's content comes from its blob). */
export type DecodedMeta =
  | ({ type: 'note'; note: Note } & Info)
  | ({ type: 'notebook'; notebook: Notebook } & Info)
  | ({ type: 'tag'; tag: Tag } & Info)
  | ({ type: 'attachment'; attachment: AttachmentMeta } & Info)
export type DecodedItem =
  | ({ type: 'note'; note: Note } & Info)
  | ({ type: 'notebook'; notebook: Notebook } & Info)
  | ({ type: 'tag'; tag: Tag } & Info)
  | ({ type: 'attachment'; attachment: AttachmentMeta; content: Uint8Array | null } & Info)

/** Encrypted metadata is at most 64 KiB, counted after encryption (data-model.md). */
export const MAX_META = 65_536
/** A metadata envelope is its plaintext plus a 34-byte header and a 16-byte tag (one chunk). */
const ENVELOPE_OVERHEAD = 34 + 16

export type CodecErrorKind = 'metadataTooLarge' | 'malformedMetadata'
export class CodecError extends Error {
  override name = 'CodecError'
  constructor(readonly kind: CodecErrorKind) {
    super(kind)
  }
}

const KNOWN: Record<ItemType, ReadonlySet<string>> = {
  note: new Set(['v', 'title', 'notebook_id', 'tag_ids', 'pinned', 'created', 'modified', 'trashed_at']),
  notebook: new Set(['v', 'name', 'parent_id', 'created', 'modified']),
  tag: new Set(['v', 'name', 'created', 'modified']),
  attachment: new Set(['v', 'filename', 'mime', 'size', 'sha256', 'created']),
}
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value).sort()) out[k] = sortKeys((value as Record<string, unknown>)[k])
    return out
  }
  return value
}

function fieldsOf(item: Note | Notebook | Tag | AttachmentMeta, type: ItemType): Record<string, unknown> {
  switch (type) {
    case 'note': {
      const n = item as Note
      return { v: 1, title: n.title, notebook_id: n.notebookId, tag_ids: [...n.tagIds].sort(), pinned: n.pinned, created: n.created, modified: n.modified, trashed_at: n.trashedAt }
    }
    case 'notebook': {
      const n = item as Notebook
      return { v: 1, name: n.name, parent_id: n.parentId, created: n.created, modified: n.modified }
    }
    case 'tag': {
      const t = item as Tag
      return { v: 1, name: t.name, created: t.created, modified: t.modified }
    }
    case 'attachment': {
      const a = item as AttachmentMeta
      return { v: 1, filename: a.filename, mime: a.mime, size: a.size, sha256: a.sha256, created: a.created }
    }
  }
}

/** The metadata JSON for `item`: unknown fields from `extra`, then the known ones (they win); keys sorted, compact, UTF-8.
 *  `limit: false` skips the server's 64 KiB limit (the vault keeps a title too long to sync, so it isn't lost). */
export function metaJson(item: Note | Notebook | Tag | AttachmentMeta, type: ItemType, extra: Extra, o: { limit?: boolean } = {}): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(sortKeys({ ...(extra ?? {}), ...fieldsOf(item, type) })))
  if ((o.limit ?? true) && bytes.length + ENVELOPE_OVERHEAD > MAX_META) throw new CodecError('metadataTooLarge')
  return bytes
}

/** A JSON number as an integer; a boolean, string or null is not one (ItemCodec.int). */
function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}
const str = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback)
const ulidOrNull = (value: unknown): string | null => (typeof value === 'string' && ULID.test(value) ? value : null)

/** Reads decrypted metadata. A `v` above 1 still reads: the caller shows the item read-only and never rewrites it.
 *  `limit: false` reads the vault's own metadata, which may be over the server's limit. */
export function readMeta(type: ItemType, id: string, plain: Uint8Array, opts: { limit?: boolean } = {}): DecodedMeta {
  if ((opts.limit ?? true) && plain.length + ENVELOPE_OVERHEAD > MAX_META) throw new CodecError('metadataTooLarge')
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain))
  } catch {
    throw new CodecError('malformedMetadata')
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new CodecError('malformedMetadata')
  const o = json as Record<string, unknown>
  const metaVersion = int(o.v)
  if (metaVersion === null) throw new CodecError('malformedMetadata')
  const rest = Object.fromEntries(Object.entries(o).filter(([k]) => !KNOWN[type].has(k)))
  const extra: Extra = Object.keys(rest).length > 0 ? (sortKeys(rest) as Record<string, unknown>) : null
  const created = int(o.created) ?? 0
  const modified = int(o.modified) ?? 0
  // items from the server belong to the user's library
  const origin = 'user' as const
  switch (type) {
    case 'note': {
      const tagIds = Array.isArray(o.tag_ids) && o.tag_ids.every((t) => typeof t === 'string') ? (o.tag_ids as string[]).filter((t) => ULID.test(t)) : []
      const note: Note = { id, title: str(o.title, ''), body: '', notebookId: ulidOrNull(o.notebook_id), tagIds, pinned: o.pinned === true, created, modified, trashedAt: int(o.trashed_at), origin }
      return { type, note, extra, metaVersion }
    }
    case 'notebook':
      return { type, notebook: { id, name: str(o.name, ''), parentId: ulidOrNull(o.parent_id), created, modified, origin }, extra, metaVersion }
    case 'tag':
      return { type, tag: { id, name: str(o.name, ''), created, modified, origin }, extra, metaVersion }
    case 'attachment':
      // size falls back to 0 here: the content length is only known once the blob is opened
      return { type, attachment: { id, filename: str(o.filename, 'attachment'), mime: str(o.mime, 'application/octet-stream'), size: int(o.size) ?? 0, sha256: str(o.sha256, ''), created }, extra, metaVersion }
  }
}
