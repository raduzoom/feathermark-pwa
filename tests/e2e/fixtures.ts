// Every browser test imports `test` from here, never from @playwright/test. After each test it fails the
// test on any Content Security Policy violation the test didn't declare, any request to another origin
// the test didn't allow, and anything left in browser storage.
//
// It watches the whole browser context, not one page: every page and popup, every navigation and reload,
// and every worker. Violations are sent to Node as they happen, so nothing is lost when a page goes away.
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'

export { expect }

export type Leaks = {
  /** From securitypolicyviolation events, in pages and workers: "<directive> <blocked URI>". */
  violations: string[]
  /** Console messages about the policy: the fallback for an engine that fires no event. */
  consoleViolations: string[]
  foreignRequests: string[]
  /** This test causes a violation matching `pattern`; at least one must happen. */
  expectViolation(pattern: RegExp): void
  /** A request to another origin matching `pattern` may happen (engines differ on reporting blocked ones). */
  allowForeignRequest(pattern: RegExp): void
  /** Everything teardown would fail the test on, right now. */
  problems(): Promise<string[]>
  /** For the harness's own tests only: let deliberate leaks through teardown. */
  forgive(): void
}

export type StorageReport = {
  localStorage: number
  sessionStorage: number
  indexedDB: string[]
  cookies: string
  caches: string[]
}

export async function storageReport(page: Page): Promise<StorageReport> {
  return page.evaluate(async () => ({
    localStorage: localStorage.length,
    sessionStorage: sessionStorage.length,
    indexedDB: (await indexedDB.databases()).map((d) => d.name ?? '(unnamed)'),
    cookies: document.cookie,
    caches: 'caches' in self ? await caches.keys() : [],
  }))
}

const CSP_CONSOLE = /content.security.policy|refused to (load|execute|apply|connect)/i
const WORKER_MARK = '__feather_csp__ '

/** Runs inside a worker: report its policy violations through the console, which Playwright forwards. */
function watchWorker(mark: string) {
  self.addEventListener('securitypolicyviolation', (e) => console.log(`${mark}${e.violatedDirective} ${e.blockedURI}`))
}

async function contextProblems(context: BrowserContext, origin: string, leaks: Leaks, expected: RegExp[], allowed: RegExp[]) {
  const problems: string[] = []

  // Events name the directive, so they are matched exactly. Console text often doesn't, so it only fails a
  // test that expected no violation, and stands in for a declared one when no event fired.
  for (const v of leaks.violations) if (!expected.some((p) => p.test(v))) problems.push(`unexpected violation: ${v}`)
  if (expected.length === 0) for (const c of leaks.consoleViolations) problems.push(`unexpected violation (console): ${c}`)
  for (const p of expected) {
    const seen = leaks.violations.some((v) => p.test(v)) || (leaks.violations.length === 0 && leaks.consoleViolations.length > 0)
    if (!seen) problems.push(`expected a violation matching ${p}`)
  }
  for (const u of leaks.foreignRequests) if (!allowed.some((p) => p.test(u))) problems.push(`request to another origin: ${u}`)

  // Storage outlives pages, so check it from a fresh page on the app's origin, plus sessionStorage (one per
  // tab) in every page still open on it.
  const cookies = await context.cookies()
  if (cookies.length) problems.push(`cookies: ${cookies.map((c) => c.name).join(', ')}`)
  const fresh = await context.newPage()
  try {
    await fresh.goto(origin + '/')
    const s = await storageReport(fresh)
    if (s.localStorage) problems.push(`localStorage: ${s.localStorage} item(s)`)
    if (s.indexedDB.length) problems.push(`IndexedDB: ${s.indexedDB.join(', ')}`)
    if (s.caches.length) problems.push(`caches: ${s.caches.join(', ')}`)
  } finally {
    await fresh.close()
  }
  for (const page of context.pages()) {
    if (!page.url().startsWith(origin)) continue
    const n = await page.evaluate(() => sessionStorage.length).catch(() => 0)
    if (n) problems.push(`sessionStorage: ${n} item(s) in ${page.url()}`)
  }
  return problems
}

export const test = base.extend<{ leaks: Leaks }>({
  leaks: [
    async ({ context, baseURL }, use) => {
      const origin = new URL(baseURL!).origin
      const expected: RegExp[] = []
      const allowed: RegExp[] = []
      let forgiven = false
      const leaks: Leaks = {
        violations: [],
        consoleViolations: [],
        foreignRequests: [],
        expectViolation: (p) => void expected.push(p),
        allowForeignRequest: (p) => void allowed.push(p),
        problems: () => contextProblems(context, origin, leaks, expected, allowed),
        forgive: () => void (forgiven = true),
      }

      await context.exposeBinding('__featherViolation', (_source, text: string) => void leaks.violations.push(text))
      await context.addInitScript(() => {
        const report = (window as unknown as { __featherViolation: (t: string) => void }).__featherViolation
        document.addEventListener('securitypolicyviolation', (e) => void report(`${e.violatedDirective} ${e.blockedURI}`))
      })
      const watchPage = (page: Page) =>
        page.on('worker', (worker) => void worker.evaluate(watchWorker, WORKER_MARK).catch(() => {}))
      context.pages().forEach(watchPage)
      context.on('page', watchPage)
      context.on('console', (m) => {
        const text = m.text()
        if (text.startsWith(WORKER_MARK)) leaks.violations.push(text.slice(WORKER_MARK.length))
        else if (CSP_CONSOLE.test(text)) leaks.consoleViolations.push(text)
      })
      context.on('request', (r) => {
        const url = r.url()
        if (/^(data|blob|about):/.test(url)) return
        if (new URL(url).origin !== origin) leaks.foreignRequests.push(url)
      })

      await use(leaks)

      if (forgiven) return
      expect(await leaks.problems(), 'leaks found after the test').toEqual([])
    },
    { auto: true },
  ],
})
