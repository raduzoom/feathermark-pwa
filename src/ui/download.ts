import { noteDownload } from '../core/library/export.ts'
import { zipStored } from '../core/zip.ts'
import type { AppModel } from '../model/app-model.ts'

/** Saves the open note as .md, or as a .zip with its attachments (the toolbar's More menu and quick actions). Its
 *  callers offer it only while the note's body is in (`openNoteLoading` false): else it would save an empty file. */
export function downloadOpenNote(model: AppModel): void {
  model.flush()
  const n = model.openNote.value
  if (!n) return
  const tagNames = model.tags.value.filter((t) => n.tagIds.includes(t.id)).map((t) => t.name)
  const d = noteDownload(n, tagNames, (body) => model.attachmentsOf(body))
  if (d.kind === 'md') saveText(d.fileName, d.text)
  else saveBytes(d.fileName, zipStored(d.entries, n.modified), 'application/zip')
}

/** Saves text as a file through a temporary object URL; nothing leaves the browser. */
export function saveText(fileName: string, text: string): void {
  saveBlob(fileName, new Blob([text], { type: 'text/markdown;charset=utf-8' }))
}

/** Saves bytes as a file (a zip of a note and its attachments). */
export function saveBytes(fileName: string, bytes: Uint8Array, type: string): void {
  saveBlob(fileName, new Blob([bytes as Uint8Array<ArrayBuffer>], { type }))
}

function saveBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.hidden = true
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Saves a file the app already holds as an object URL (an attachment); the URL stays the caller's. */
export function saveObjectUrl(fileName: string, url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.hidden = true
  document.body.append(a)
  a.click()
  a.remove()
}
