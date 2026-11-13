# FeatherMark for the web: agent rules

Rules for AI agents in this repo. `CLAUDE.md` is a symlink to this file. The shared rules for all FeatherMark repos are in `../AGENTS.md` (git, CI, ports, Dropbox); global rules in `~/Dropbox/Configs/claude/AGENTS.md` still apply.

This repo is the web app: a TypeScript app served as static files from `app.feathermark.com` (Cloudflare Pages). Without logging in it is a demo with sample notes that stores nothing; logged in it is a Feather Cloud client that decrypts in the browser. MIT. The design is `../universal/specs/2026-11-12-feathermark-web-design.md`; the phases are 17–21 in `../universal/plans/feather-note-roadmap.md`.

## Code layout (when adding code, or deciding where it goes)

| Folder | Owns |
|---|---|
| `src/core/` | Headless, no DOM, tested in Node: ULIDs, the clock, `zip.ts`, `library/` (the in-memory library, views and counts, search, export, attachments, the sample notes), `crypto/`. `library/links.ts` reads attachment links with the editor's parser (`src/editor/markdown/`, also headless), so the library and the editor agree on what is a link. |
| `src/editor/` | The note editor on CodeMirror 6: `markdown/` (the parse in the Swift editor's shape), `commands/` (the Swift commands, ported), live preview, keymap, block menu, attachments. Rules: `../universal/specs/editor.md`; cases: `../universal/test-vectors/editor/`. |
| `src/model/` | `AppModel` (selection, the open note and its 500 ms save, Undo after Trash, search state, empty states, errors), `format.ts` (every string built from data), `line-endings.ts` |
| `src/ui/` | Preact views. They only read the model's signals and call its actions; behaviour goes in the model. |
| `src/worker/` | The crypto worker and its client |

- **The rules come from `../universal/specs/data-model.md`** ("Views and sort orders", "Search", "Export"), written from the Apple code in Phase 18. Change the spec first, then the code, so every platform agrees. Search ranking is checked against SQLite FTS5 itself when `sqlite3` is installed (`tests/unit/search.test.ts`).
- **Sample notes are `origin: 'sample'`;** notes, notebooks and tags people make are `'user'`. Phase 20 must never put a sample item into an account.
- **A note's text is stored exactly as typed.** A `<textarea>` reports CRLF as LF, so the editor shows `textareaValue(body)` and saves `bodyFromTextarea(value, body)`, which keeps untouched text byte for byte. Any new editor (Phase 19's CodeMirror normalizes line breaks too) must do the same.
- **Copy:** `../universal/design/ui-copy.md`, section "Web app" (sentence case on the web), and `src/model/format.ts`.
- **Keyboard shortcuts** are registered in a layout effect, so they work from the first paint. List focus moves at once on arrow keys, never in a later frame.

## Commands and ports (when running or testing)

