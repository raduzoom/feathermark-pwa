import { execFileSync } from 'node:child_process'
import { beforeEach, expect, test } from 'vitest'
import { Library } from '../../src/core/library/library.ts'
import { buildQuery, fold, tokenize } from '../../src/core/library/search.ts'
import { fakeClock } from './support/clock.ts'

let clock: ReturnType<typeof fakeClock>
let lib: Library
beforeEach(() => {
  clock = fakeClock()
  lib = new Library(clock)
})
const titles = (q: string, o?: Parameters<Library['search']>[1]) => lib.search(q, o).map((h) => h.note.title)

test('fold lowercases and removes diacritics', () => {
  expect(fold('Été')).toBe('ete')
  expect(fold('Ñandú')).toBe('nandu')
  expect(fold('ß')).toBe('ß')
})

test('decomposed accents stay inside a word and are dropped', () => {
  expect(tokenize('Cre\u0300me bru\u0302le\u0301e').map((t) => t.token)).toEqual(['creme', 'brulee'])
})

test('only Latin letters lose their accents, and Greek sigma lowercases one letter at a time', () => {
  expect(fold('ё')).toBe('ё')
  expect(fold('ά')).toBe('ά')
  expect(fold('ΟΔΟΣ')).toBe('οδοσ')
  expect(fold('οδός')).toBe('οδόσ')
  expect(fold('ſun ẞ İ'.replaceAll(' ', ''))).toBe('sunßi')
})

test('tokenize splits on everything but letters, digits and private use', () => {
  expect(tokenize("Tram 28, don't—go! x")).toEqual([
    { token: 'tram', start: 0, end: 4 },
    { token: '28', start: 5, end: 7 },
    { token: 'don', start: 9, end: 12 },
    { token: 't', start: 13, end: 14 },
    { token: 'go', start: 15, end: 17 },
    { token: 'x', start: 19, end: 21 },
  ])
})

test('buildQuery drops words without letters or digits and returns null when empty', () => {
  expect(buildQuery('  ,,, ')).toBeNull()
  expect(buildQuery('')).toBeNull()
  expect(buildQuery('tram 28')).toEqual([['tram'], ['28']])
  expect(buildQuery("don't")).toEqual([['don', 't']])
  expect(buildQuery('a\u0000b')).toEqual([['a'], ['b']])
})

test('every word must match, as a prefix', () => {
  lib.createNote({ title: 'Lisbon, spring trip' })
  lib.createNote({ title: 'Lisbon notes' })
  expect(titles('lis spr')).toEqual(['Lisbon, spring trip'])
  expect(titles('isbon')).toEqual([])
})

test('a word of several tokens matches them in a row', () => {
  lib.createNote({ title: 'a', body: "don't stop" })
  lib.createNote({ title: 'b', body: 'don stop t' })
  expect(titles("don't")).toEqual(['a'])
})

test("accents and case don't matter", () => {
  lib.createNote({ title: 'Été à Lisbonne' })
  expect(titles('ete LISB')).toEqual(['Été à Lisbonne'])
})

test('title matches outrank body matches', () => {
  lib.createNote({ title: 'Other', body: 'bread bread' })
  lib.createNote({ title: 'Bread', body: 'flour' })
  lib.createNote({ title: 'Third', body: 'nothing' })
  expect(titles('bread')).toEqual(['Bread', 'Other'])
})

// FTS5's bm25(notes_fts, 5.0, 1.0), flipped. Written out separately from the implementation.
function referenceScores(docs: Array<{ title: string; body: string }>, query: string[][]): number[] {
  const toks = docs.map((d) => ({ t: tokenize(d.title).map((x) => x.token), b: tokenize(d.body).map((x) => x.token) }))
  const avgdl = toks.reduce((s, d) => s + d.t.length + d.b.length, 0) / docs.length
  const count = (list: string[], word: string[]) => {
    let c = 0
    for (let i = 0; i + word.length <= list.length; i++) {
      if (word.every((w, j) => (j === word.length - 1 ? list[i + j]!.startsWith(w) : list[i + j] === w))) c++
    }
    return c
  }
  return toks.map((d) =>
    !query.every((word) => count(d.t, word) + count(d.b, word) > 0) ? 0 : query.reduce((score, word) => {
      const n = toks.filter((o) => count(o.t, word) + count(o.b, word) > 0).length
      let idf = Math.log((docs.length - n + 0.5) / (n + 0.5))
      if (idf <= 0) idf = 1e-6
      const f = 5 * count(d.t, word) + count(d.b, word)
      const D = d.t.length + d.b.length
      return score + (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (D / avgdl)))
    }, 0),
  )
}

