// Caps how deeply Markdown can nest before it reaches the parser (NestingLimit.swift). Every opener beyond
// NESTING_DEPTH levels is replaced by "x", an ASCII-for-ASCII swap, so offsets are unchanged and ranges still
// point into the real text; the extra levels read as plain characters. Ordinary Markdown comes back unchanged
// (the same string). The Swift code scans UTF-8 bytes; every character it looks at is ASCII, so scanning UTF-16
// code units gives the same result.

export const NESTING_DEPTH = 32

const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d

export function nestingLimit(text: string): string {
  const n = text.length
  // Positions to replace with "x"; almost always none, so nothing is copied.
  const swap: number[] = []

  /** Skips a line's container markers (`>` and list markers, each after up to three spaces), recording those
   *  beyond the depth; returns the index after the prefix. */
  const containerPrefix = (start: number): number => {
    let i = start
    let level = 0
    for (;;) {
      let k = i
      let spaces = 0
      while (k < n && text.charCodeAt(k) === 0x20 && spaces < 3) {
        k++
        spaces++
      }
      if (k >= n) return k
      let end: number
      const c = text.charCodeAt(k)
      if (c === 0x3e) end = k + 1
      else if (c === 0x2d || c === 0x2b || c === 0x2a) {
        end = k + 1
        const a = text.charCodeAt(end)
        if (!(end < n && (a === 0x20 || a === 0x09))) return i
      } else if (c >= 0x30 && c <= 0x39) {
        let d = k
        while (d < n && d - k < 9 && text.charCodeAt(d) >= 0x30 && text.charCodeAt(d) <= 0x39) d++
        const p = text.charCodeAt(d)
        const q = text.charCodeAt(d + 1)
        if (!(d < n && (p === 0x2e || p === 0x29) && d + 1 < n && (q === 0x20 || q === 0x09))) return i
        end = d + 1
      } else return i
      level++
      if (level > NESTING_DEPTH) {
        swap.push(k) // the rest of the line is now paragraph text
        return k + 1
      }
      const e = text.charCodeAt(end)
      i = end < n && (e === 0x20 || e === 0x09) ? end + 1 : end
    }
  }

  let bracket = 0
  let star = 0
  let under = 0
  let i = 0
  let lineStart = true
  while (i < n) {
    if (lineStart) {
      lineStart = false
      let j = i
      let c = text.charCodeAt(j)
      while (j < n && (c === 0x20 || c === 0x09)) c = text.charCodeAt(++j)
      if (j === n || c === 0x0a || c === 0x0d) {
        bracket = 0
        star = 0
        under = 0
      }
      i = containerPrefix(i)
      continue
    }
    const c = text.charCodeAt(i)
    switch (c) {
      case 0x0d:
        i += i + 1 < n && text.charCodeAt(i + 1) === 0x0a ? 2 : 1
        lineStart = true
        break
      case 0x0a:
        i++
        lineStart = true
        break
      case 0x5c: {
        const d = text.charCodeAt(i + 1)
        i += i + 1 < n && d !== 0x0a && d !== 0x0d ? 2 : 1
        break
      }
      case 0x5b:
        bracket++
        if (bracket > NESTING_DEPTH) swap.push(i)
        i++
        break
      case 0x5d:
        if (bracket > 0) bracket--
        i++
        break
      case 0x2a:
      case 0x5f: {
        let r = i
        while (r < n && text.charCodeAt(r) === c) r++
        const before = i > 0 ? text.charCodeAt(i - 1) : 0x20
        const after = r < n ? text.charCodeAt(r) : 0x20
        const opens = !isSpace(after)
        const closes = !isSpace(before)
        let count = c === 0x2a ? star : under
        if (opens && !closes) {
          for (let p = i; p < r; p++) {
            count++
            if (count > NESTING_DEPTH) swap.push(p)
          }
        } else if (closes && !opens) count = Math.max(0, count - (r - i))
        if (c === 0x2a) star = count
        else under = count
        i = r
        break
      }
      default:
        i++
    }
  }
  if (swap.length === 0) return text
  let out = ''
  let at = 0
  for (const p of swap) {
    out += text.slice(at, p) + 'x'
    at = p + 1
  }
  return out + text.slice(at)
}
