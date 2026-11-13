// Language-agnostic colouring for code blocks: strings, comments and a fixed keyword list (CodeHighlighter.swift).

export type CodeToken = { from: number; to: number; kind: 'keyword' | 'string' | 'comment' }

const HASH_COMMENTS = new Set(['python', 'py', 'ruby', 'rb', 'shell', 'sh', 'bash', 'zsh', 'yaml', 'yml', 'toml'])
const KEYWORDS = new Set([
  'let', 'var', 'func', 'fn', 'def', 'class', 'struct', 'enum', 'protocol', 'interface', 'import', 'from', 'return',
  'if', 'else', 'elif', 'for', 'while', 'in', 'switch', 'case', 'break', 'continue', 'true', 'false', 'nil', 'null',
  'None', 'True', 'False', 'const', 'public', 'private', 'static', 'async', 'await', 'try', 'catch', 'throw', 'new', 'self', 'this',
])

const isWord = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f

function lineEnd(s: string, i: number): number {
  let j = i
  while (j < s.length && s.charCodeAt(j) !== 0x0a && s.charCodeAt(j) !== 0x0d) j++
  return j
}

/** Tokens in `code`, offsets relative to it. */
export function codeTokens(code: string, language: string | null): CodeToken[] {
  const out: CodeToken[] = []
  const hash = language !== null && HASH_COMMENTS.has(language.toLowerCase())
  let i = 0
  while (i < code.length) {
    const c = code.charCodeAt(i)
    if (c === 0x2f && code.charCodeAt(i + 1) === 0x2f) {
      const end = lineEnd(code, i)
      out.push({ from: i, to: end, kind: 'comment' })
      i = end
    } else if (c === 0x23 && hash) {
      const end = lineEnd(code, i)
      out.push({ from: i, to: end, kind: 'comment' })
      i = end
    } else if (c === 0x2f && code.charCodeAt(i + 1) === 0x2a) {
      const close = code.indexOf('*/', i + 2)
      const end = close < 0 ? code.length : close + 2
      out.push({ from: i, to: end, kind: 'comment' })
      i = end
    } else if (c === 0x22 || c === 0x27 || c === 0x60) {
      let j = i + 1
      while (j < code.length && code.charCodeAt(j) !== c && code.charCodeAt(j) !== 0x0a) {
        if (code.charCodeAt(j) === 0x5c) j++
        j++
      }
      const end = Math.min(code.length, j + 1)
      out.push({ from: i, to: end, kind: 'string' })
      i = end
    } else if (isWord(c)) {
      let j = i
      while (j < code.length && isWord(code.charCodeAt(j))) j++
      if (KEYWORDS.has(code.slice(i, j))) out.push({ from: i, to: j, kind: 'keyword' })
      i = j
    } else i++
  }
  return out
}