const corpus = [
  { title: 'Bread notes', body: 'Starter fed at 8, ready by 2. 500 g flour, 350 g water.' },
  { title: 'Groceries', body: 'Oat milk, lemons, rye flour, bread.' },
  { title: 'Weather station build', body: 'Reliable readings through winter. The sensor is a Bosch BME280.' },
  { title: 'Lisbon, spring trip', body: 'Flights land at 10:40. Tram 28 from Martim Moniz early.' },
  { title: 'Reading list 2027', body: 'The Overstory, Braiding Sweetgrass, Piranesi.' },
  { title: '1:1 with Mara', body: 'Release dates. Hiring for the spring. Keep the scope small.' },
  { title: 'Été', body: 'Pain au levain, été à Lisbonne, bread again and bread.' },
  { title: 'Flour types', body: 'Rye, spelt, bread flour, cake flour.' },
  { title: 'Empty', body: '' },
  { title: "Don't forget", body: "Don't forget the flour for the bread." },
]

test('ranking matches the bm25 formula on a fixed corpus', () => {
  const ids = corpus.map((d) => lib.createNote(d).id)
  for (const q of ['bread', 'flour bread', 'spring', "don't", 'ete lis', 'r']) {
    const words = buildQuery(q)!
    const ref = referenceScores(corpus, words)
    const expected = ids
      .map((id, i) => ({ id, s: ref[i]! }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : 1))
      .map((x) => x.id)
    expect(lib.search(q).map((h) => h.note.id), q).toEqual(expected)
  }
})

