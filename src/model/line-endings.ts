// A <textarea> reports CRLF as LF. To keep a note's exact bytes (data-model.md "Markdown conventions": loading and
// saving without editing gives identical bytes), the editor shows the LF form and maps each edit back onto the
// original: everything outside the edited stretch keeps its original bytes, and new line breaks inside it follow
// the note's style (CRLF when every line break in the note is CRLF, LF otherwise).

export function textareaValue(body: string): string {
  return body.replace(/\r\n/g, '\n')
}

/** Index in `original` of position `shownIndex` in its LF form. */
function originalIndex(original: string, shownIndex: number): number {
  let shown = 0
  let i = 0
  while (shown < shownIndex && i < original.length) {
    i += original[i] === '\r' && original[i + 1] === '\n' ? 2 : 1
    shown++
  }
  return i
}

export function bodyFromTextarea(value: string, original: string): string {
  const before = textareaValue(original)
  if (value === before) return original
  let prefix = 0
  const max = Math.min(value.length, before.length)
  while (prefix < max && value[prefix] === before[prefix]) prefix++
  let suffix = 0
  while (suffix < max - prefix && value[value.length - 1 - suffix] === before[before.length - 1 - suffix]) suffix++
  const crlf = original.includes('\r\n') && !/(^|[^\r])\n/.test(original)
  const middle = value.slice(prefix, value.length - suffix)
  return (
    original.slice(0, originalIndex(original, prefix)) +
    (crlf ? middle.replace(/\n/g, '\r\n') : middle) +
    original.slice(originalIndex(original, before.length - suffix))
  )
}
