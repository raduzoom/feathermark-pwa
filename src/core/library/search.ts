// Search with FTS5's rules (data-model.md "Search"): unicode61 remove_diacritics 2 tokens, prefix AND query, bm25(5, 1).
import type { Note } from './types.ts'

// Letters, digits, private use, and the combining marks U+0300–U+0331 that FTS5 keeps inside a token.
const TOKEN = /[\p{L}\p{N}\p{Co}\u0300-\u0331]+/gu
const K1 = 1.2
const B = 0.75
const TITLE_WEIGHT = 5
const BODY_WEIGHT = 1
const SNIPPET_TOKENS = 12

/**
 * FTS5 `unicode61 remove_diacritics 2`, letter by letter: combining marks U+0300–U+0331 are dropped wherever they
 * are; a precomposed Latin letter with diacritics becomes its base letter; everything else is case-folded one
 * letter at a time (Σ and ς both become σ, ſ becomes s).
 */
export function fold(token: string): string {
  let out = ''
  for (const ch of token) {
    const cp = ch.codePointAt(0)!
    if (cp >= 0x300 && cp <= 0x331) continue
    // Case folding, as FTS5 does it: lowercase, plus final sigma ς → σ and long s ſ → s.
    const lower = ch === 'ς' ? 'σ' : ch === 'ſ' ? 's' : ch.toLowerCase()
    const parts = lower.normalize('NFD')
    const base = parts.codePointAt(0)!
    const rest = parts.slice(String.fromCodePoint(base).length)
    out += rest !== '' && /\p{Script=Latin}/u.test(String.fromCodePoint(base)) && /^[\u0300-\u036f]+$/.test(rest) ? String.fromCodePoint(base) : lower
  }
  return out
}

export function tokenize(text: string): Array<{ token: string; start: number; end: number }> {
  const out: Array<{ token: string; start: number; end: number }> = []
  for (const m of text.matchAll(TOKEN)) {
    const token = fold(m[0])
    if (token !== '') out.push({ token, start: m.index, end: m.index + m[0].length })
  }
  return out
}

/** Folded tokens of one query word; the last one matches as a prefix. */
export type QueryWord = string[]

export function buildQuery(text: string): QueryWord[] | null {
  const words = text
    .replace(/\p{Cc}/gu, ' ')
    .split(/\s+/u)
    .filter((w) => /[\p{L}\p{N}]/u.test(w))
    .map((w) => tokenize(w).map((t) => t.token))
    .filter((w) => w.length > 0)
  return words.length ? words : null
}

type Indexed = { title: string[]; body: string[]; length: number }
type Freq = { t: number; b: number }

export class SearchIndex {
  private docs = new Map<string, Indexed>()
  private postings = new Map<string, Map<string, Freq>>()
  private sortedTokens: string[] | null = []
  private totalLength = 0

  upsert(note: Note): void {
    this.remove(note.id)
    const title = tokenize(note.title).map((t) => t.token)
    const body = tokenize(note.body).map((t) => t.token)
    const doc = { title, body, length: title.length + body.length }
    this.docs.set(note.id, doc)
    this.totalLength += doc.length
    const add = (token: string, field: 't' | 'b') => {
      let p = this.postings.get(token)
      if (!p) {
        p = new Map()
        this.postings.set(token, p)
        this.sortedTokens = null
      }
      const f = p.get(note.id) ?? { t: 0, b: 0 }
      f[field]++
      p.set(note.id, f)
    }
    for (const t of title) add(t, 't')
    for (const t of body) add(t, 'b')
  }

  remove(id: string): void {
    const doc = this.docs.get(id)
    if (!doc) return
    this.docs.delete(id)
    this.totalLength -= doc.length
    for (const token of new Set([...doc.title, ...doc.body])) {
      const p = this.postings.get(token)!
      p.delete(id)
      if (p.size === 0) {
        this.postings.delete(token)
        this.sortedTokens = null
      }
    }
  }