function sqliteAvailable(): boolean {
  try {
    execFileSync('sqlite3', [':memory:', 'CREATE VIRTUAL TABLE t USING fts5(a)'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Decomposed accents (as macOS often pastes them), Cyrillic and Greek: FTS5 drops U+0300–U+0331 wherever they
// appear and folds only precomposed Latin letters.
const nfd = (s: string) => s.normalize('NFD')
const foldingCorpus = [
  { title: nfd('Été à Paris'), body: nfd('café crème, naïve, coöperate') },
  { title: 'Été à Lyon', body: 'café' },
  { title: 'ёлка', body: 'йод' },
  { title: 'елка', body: 'иод' },
  { title: 'άλφα οδός', body: 'ΟΔΟΣ' },
  { title: 'αλφα οδος', body: 'Straße Ærø' },
  { title: 'ſun İstanbul', body: 'ẞtraße' },
]
const foldingQueries = ['ete', 'été', nfd('été'), 'creme', 'te', 'cooperate', 'naive', 'naïve', 'елка', 'ёлка', 'иод', 'αλφα', 'οδος', 'οδοσ', 'strasse', 'straße', 'aero', 'ærø', 'sun', 'istanbul', 'ßtraße']

for (const [label, docs, queries] of [
  ['the main corpus', corpus, ['bread', 'flour bread', 'spring', "don't", 'ete lis', 'r']],
  ['accents, Cyrillic and Greek', foldingCorpus, foldingQueries],
] as const)
test(`ranking matches SQLite FTS5 where sqlite3 is installed: ${label}`, (ctx) => {
  if (!sqliteAvailable()) {
    console.log('sqlite3 with FTS5 not found: cross-check skipped')
    ctx.skip()
  }
  const corpus = docs
  const ids = corpus.map((d) => lib.createNote(d).id)
  const esc = (s: string) => s.replaceAll("'", "''")
  for (const q of queries) {
    const fts = q
      .split(/\s+/)
      .filter((w) => /[\p{L}\p{N}]/u.test(w))
      .map((w) => `"${w.replaceAll('"', '""')}"*`)
      .join(' ')
    const sql =
      "CREATE VIRTUAL TABLE t USING fts5(title, body, tokenize='unicode61 remove_diacritics 2');" +
      corpus.map((d, i) => `INSERT INTO t(rowid, title, body) VALUES (${i + 1}, '${esc(d.title)}', '${esc(d.body)}');`).join('') +
      `SELECT rowid || '|' || printf('%.12f', -bm25(t, 5.0, 1.0)) FROM t WHERE t MATCH '${esc(fts)}';`
    const rows = execFileSync('sqlite3', [':memory:', sql], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    const sqliteScore = new Map(rows.map((r) => r.split('|')).map(([rowid, s]) => [ids[Number(rowid) - 1]!, Number(s)]))
    const ours = lib.search(q)
    expect(new Set(ours.map((h) => h.note.id)), q).toEqual(new Set(sqliteScore.keys()))
    const expectedOrder = [...sqliteScore].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map((x) => x[0])
    expect(ours.map((h) => h.note.id), q).toEqual(expectedOrder)
  }
})

test('ties are broken by id', () => {
  const a = lib.createNote({ title: 'same', body: 'x' })
  const b = lib.createNote({ title: 'same', body: 'x' })
  expect(lib.search('same').map((h) => h.note.id)).toEqual([a.id, b.id].sort())
})

test('filters: trash only in the Trash, notebook includes sub-notebooks, tags need all', () => {
  const home = lib.createNotebook('Home', null)
  const kitchen = lib.createNotebook('Kitchen', home.id)
  const t1 = lib.createTag('one')
  const t2 = lib.createTag('two')
  lib.createNote({ title: 'pasta home', notebookId: home.id, tagIds: [t1.id] })
  lib.createNote({ title: 'pasta kitchen', notebookId: kitchen.id, tagIds: [t1.id, t2.id] })
  const trashed = lib.createNote({ title: 'pasta old' })
  lib.trashNote(trashed.id)
  expect(new Set(titles('pasta'))).toEqual(new Set(['pasta home', 'pasta kitchen']))
  expect(titles('pasta', { inTrash: true })).toEqual(['pasta old'])
  expect(new Set(titles('pasta', { notebookId: home.id }))).toEqual(new Set(['pasta home', 'pasta kitchen']))
  expect(titles('pasta', { notebookId: kitchen.id })).toEqual(['pasta kitchen'])
  expect(titles('pasta', { tagIds: [t1.id, t2.id] })).toEqual(['pasta kitchen'])
})

test('at most 200 results', () => {
  for (let i = 0; i < 205; i++) lib.createNote({ title: `apple ${i}` })
  expect(lib.search('apple')).toHaveLength(200)
  expect(lib.search('apple', { limit: 3 })).toHaveLength(3)
})

test('snippet marks matches, adds … at cut edges, and is null for a title-only match', () => {
  const words = Array.from({ length: 30 }, (_, i) => `w${i}`)
  words[15] = 'needle'
  lib.createNote({ title: 'long', body: words.join(' ') })
  lib.createNote({ title: 'needle in title', body: 'nothing here' })
  const hits = lib.search('needle')
  const long = hits.find((h) => h.note.title === 'long')!
  expect(long.snippet.startsWith('…')).toBe(true)
  expect(long.snippet.endsWith('…')).toBe(true)
  expect(long.matches).toHaveLength(1)
  const [s, e] = long.matches[0]!
  expect(long.snippet.slice(s, e)).toBe('needle')
  const title = hits.find((h) => h.note.title === 'needle in title')!
  expect(title).toMatchObject({ snippet: 'nothing here', matches: [] })
})

test('the snippet keeps the body as written at the start', () => {
  lib.createNote({ title: 'x', body: 'Bread is good.' })
  expect(lib.search('bread')[0]).toMatchObject({ snippet: 'Bread is good.', matches: [[0, 5]] })
})

test('the index follows edits, trashing and deletion', () => {
  const n = lib.createNote({ title: 'alpha' })
  expect(titles('alpha')).toEqual(['alpha'])
  lib.updateNote(n.id, { title: 'beta' })
  expect(titles('alpha')).toEqual([])
  expect(titles('beta')).toEqual(['beta'])
  lib.trashNote(n.id)
  expect(titles('beta')).toEqual([])
  expect(titles('beta', { inTrash: true })).toEqual(['beta'])
  lib.deleteNotePermanently(n.id)
  expect(titles('beta', { inTrash: true })).toEqual([])
})

test('10,000 notes search in under 50 ms', () => {
  let seed = 42
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  const vocab = Array.from({ length: 3000 }, (_, i) => `word${i.toString(36)}`)
  const pick = () => vocab[Math.floor(rand() * vocab.length)]!
  for (let i = 0; i < 10_000; i++) {
    lib.createNote({ title: `${pick()} ${pick()}`, body: Array.from({ length: 120 }, pick).join(' ') })
  }
  const queries = ['word1', 'word2a', 'wordz word1', 'word5', 'word10']
  for (let i = 0; i < 3; i++) lib.search(queries[i % queries.length]!)
  const times: number[] = []
  for (let i = 0; i < 20; i++) {
    const t = performance.now()
    lib.search(queries[i % queries.length]!)
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  const median = times[10]!
  console.log(`search 10k notes: median ${median.toFixed(1)} ms`)
  expect(median).toBeLessThan(50)
}, 120_000)