| Command | What |
|---|---|
| `pnpm dev` | Dev server on 8430. Not under the security policy (Vite's dev client needs inline code); never test against it. |
| `pnpm build` then `pnpm preview` | The production build on 8431, with the same headers Cloudflare Pages sends. |
| `pnpm test` | Unit tests (Vitest, Node), `tests/unit/`. |
| `pnpm typecheck` | TypeScript over everything, tests and the test page included. `pnpm build` checks only what it ships (`tsconfig.build.json`), so it builds without `../universal`. |
| `pnpm e2e` | Browser tests (Playwright), `tests/e2e/`, against a fresh build on 8431. `FEATHER_ENGINES=chromium,webkit` picks engines. |
| `FEATHER_LIVE_URL=https://app.feathermark.com pnpm e2e:live` | The published demo, checked from outside with the same leak fixture (`tests/live/`). |
| `pnpm tokens` | Regenerates `src/ui/tokens.css` from `../universal/design/tokens.json`. |
| `pnpm spike` | Builds with the Argon2id device page and serves it on 8431. For a phone, open it over HTTPS (see "Device checks"). |
| `bash scripts/test_all.sh` | Every check in order, including the first-load size (`scripts/bundle-size.ts`, budget 300 KB gzipped); must end with `all tests: OK`. |

The tests read `../universal/design/tokens.json` and `../universal/test-vectors/`, so `universal` must be checked out next to this repo (or set `FEATHER_TOKENS` and `FEATHER_TEST_VECTORS`).

## Before pushing

CI is manual-only (`../AGENTS.md`, "GitHub Actions"). Run `bash scripts/test_all.sh` and report "CI green, run locally". On macOS it runs Chromium and WebKit only: Playwright's Firefox does not start on macOS 27.2 ("Could not find profile folder", 2026-11-12). CI on Linux runs all three. Check Firefox-specific work by hand in Firefox until that is fixed.

## Deploying (when publishing the demo to app.feathermark.com)

The demo is published by direct upload of `dist/` to the Cloudflare Pages project `feathermark-app`, so the files that go live are the files the tests ran against. Accounts stay off until Phase 20 (`VITE_FEATHER_ACCOUNTS` unset). Publishing is the user's step: ask before running any of these. Deploy a committed, pushed tree, after `bash scripts/test_all.sh` printed `all tests: OK`.

Once, to set it up (the first command opens the browser to sign in to Cloudflare):

```bash
pnpm dlx wrangler@4.155.0 login
```

```bash
pnpm dlx wrangler@4.155.0 pages project create feathermark-app --production-branch main
```

Then in the Cloudflare dashboard: Workers & Pages › feathermark-app › Custom domains › Set up a custom domain › `app.feathermark.com` (feathermark.com's DNS is on Cloudflare, so the record is made for you).

Each release (a plain `pnpm build`, never `pnpm spike`, so the Argon2id test page isn't published):

```bash
pnpm build && pnpm dlx wrangler@4.155.0 pages deploy dist --project-name feathermark-app --branch main
```

```bash
FEATHER_LIVE_URL=https://app.feathermark.com FEATHER_ENGINES=chromium,webkit pnpm e2e:live
```

`dist/_headers` carries the security headers for every path and a year's caching for `/assets/*` (hashed names). An unknown path, `/login` included, gets `index.html`, which is the demo. `wrangler` is pinned to a release at least two weeks old; move the pin deliberately.

### Hand checks after a release (the user's)

- The live demo in Safari on the Mac, on an iPhone and an iPad, in Firefox, and in Chrome on Android: open the Weather station note (its picture shows), type, bold with ⌘B or Ctrl+B, "/" for the block menu, drop or paste a picture, Download .md (a zip for the Weather note).
- Japanese or Chinese input in Safari, inside a bold word: the composed text arrives once (Chromium is tested automatically; WebKit isn't).
- Spell-check suggestions in Safari and Chrome: accepting one changes only that word.
- VoiceOver on the Mac: the editor reads as "Note, text", the block menu as "Insert" with its rows, a chip as "receipt.pdf, attachment", the sample picture as "Radiation shield".
- Keyboard only: Escape then Tab leaves the editor; Shift+F10 on a note row opens its menu.

## Security policy (when adding a script, style, request or storage)

- The policy is in `scripts/policy.ts`, the only place it is written. The preview server sends it and the build writes it to `dist/_headers`.
- No inline script, no inline `<style>`, no `style` prop or attribute, no `data:` URL. Styles go in stylesheets imported from code.
- No request to any origin but the page's own. Phase 20 adds the Feather Cloud origin through `contentSecurityPolicy({ cloudOrigin })`.
- Nothing in localStorage, sessionStorage, IndexedDB, cookies or caches. The demo stores nothing; Phase 20 brings the one sanctioned store ("Keep my notes on this browser").

## Browser tests (when writing one)

- Import `test` and `expect` from `tests/e2e/fixtures.ts`, never from `@playwright/test`. After each test the fixture fails it on any policy violation not declared with `leaks.expectViolation(pattern)`, any request to another origin not allowed with `leaks.allowForeignRequest(pattern)`, and anything left in browser storage.
- The fixture watches the whole browser context: every page and popup, every navigation, and every worker (a worker's violations are seen from the moment the harness attaches, so a worker should act only on messages). Storage is checked from a fresh page on the app's origin, so closing or leaving the page doesn't hide it.
- `leaks.problems()` lists what teardown would fail on; `leaks.forgive()` lets deliberate leaks through. Only `tests/e2e/harness*.spec.ts` may call `forgive()`: those tests prove the harness still sees each kind of leak.
- Find elements by role and accessible name, never by class. Playwright's role queries don't apply HTML `inert`; to check something is out of reach, check that it sits inside an `[inert]` subtree.
- Screenshots: pass `caret: 'initial'`. In WebKit, Playwright's screenshot still injects an empty `<style>`; `tests/e2e/screens.spec.ts` declares that one violation for WebKit only. Don't copy that into tests that check the app.

## Styles (when adding a stylesheet or a component)

- Colours only through the variables in `src/ui/tokens.css` (`--c-*`, `--icon-*`); a unit test fails on any colour literal elsewhere. Sizes, spacing and radii also come from it where a token exists.
- Widths: three columns from 1000 px; the library is a drawer from 640 to 999 px, with "New note" in the bottom bar; one column below 640 px with 44 px targets. Light and dark follow the system.
- While the drawer is open, everything outside it is `inert`; it closes when the window reaches 1000 px. New content behind the drawer must sit inside one of those inert containers.
- Fonts are the system stacks in `--font-serif`, `--font-sans`, `--font-mono`. No web fonts.

## When `tokens.json` changes

`pnpm tokens`, then `pnpm test`. `scripts/test_all.sh` fails while `tokens.css` is stale.

## Dependencies (when adding one)

Exact versions only, the lockfile committed, `pnpm install --frozen-lockfile` in scripts. Name the dependency and the reason in the phase plan. Today: `preact`, `@preact/signals`, `hash-wasm` (Argon2id in WebAssembly), CodeMirror 6 for the note editor (`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/language`, `@lezer/markdown`, `@lezer/common`; Phase 19); dev: `vite`, `@preact/preset-vite`, `typescript`, `vitest`, `@playwright/test`, `@types/node`, `argon2id` (the Argon2id test page only).

**Patched: `style-mod`** (`patches/style-mod@4.1.4.patch`, applied by pnpm on install). CodeMirror injects its base theme through `style-mod`, which writes a `<style>` tag on a normal page; the policy refuses inline styles, so the editor would lose its own styles. The patch makes it use a constructed stylesheet (`document.adoptedStyleSheets`, in every browser we support), which the policy allows. When CodeMirror or `style-mod` is upgraded, re-apply or drop the patch and run `tests/e2e/editor-policy.spec.ts`: it fails on any `<style>` tag or policy violation.

**Patched: `@lezer/markdown`** (`patches/@lezer__markdown@1.8.1.patch`). Closing a link walked back over every earlier part of its paragraph to cancel open `[` markers, so a paragraph of many links was quadratic: a pasted 2 MB line took 50 s to parse. The patch stops at the previous link (every marker before it was cancelled when it closed, for good). Pinned by `many links in one paragraph parse in linear time` (`tests/unit/editor-document.test.ts`) and `a 2 MB line opens` (`tests/e2e/editor-speed.spec.ts`). Offer the fix upstream; drop the patch once a release has it.

## Crypto (when touching `src/core/crypto` or the worker)

- `../universal/specs/crypto.md` is normative. Only `ARGON2_V1` (`argon2id13`, t 3, 256 MiB, p 1, 16-byte salt) is accepted; anything else is refused before hashing.
- Load vector values from `../universal/test-vectors/`; never copy them into code.
- Crypto runs in `src/worker/crypto.worker.ts`. Every call through `createCryptoClient()` settles: it rejects when the worker reports an error, fails to load, dies, is stopped, or gives no answer within 60 s, and once the worker is gone later calls reject at once. Tests pass a fake worker through the `worker` option.

### Device checks (when timing anything on a phone)

Always over HTTPS. Safari on iOS runs a plain-`http://` page 10–25× slower: on an iPhone 17 Pro Max the same page took 10.4–11.2 s per Argon2id derivation over `http://<Mac's address>:8431` and 0.46 s over HTTPS (2026-11-12). The cause was found by elimination: not the crypto library, memory size, the security policy, Lockdown, Low Power or Adaptive Power mode. HTTPS was the one change that fixed it. Numbers taken over plain `http` on a LAN mean nothing.

To open the test page over HTTPS from this Mac (`cloudflared` is installed with Homebrew; the address is random and public while it runs, so close it straight after):

```bash
pnpm spike
```

```bash
cloudflared tunnel --no-autoupdate --url http://localhost:8431 --http-host-header localhost:8431
```

Open the `https://….trycloudflare.com/spike/argon2.html` address it prints, then stop both.

### Argon2id in browsers (Phase 17, 2026-11-12)

The design's bar: unlocking under 5,000 ms on the user's iPhone and on a mid-range Android phone. The app uses `hash-wasm`. The test page also races `argon2id` (openpgpjs), a dev dependency of the page only. Its SIMD build is about 30% faster on iOS, but it was last released in 2023 and would be a second Argon2 library; revisit if Android misses the bar.

| Browser and device | Match | Times (ms) | Notes |
|---|---|---|---|
| Node 24, Mac (Vitest) | 3 of 3 | about 500 each | |
| Playwright Chromium, Mac | 3 of 3 | 620, 560, 537 | in the worker, under the policy |
| Playwright WebKit, Mac | 3 of 3 | 585, 520, 529 | in the worker, under the policy |
| Safari, Mac | | | to run by hand |
| Safari, iPhone 17 Pro Max, **HTTPS**: hash-wasm (the app) | 3 of 3 | 664, 431, 460 | median 0.46 s: meets the bar 10× over |
| Same, HTTPS: argon2id SIMD | 3 of 3 | 662, 319, 314 | median 0.32 s |
| Same, HTTPS: argon2id non-SIMD | 3 of 3 | 799, 518, 530 | median 0.53 s |
| Same iPhone over plain `http` on the LAN (misleading; kept for the record) | 3 of 3 | 10164 to 18267 | 10–25× slower than HTTPS in every build |
| Mac race (Playwright), all three builds | 3 of 3 each | 530 to 772 | a near tie; non-SIMD slowest |
| Chrome, Android | | | to run by hand |

## Editor speed (when changing the editor, its parser or live preview)

The roadmap's bars (Phase 19 exit criteria): a 50,000-word note opens in under 300 ms; typing in it, median under 8 ms and p99 under 16 ms. `tests/e2e/editor-speed.spec.ts` measures them on the production build and prints `SPEED` lines. They are tagged `@speed`: `scripts/test_all.sh` runs them after the other browser tests, alone on one worker, because other workers beside them skew the numbers (WebKit's p99 reached 18 ms that way). Open is timed from the row's click to the frame after the note's text is in the editor (`performance.mark('feather:note-open')`, which records no text); a keystroke from `keydown` to style and layout after the editor's `input`.

- Work per keystroke must not grow with the note: one string copy of the text per change (`src/editor/doc-text.ts`), live preview built for the visible lines only, no diff of the whole note to save it (`bodyFromTextarea`'s fast path for notes without CR).
- A block over 65,536 characters is shown plain and its inline spans aren't collected (`MAX_STYLED_BLOCK`), as on the Mac.

| Date, machine | Engine | Open 50k words (ms, 5 runs) | Keystroke median / p99 (ms) | Open a 2 MB line (ms) |
|---|---|---|---|---|
| 2026-11-12, M2 Pro, macOS 27.2.1, alone on one worker | Chromium | 38, 35, 30, 31, 33 | 4.3 / 10.5 | 595 |
| same | WebKit | 24, 20, 18, 18, 17 | 5.0 / 10.0 | 338 |

First load after Phase 19: about 140 KB gzipped (budget 300 KB), with CodeMirror.

## Dropbox (after cloning, after a build and after git work)

```bash
for d in .git/index node_modules dist test-results playwright-report; do [ -e "$d" ] && xattr -w com.dropbox.ignored 1 "$d"; done
```

`scripts/test_all.sh` re-applies it to the build folders when it ends.
