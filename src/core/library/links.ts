// Attachment links in a note's body (data-model.md "Attachment references"): link and image destinations outside
// code spans and code blocks, read with the editor's parser so the web reads them as the editor shows them.
import { parseDocument } from '../../editor/markdown/document.ts'
import { attachmentId } from './attachments.ts'

export type AttachmentRef = { id: string; url: { from: number; to: number } }

/** Every `feather://attachment/<id>` destination in `body`, in order, with the range of the URL itself. */
export function attachmentRefs(body: string): AttachmentRef[] {
  const out: AttachmentRef[] = []
  const add = (url: string, end: number) => {
    const id = attachmentId(url)
    if (!id) return
    // the destination ends just before the closing ")" (or a title); find it from the link's end
    const at = body.lastIndexOf(url, end)
    if (at >= 0) out.push({ id, url: { from: at, to: at + url.length } })
  }
  for (const b of parseDocument(body).blocks) {
    if (b.kind === 'image') add(b.url, b.source.to)
    for (const i of b.inlines) if (typeof i.kind === 'object') add(i.kind.link, i.range.to)
  }
  return out.sort((a, b) => a.url.from - b.url.from)
}

/** `body` with each attachment destination whose id is in `paths` replaced by that path. */
export function rewriteAttachmentLinks(body: string, paths: Map<string, string>): string {
  let out = ''
  let at = 0
  for (const r of attachmentRefs(body)) {
    const path = paths.get(r.id)
    if (path === undefined) continue
    out += body.slice(at, r.url.from) + path
    at = r.url.to
  }
  return out + body.slice(at)
}

// RFC 3986 path characters Foundation's urlPathAllowed keeps, minus "/?#[]()" (Library+Export.swift percentEncode).
const PATH_ALLOWED = /[A-Za-z0-9\-._~!$&'*+,;=:@]/

/** One path component, percent-encoded as the Apple export writes it. */
export function percentEncodePathComponent(s: string): string {
  let out = ''
  for (const ch of s) {
    if (PATH_ALLOWED.test(ch)) out += ch
    else for (const b of new TextEncoder().encode(ch)) out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

/** Splits `receipt.pdf` into (`receipt`, `.pdf`); a leading dot is not an extension (FileNames.swift). */
export function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? [name, ''] : [name.slice(0, dot), name.slice(dot)]
}

/** `base + ext`, or `base (2) + ext`, … whichever is not taken yet (compared as APFS does: case and Unicode
 *  normalisation ignored); records the result. */
export function uniqueName(base: string, ext: string, taken: Set<string>): string {
  const key = (s: string) => s.normalize('NFC').toLowerCase()
  let candidate = base + ext
  for (let n = 2; taken.has(key(candidate)); n++) candidate = `${base} (${n})${ext}`
  taken.add(key(candidate))
  return candidate
}
