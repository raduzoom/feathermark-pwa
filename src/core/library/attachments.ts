// Attachments held in memory (data-model.md "Attachment"): the file's bytes with their metadata. A note uses one by
// referencing `feather://attachment/<id>` in its body ("Attachment references").
import type { Origin } from './types.ts'

export type Attachment = {
  id: string
  filename: string
  mime: string
  size: number
  sha256: string
  created: number
  origin: Origin
  bytes: Uint8Array
}

/** The demo's limit per file: it keeps a dropped video from crashing the tab, and nothing is uploaded anyway. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const ATTACHMENT_URL_PREFIX = 'feather://attachment/'

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The Markdown that references `a` (AppModel.swift addAttachments): `![name](…)` for an image, `[name](…)`
 *  otherwise, with `\`, `[` and `]` in the name escaped. */
export function attachmentSnippet(a: { id: string; filename: string; mime: string }): string {
  const name = a.filename.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
  return `${a.mime.toLowerCase().startsWith('image/') ? '!' : ''}[${name}](${ATTACHMENT_URL_PREFIX}${a.id})`
}

/** The attachment id in a `feather://attachment/<id>` URL, or null. */
export function attachmentId(url: string): string | null {
  if (!url.toLowerCase().startsWith(ATTACHMENT_URL_PREFIX)) return null
  const id = url.slice(ATTACHMENT_URL_PREFIX.length)
  return /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id) ? id.toUpperCase() : null
}