  search(words: QueryWord[], candidates: (id: string) => boolean, limit: number): Array<{ id: string; score: number }> {
    const n = this.docs.size
    if (n === 0) return []
    const avgdl = this.totalLength / n || 1
    let scores: Map<string, number> | null = null
    for (const word of words) {
      const freqs = this.wordFreqs(word)
      let idf = Math.log((n - freqs.size + 0.5) / (freqs.size + 0.5))
      if (idf <= 0) idf = 1e-6
      const next = new Map<string, number>()
      for (const [id, f] of freqs) {
        if (scores && !scores.has(id)) continue
        const weighted = TITLE_WEIGHT * f.t + BODY_WEIGHT * f.b
        if (weighted <= 0) continue
        const d = this.docs.get(id)!.length
        const s = (idf * weighted * (K1 + 1)) / (weighted + K1 * (1 - B + (B * d) / avgdl))
        next.set(id, (scores?.get(id) ?? 0) + s)
      }
      scores = next
      if (scores.size === 0) return []
    }
    return [...scores!]
      .filter(([id]) => candidates(id))
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, limit)
      .map(([id, score]) => ({ id, score }))
  }

  /** The best 12-token stretch of the body, or null when the body has no match. */
  snippet(body: string, words: QueryWord[]): { snippet: string; matches: Array<[number, number]> } | null {
    const toks = tokenize(body)
    const list = toks.map((t) => t.token)
    const hit = new Array<boolean>(toks.length).fill(false)
    for (const word of words) for (const start of occurrences(list, word)) for (let j = 0; j < word.length; j++) hit[start + j] = true
    const first = hit.indexOf(true)
    if (first < 0) return null

    // The window with the most matching tokens (earliest on a tie), then centred on its matches.
    const size = Math.min(SNIPPET_TOKENS, toks.length)
    let best = 0
    let bestCount = -1
    let count = 0
    for (let i = 0; i < toks.length; i++) {
      if (hit[i]) count++
      if (i >= size && hit[i - size]) count--
      if (i >= size - 1 && count > bestCount) {
        bestCount = count
        best = i - size + 1
      }
    }
    const inWindow = [...Array(size).keys()].map((k) => best + k).filter((i) => hit[i])
    const centre = (inWindow[0]! + inWindow[inWindow.length - 1]!) / 2
    let lo = Math.round(centre - (size - 1) / 2)
    lo = Math.max(0, Math.min(lo, toks.length - size))
    const hi = lo + size - 1

    const from = lo === 0 ? 0 : toks[lo]!.start
    const to = hi === toks.length - 1 ? body.length : toks[hi]!.end
    const lead = lo === 0 ? '' : '…'
    const snippet = lead + body.slice(from, to) + (hi === toks.length - 1 ? '' : '…')
    const matches: Array<[number, number]> = []
    for (let i = lo; i <= hi; i++) {
      if (hit[i]) matches.push([toks[i]!.start - from + lead.length, toks[i]!.end - from + lead.length])
    }
    return { snippet, matches }
  }

  private wordFreqs(word: QueryWord): Map<string, Freq> {
    if (word.length === 1) {
      const out = new Map<string, Freq>()
      for (const token of this.tokensWithPrefix(word[0]!)) {
        for (const [id, f] of this.postings.get(token)!) {
          const sum = out.get(id) ?? { t: 0, b: 0 }
          sum.t += f.t
          sum.b += f.b
          out.set(id, sum)
        }
      }
      return out
    }
    // Several tokens in a row: check candidates that hold the first token, field by field.
    const out = new Map<string, Freq>()
    const firsts = this.postings.get(word[0]!)
    if (!firsts) return out
    for (const id of firsts.keys()) {
      const doc = this.docs.get(id)!
      const t = occurrences(doc.title, word).length
      const b = occurrences(doc.body, word).length
      if (t + b > 0) out.set(id, { t, b })
    }
    return out
  }

  private tokensWithPrefix(prefix: string): string[] {
    this.sortedTokens ??= [...this.postings.keys()].sort()
    const tokens = this.sortedTokens
    let lo = 0
    let hi = tokens.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tokens[mid]! < prefix) lo = mid + 1
      else hi = mid
    }
    const out: string[] = []
    for (let i = lo; i < tokens.length && tokens[i]!.startsWith(prefix); i++) out.push(tokens[i]!)
    return out
  }
}

/** Start indexes where `word` matches: all tokens exactly, the last as a prefix. */
function occurrences(list: string[], word: QueryWord): number[] {
  const out: number[] = []
  const last = word.length - 1
  for (let i = 0; i + word.length <= list.length; i++) {
    let ok = true
    for (let j = 0; j <= last && ok; j++) ok = j === last ? list[i + j]!.startsWith(word[j]!) : list[i + j] === word[j]
    if (ok) out.push(i)
  }
  return out
}
