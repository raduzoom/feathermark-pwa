// The editor (CodeMirror, as the textarea before it) shows every line break as LF. To keep a note's exact bytes
// (data-model.md "Markdown conventions": loading and saving without editing gives identical bytes), it shows the
// LF form and maps each edit back onto the original: everything outside the edited stretch keeps its original
// bytes (CRLF and lone CR included), and new line breaks inside it follow the note's style (CRLF when every line
// break in the note is CRLF, LF otherwise). The editor fixes the style when the note opens (`lineStyle`) and passes
// it in, so deleting a CRLF note's last line break and bringing it back keeps CRLF; a note with no line break yet
// takes the style of text pasted into it, so a pasted CRLF document stays CRLF, as a paste on the Mac does.

export type LineStyle = '\n' | '\r\n'

/** CRLF when every line break in `body` is CRLF (and there is one); LF otherwise, mixed and lone-CR notes included. */
export function lineStyle(body: string): LineStyle {
  return body.includes('\r\n') && !/(^|[^\r])\n/.test(body) && !/\r(?!\n)/.test(body) ? '\r\n' : '\n'
}

export function textareaValue(body: string): string {
  return body.replace(/\r\n?/g, '\n')
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

/** The note's text after an edit in the editor. `style` is the note's line-break style (the editor's, fixed when the
 *  note opened); without it, it is worked out from `original`. */
export function bodyFromTextarea(value: string, original: string, style: LineStyle = lineStyle(original)): string {
  // Fast path, and the common case: an LF note without CR is exactly the editor's text (no diff over a long note on
  // every keystroke); a CRLF-style note with no line break left takes CRLF for every break.
  if (original.indexOf('\r') < 0) {
    if (style === '\n') return value
    if (original.indexOf('\n') < 0) return value.replace(/\n/g, '\r\n')
  }
  const before = textareaValue(original)
  if (value === before) return original
  let prefix = 0
  const max = Math.min(value.length, before.length)
  while (prefix < max && value[prefix] === before[prefix]) prefix++
  let suffix = 0
  while (suffix < max - prefix && value[value.length - 1 - suffix] === before[before.length - 1 - suffix]) suffix++
  const crlf = style === '\r\n'
  const middle = value.slice(prefix, value.length - suffix)
  return (
    original.slice(0, originalIndex(original, prefix)) +
    (crlf ? middle.replace(/\n/g, '\r\n') : middle) +
    original.slice(originalIndex(original, before.length - suffix))
  )
}
