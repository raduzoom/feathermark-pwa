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
| `pnpm build` then `pnpm preview` | The production build on 8431, with the same headers Cloudflare Pages sends. `pnpm demo` does both. |
| `pnpm cloud:up`, `pnpm cloud:app`, `pnpm cloud:code`, `pnpm cloud:down` | Try accounts by hand: start the local Feather Cloud (`../server`, see "Accounts build and local Feather Cloud"); build and serve the accounts build on 8431 (so not beside `pnpm demo`); print the last verification code the server logged; stop the server, keeping its volumes. |
| `pnpm test` | Unit tests (Vitest, Node), `tests/unit/`. |
| `pnpm typecheck` | TypeScript over everything, tests and the test page included. `pnpm build` checks only what it ships (`tsconfig.build.json`), so it builds without `../universal`. |
| `pnpm e2e` | Browser tests (Playwright), `tests/e2e/`, against a fresh build on 8431. `FEATHER_ENGINES=chromium,webkit` picks engines. |
| `FEATHER_LIVE_URL=https://app.feathermark.com pnpm e2e:live` | The published demo, checked from outside with the same leak fixture (`tests/live/`). |
| `pnpm tokens` | Regenerates `src/ui/tokens.css` from `../universal/design/tokens.json`. |
| `pnpm spike` | Builds with the test pages (`/spike/argon2.html`, the Argon2id device page; `/spike/vectors.html`, every crypto vector in a worker) and serves them on 8431. For a phone, open them over HTTPS (see "Device checks"). |
| `pnpm e2e:cloud` | The accounts build: `VITE_FEATHER_CLOUD_URL=http://localhost:8420` into `dist-cloud/`, served on 8431 (so never beside `pnpm e2e` or `pnpm preview`), running `tests/cloud/` against the local server. |
| `bash scripts/test_all.sh` | Every check in order, including the first load (`scripts/bundle-size.ts`: lists its files; fails over 300 KB gzipped or on crypto or sync code in it); runs the `cloud` step (and `cloud speed`, the `@speed` cloud tests alone on one worker) only when something answers on 8420, else prints `skipped: no local server`, and after it the same first-load check on the accounts build (`--dir dist-cloud`); must end with `all tests: OK`. |

The tests read `../universal/design/tokens.json` and `../universal/test-vectors/`, so `universal` must be checked out next to this repo (or set `FEATHER_TOKENS` and `FEATHER_TEST_VECTORS`).

## Accounts build and local Feather Cloud (when working on accounts, or running `pnpm e2e:cloud`)

- Accounts switch on with `VITE_FEATHER_CLOUD_URL`, an origin: `https:`, or `http:` only for `localhost` and `127.0.0.1`. Unset, the build is the plain demo with "Get FeatherMark" and every path, `/login` included, is the demo. Set, the demo line shows "Log in" and "Create account", which open `/login` and `/login?create` without reloading the page (`src/ui/router.ts`; `src/model/route.ts` says which screen a path shows), nothing is fetched until one is used, and the policy's `connect-src` gains that origin (`cloudOrigin()` in `scripts/policy.ts`; the build writes it into `_headers`, the preview server sends it). `VITE_FEATHER_ACCOUNTS` no longer exists.
- Start a local Feather Cloud that lets the preview origin call it (from `../server`; if `docker` isn't on PATH, `export PATH="$HOME/.orbstack/bin:$PATH"` first). `FEATHER_ALLOWED_ORIGINS` and `FEATHER_TRUST_PROXY` are passed through the compose environment (no server change). `FEATHER_TRUST_PROXY=true` lets each test context count as its own address for the rate limits (5 signups an hour per address): `useCloud()` in `tests/cloud/support/server.ts` sends a random `X-Forwarded-For` per context, as the Swift integration harness does. Without it every test shares one address and a second run within the hour fails at signup.

```bash
cd ../server && FEATHER_TRUST_PROXY=true FEATHER_ALLOWED_ORIGINS=http://localhost:8431 docker compose -f deploy/docker-compose.yml up -d --wait
```

- Stop it, keeping its volumes: `cd ../server && docker compose -f deploy/docker-compose.yml down`.
- In tests, `leaks.allowCloud(origin)` (`tests/e2e/fixtures.ts`) lets requests to the cloud origin through; any other foreign request still fails. `tests/cloud/support/server.ts` has the shared steps: `useCloud(context, leaks)` (call it first in every cloud test), `signUp`, `logIn`, `writeNote`, and `verificationCode(email)`, which reads the code from `docker compose logs server` (the server runs with `FEATHER_MAIL=log`).
- The account screens (`src/ui/account/`: `LogIn`, `Recovery`, `CreateAccount`) only read the flows in `src/model/account-flows.ts` (ported from `AccountFlows.swift`), which load the session through `startSession` when first used. Neither imports the account service or the API client at run time, so they sit in the first load without sync or crypto code.
- While the notes aren't on screen (locked, a browser that can't unlock, or an account screen), no app shortcut acts (`appShown` in `App.tsx`).

## "Keep my notes on this browser" and the owning tab (when touching the kept copy, the tab lock or Settings › Sync)

- The kept copy is the sealed vault only, in the IndexedDB database `feathermark` (`src/core/vault/kept-store.ts`): store `vault` holds one record (credentials, cursor, the sealed sync-conflicts list, the item count), store `items` one record per `SealedItem`. A save replaces both in one transaction; a load checks every record and refuses the whole copy (`KeptVaultDamaged`) rather than half-load it. It holds no title, body, name or file name in the clear; `tests/unit/kept-store.test.ts` searches every stored byte for them.
- The copy names its owner, a random id per tab (`tabId`), and **every write is a compare-and-set** in its own transaction (`KeptStore.save(v, { as, from? })`, `claim(as, from)`, `remove(as)`): a write from a tab that isn't the owner is refused (`NotKeptOwner`) and writes nothing, and a tab that never created the copy can't bring a removed one back (no copy, no owner). A tab whose write is refused keeps its edits in memory, counted as unsynced: closing asks, and it keeps pushing them to the server.
- The owner saves after every scheduled sync pass, synced or not (the engine's `afterPass` hook), at once when the tab is hidden (`pageHidden`; `pagehide` can't wait for IndexedDB), and on every lock. With Keep on, closing asks first while changes exist that are neither pushed nor in the kept copy (`keptSeq`), or, locked, when the lock's save didn't land (`vaultKept`). Turning Keep off and signing out delete the copy (as its owner) and let the lock go.
- Saves are incremental. `Vault.create(…, previous)` keeps the envelopes of every item whose bookkeeping (`sameVersion`) didn't change, since every local change gives a new `dirtySeq` and every remote one a new `serverVersion` or `bodyLoaded`. `KeptStore.save` then puts only the changed records and deletes the gone ones, unless the header's `stamp` shows another writer came between, in which case it rewrites the copy whole.
- Keep is refused, with a message, over another account's copy, while another tab keeps it, or over a kept copy with unsynced changes. The tab is told to reload first, which opens that copy.
- On opening the app, `resumeKept()` (`src/model/session-host.ts`) looks for the database with `indexedDB.databases()`, which never creates one, so the demo still stores and fetches nothing. With a copy, it loads the session. If no live tab holds the Web Lock `feathermark-vault`, the tab claims the copy and shows the unlock screen; unlocking needs no request, and the crypto worker has answered once before that screen shows, so unlocking works offline. If a live tab holds the lock, it shows "FeatherMark is open in another tab." instead.
- "Use it here" is a **handover with an id**, on the BroadcastChannel `feathermark-vault`:
  - The taker posts `{ handover, id }` and steals the Web Lock (which only says a tab is alive).
  - The owner turns read-only, saves everything it holds as the owner, and answers `{ handedOver, id }`.
  - The taker accepts only its own id. After 10 s it posts `{ gaveUp, id }`, and the owner then counts its handover as failed, even if its save lands late.
  - Either way the taker then claims the copy from the owner it saw. The claim's compare-and-set and the read are one transaction, so of two takers exactly one wins; the other shows "FeatherMark is open in another tab."
  - A tab whose handover didn't land warns on close and keeps pushing its edits. Taking the copy back, it opens the copy and merges its own unsynced notes in as local changes (`src/core/vault/merge.ts`: same text skipped, an unchanged note updated in place, otherwise a new note or a conflict copy, with linked attachments carried along). A locked tab merges at unlock (`pendingMerge`).
  - The tab that lost the copy shows "FeatherMark is now open in another tab." and offers only "Lock now": no "Settings…", no "Sign out" (the session refuses both with `NotOwner`). It never opens or replaces another account's copy.
- With Keep off nothing changes: closing the tab logs out on `pagehide` with `keepalive`.
- Speed: `tests/cloud/keep-speed.spec.ts` (`@speed`, alone on one worker in `test_all.sh`'s "cloud speed" step) seeds 199 notes from Node (`tests/cloud/support/seed.ts`: the app's own account service, engine and key store, real Argon2id), waits until the body loader marks `feather:bodies-loaded`, adds 4 × 1 MB attachments, and turns Keep on. With the server out of reach, so a pass's own work is out of the picture, it times saves alone with the main thread watched (no block over 50 ms may overlap a save), then typing in bursts with a save before each, and asserts the editor bars outright. It uses 200 notes (written before Task 12, when 1,000 never reached steady state; loading 1,000 is now `tests/cloud/load-speed.spec.ts`, see "Loading a library"). 2026-11-13, M2 Pro: a save after one edit 2 ms; saves alone 3–9 ms, never blocking; keystrokes while saving median 2.3 / p99 5.7 ms (Chromium) and 2.0 / 4.0 ms (WebKit).
- In browser tests, `leaks.allowKeptVault()` lets the `feathermark` database stay after the test; anything else stored still fails it. Two tabs of one browser are two pages of one context (Web Locks and IndexedDB are per context); `leaks.newContext()` is another device.

## Loading a library (when touching the body loader, the pull, the list or `format.ts`)

- The list shows from the metadata; bodies download in the background (`BodyLoader`, four at a time, newest first, an opened note first), attachments when first shown (`AppModel.attachmentUrl` asks `loadAttachment`, once per library; the editor redraws on `attachmentsVersion`).
- A body arriving is a `{ kind: 'body', id }` library change: it redraws only the open note (or search results while searching), never the list, counts or notebooks. A pull page's metadata is opened in one worker call. `format.ts` keeps its `Intl.DateTimeFormat`s (making one per row per redraw was the 1,000-note stall).
- A note whose body hasn't arrived shows "Loading this note…" and its body is read-only (`openNoteLoading`), also when the download failed; a title edit then saves the title alone, never the placeholder body.
- Another device's change to the **open** note never makes it read-only: the pull downloads its body with the metadata (`Library.wantsBody`), typing not saved yet goes in first as a local change (`watchRemote` `beforeWrite`, so the conflict rules keep both texts, the one typed here as a conflict copy), and the editor shows the new text when nothing was pending (`NoteEditor`, `known`). `tests/unit/remote-while-typing.test.ts`, `tests/cloud/remote-edit.spec.ts`.
- A body download that finishes after the loader stopped (lock, sign-out) is dropped. "Download all notes (.zip)" downloads every body and used attachment first and refuses (`ExportIncomplete`) rather than save an empty file.
- With Keep off, while the engine says offline, a banner says "You're offline. Changes are only in this tab until the connection is back."; the browser's `online`/`offline` events sync at once, so it comes and goes promptly. The demo-notes offer waits for the first successful pass of the sign-in (the engine's `afterPass(ok)`), so a demo tag joins the account's tag of the same name.
- Speed: `tests/cloud/load-speed.spec.ts` (`@speed`) seeds 1,000 notes, logs in, types in a new note while the bodies arrive and after, and asserts the editor bars for both. 2026-11-13, M2 Pro: list of 1,000 in 3.9 s (Chromium) / 4.4 s (WebKit) from "Log in"; every body in 12.6 s / 10.3 s; keystrokes while loading median 3.0 / p99 4.7 ms (Chromium), 5.0 / 10.0 ms (WebKit). Before Task 12 the list hadn't reached 1,000 rows after 60 s.

## Sync tests (when touching the engine, the session, conflicts or Settings › Sync)

- `tests/cloud/sync.spec.ts`: two devices on one account, both ways, through the local Feather Cloud. Device A is the test's page; device B is `leaks.newContext()` (another browser, leak-checked like the first). Hiding a tab (`hide(page)`, a fake `visibilitychange`) syncs it at once; `pullUntil(page, check)` hides and retries until the other side's change is in. `context.setOffline(true)` takes a device offline.
- What it covers: a note, notebook, tag and attachment from A appear in B and B's edits come back; a forced conflict (both offline, "apples" in A, "pears" in B, A syncs first) leaves A's text in the note and exactly one copy `Groceries (conflict, <B's "<browser> on <system>">, <d MMM HH:mm>)` holding B's, on both; B typing one key at a time while A's edit to another paragraph arrives loses no key (each typed key is in the note or a conflict copy, in order; both devices end with the same texts); a session signed out from the other device keeps its offline edit and pushes it after "Sign in again as <email>"; an attachment's bytes (256 KB random) have the same SHA-256 after the round trip; and `1000 notes: unlock under 2 s` (`@speed`).
- The unlock bar: a kept vault (all 1,000 bodies in, Keep on, reload), timed from the click on "Unlock" to the frame with all 1,000 rows, three runs, each under 2 s, and no body downloaded again after the reloads. 2026-11-13, M2 Pro: 628–660 ms (Chromium), 684–703 ms (WebKit); Argon2id alone is about 0.55 s of it ("Argon2id in browsers").

### Mac interop hand check (the user's; Phase 20 exit criterion)

The Mac app and a browser, one account, both against the local server. Where the Mac facts come from (`apple/`):

- Settings › Advanced has a "Server address" field and a "Connect to Server" button: `FeatherNote/Settings/AdvancedSettingsView.swift`.
- Plain `http` is accepted for `localhost` and `127.0.0.1` only: `Packages/FeatherSync/Sources/FeatherSync/API/CloudServer.swift`.
- A launch with `-FeatherLibraryPath` is an isolated run (`FeatherNote/App/LibraryLocation.swift`, `FeatherNote/App/AppDelegate.swift`). It uses its own defaults suite and keeps secrets in memory (`Packages/FeatherAppModel/Sources/FeatherAppModel/CloudModel.swift`, `CloudEnvironment.live(isolated:)`), so it never touches the real library, settings or Keychain, and its sign-in lasts until it quits.
- The Mac's device name is its computer name (`CloudModel.swift`, `defaultDeviceName`).
- "Try Again" at the foot of the sidebar syncs after a failure: `FeatherNote/Views/Sidebar/SyncStatusFooter.swift`, `Packages/FeatherAppModel/Sources/FeatherAppModel/SyncStatusText.swift`.

Every command below is one line and works from any directory: each one runs in a subshell or uses absolute paths. Step 2 keeps running, so give it its own terminal tab. Run everything else in a second tab.

1. Start the server:

```bash
(export PATH="$HOME/.orbstack/bin:$PATH"; cd /Users/raduh/Dropbox/hosts/devsite/projects/feather-note/server && FEATHER_TRUST_PROXY=true FEATHER_ALLOWED_ORIGINS=http://localhost:8431 docker compose -f deploy/docker-compose.yml up -d --wait)
```

2. **In its own terminal tab**, serve the web app's accounts build on 8431. Leave it running until step 7:

```bash
(cd /Users/raduh/Dropbox/hosts/devsite/projects/feather-note/pwa && export VITE_FEATHER_CLOUD_URL=http://localhost:8420 && pnpm exec vite build --outDir dist-cloud --emptyOutDir && pnpm exec vite preview --outDir dist-cloud --port 8431 --strictPort)
```

3. Build the Mac app (debug) and open it on a throwaway library:

```bash
(cd /Users/raduh/Dropbox/hosts/devsite/projects/feather-note/apple && xcodegen generate && xcodebuild build -project FeatherNote.xcodeproj -scheme FeatherNote -configuration Debug -derivedDataPath build -quiet)
```

```bash
mkdir -p /tmp/feathermark-interop && open -n /Users/raduh/Dropbox/hosts/devsite/projects/feather-note/apple/build/Build/Products/Debug/FeatherMark.app --args -FeatherLibraryPath /tmp/feathermark-interop
```

4. In the Mac app, open Settings › Advanced. Enter `http://localhost:8420` in "Server address" and click "Connect to Server". Then open Settings › Sync › "Create Account…" and use an address such as `interop-1@example.com` with a password of your choice. Get the verification code from the server's log:

```bash
(export PATH="$HOME/.orbstack/bin:$PATH"; docker compose -f /Users/raduh/Dropbox/hosts/devsite/projects/feather-note/server/deploy/docker-compose.yml logs --no-log-prefix server | grep "mail to interop-1@example.com" | tail -1)
```

5. In Safari or Chrome, open `http://localhost:8431/login` and log in with the same address and password.
6. Check each of these, comparing both sides each time. Switching away from the browser tab syncs it at once. The Mac syncs a few seconds after an edit, and "Try Again" at the foot of its sidebar syncs it after a failure.
   - A note written on the Mac, with a picture dropped into it, shows in the browser with its text and picture. A note written in the browser, with a file pasted into it, shows on the Mac. Download the file on the other side and compare it with the original (`shasum -a 256 <file>` on both).
   - A notebook and a tag made on either side appear on the other.
   - A forced conflict, each way. Both apps run on this Mac, so turning off Wi-Fi doesn't take them offline (`localhost` stays up); stop the server instead. Open the same note on both sides, then stop the server:

```bash
(export PATH="$HOME/.orbstack/bin:$PATH"; docker compose -f /Users/raduh/Dropbox/hosts/devsite/projects/feather-note/server/deploy/docker-compose.yml stop server)
```

   Type different words into the note on each side. Wait until both say they can't sync (the Mac's sidebar shows "Couldn't sync"). Start the server again:

```bash
(export PATH="$HOME/.orbstack/bin:$PATH"; docker compose -f /Users/raduh/Dropbox/hosts/devsite/projects/feather-note/server/deploy/docker-compose.yml start server)
```

   Sync the Mac first with "Try Again" and wait until it says it synced. Then switch away from the browser tab and back. Both sides should end with the Mac's text in the note and exactly one copy titled `<title> (conflict, <browser> on macOS, <d MMM HH:mm>)` holding the browser's words; the browser name is, for example, "Chrome" or "Safari". Repeat with the browser synced first: the copy then names the Mac by its computer name (System Settings › General › About › Name) and holds the Mac's words.
7. Stop the preview with Ctrl+C in its tab and quit the Mac app. Then stop the server, keeping its volumes:

```bash
(export PATH="$HOME/.orbstack/bin:$PATH"; docker compose -f /Users/raduh/Dropbox/hosts/devsite/projects/feather-note/server/deploy/docker-compose.yml down)
```

```bash
trash /tmp/feathermark-interop
```

## Before pushing

CI is manual-only (`../AGENTS.md`, "GitHub Actions"). Run `bash scripts/test_all.sh` and report "CI green, run locally". On macOS it runs Chromium and WebKit only: Playwright's Firefox does not start on macOS 27.2 ("Could not find profile folder", 2026-11-12). CI on Linux runs all three. Check Firefox-specific work by hand in Firefox until that is fixed.

## Deploying (when publishing the demo to app.feathermark.com)

The demo is published by direct upload of `dist/` to the Cloudflare Pages project `feathermark-app`, so the files that go live are the files the tests ran against. Until accounts are released, build without `VITE_FEATHER_CLOUD_URL`, so the published app is the demo. Publishing is the user's step: ask before running any of these. Deploy a committed, pushed tree, after `bash scripts/test_all.sh` printed `all tests: OK`.

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
- No request to any origin but the page's own. The Feather Cloud origin comes in only through `contentSecurityPolicy({ cloudOrigin })` (from `VITE_FEATHER_CLOUD_URL`).
- Nothing in localStorage, sessionStorage, IndexedDB, cookies or caches. The demo stores nothing. The one sanctioned store is "Keep my notes on this browser": the IndexedDB database `feathermark`, holding the sealed vault only, written only while Keep is on.

## Browser tests (when writing one)

- Import `test` and `expect` from `tests/e2e/fixtures.ts`, never from `@playwright/test`. After each test the fixture fails it on any policy violation not declared with `leaks.expectViolation(pattern)`, any request to another origin not allowed with `leaks.allowForeignRequest(pattern)`, and anything left in browser storage.
- The fixture watches the whole browser context: every page and popup, every navigation, and every worker (a worker's violations are seen from the moment the harness attaches, so a worker should act only on messages). Storage is checked from a fresh page on the app's origin, so closing or leaving the page doesn't hide it.
- `leaks.problems()` lists what teardown would fail on; `leaks.forgive()` lets deliberate leaks through. Only `tests/e2e/harness*.spec.ts` may call `forgive()`: those tests prove the harness still sees each kind of leak.
- Find elements by role and accessible name, never by class. Playwright's role queries don't apply HTML `inert`; to check something is out of reach, check that it sits inside an `[inert]` subtree.
- Screenshots: pass `caret: 'initial'`. In WebKit, Playwright's screenshot still injects an empty `<style>`; `tests/e2e/screens.spec.ts` declares that one violation for WebKit only. Don't copy that into tests that check the app.

## Styles (when adding a stylesheet or a component)

- Colours only through the variables in `src/ui/tokens.css` (`--c-*`, `--icon-*`); a unit test fails on any colour literal elsewhere. Sizes, spacing and radii also come from it where a token exists.
- The shell (`App.tsx`, `shell.css`; design `../universal/design/handoff/screens/web-shell-redesign.dc.html`) is a CSS grid of areas. From 1000 px: a 232 px column of the app bar, the library (no panel, straight on the window) and the side foot (the demo card, or the sync line and account menu), beside the stage, whose one glass sheet (`.panel.sheet`) holds the list and the open note from the top of the window to the bottom. Each piece is rendered once; widths only move it between grid areas, never render it twice.
- Widths: the library column from 1000 px; the library is a drawer from 640 to 999 px, with "New note" in the bottom bar and the demo card as a strip under the app bar; one column below 640 px with 44 px targets. Light and dark follow the system.
- While the drawer is open, everything outside it is `inert`: the app bar, the side foot, the stage and the bottom bar. It closes when the window reaches 1000 px. New content behind the drawer must sit inside one of those inert containers.
- Positioned grid areas paint above the glows (`.glow` is absolute); a new area needs `position: relative` or the mint glow covers it.
- Quick actions (`QuickActions.tsx`, Ctrl/⌘+K or the app bar's search button) are a modal `<dialog>` holding the "Search all notes" field. They list note titles, so `App.tsx` closes them in the same layout effect as `closeDialogsNotOn` whenever the notes leave the screen (lock, sign-out, an account screen). "This note" is the note open when they opened.
- The library's Tags section is folded at load; whether it is open lives in a signal in memory only (`LibraryPanel.tsx`), so a reload folds it again. It also shows while a tag is the selected view.
- Fonts are the system stacks in `--font-serif`, `--font-sans`, `--font-mono`. No web fonts.

## When `tokens.json` changes

`pnpm tokens`, then `pnpm test`. `scripts/test_all.sh` fails while `tokens.css` is stale.

## Dependencies (when adding one)

Exact versions only, the lockfile committed, `pnpm install --frozen-lockfile` in scripts. Name the dependency and the reason in the phase plan. Today: `preact`, `@preact/signals`, `hash-wasm` (Argon2id in WebAssembly), `@noble/hashes` (keyed BLAKE2b for the key derivations and the recovery checksum) and `@noble/ciphers` (XChaCha20-Poly1305 for wrapped keys and envelopes; Phase 20: audited, pure TypeScript, no WebAssembly, and Web Crypto has neither primitive), CodeMirror 6 for the note editor (`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/language`, `@lezer/markdown`, `@lezer/common`; Phase 19); dev: `vite`, `@preact/preset-vite`, `typescript`, `vitest`, `@playwright/test`, `@types/node`, `argon2id` (the Argon2id test page only), `fake-indexeddb` 6.2.6 (Phase 20: IndexedDB in Node, so the kept-copy store and the session's Keep tests run in Vitest; released 2026-10-16, more than two weeks before it was added).

**Patched: `style-mod`** (`patches/style-mod@4.1.4.patch`, applied by pnpm on install). CodeMirror injects its base theme through `style-mod`, which writes a `<style>` tag on a normal page; the policy refuses inline styles, so the editor would lose its own styles. The patch makes it use a constructed stylesheet (`document.adoptedStyleSheets`, in every browser we support), which the policy allows. When CodeMirror or `style-mod` is upgraded, re-apply or drop the patch and run `tests/e2e/editor-policy.spec.ts`: it fails on any `<style>` tag or policy violation.

**Patched: `@lezer/markdown`** (`patches/@lezer__markdown@1.8.1.patch`). Closing a link walked back over every earlier part of its paragraph to cancel open `[` markers, so a paragraph of many links was quadratic: a pasted 2 MB line took 50 s to parse. The patch stops at the previous link (every marker before it was cancelled when it closed, for good). Pinned by `many links in one paragraph parse in linear time` (`tests/unit/editor-document.test.ts`) and `a 2 MB line opens` (`tests/e2e/editor-speed.spec.ts`). Offer the fix upstream; drop the patch once a release has it.

## Crypto (when touching `src/core/crypto` or the worker)

- `../universal/specs/crypto.md` is normative. Only `ARGON2_V1` (`argon2id13`, t 3, 256 MiB, p 1, 16-byte salt) is accepted; anything else is refused before hashing.
- Load vector values from `../universal/test-vectors/`; never copy them into code.
- Crypto runs in `src/worker/crypto.worker.ts`. Every call through `createCryptoClient()` settles: it rejects when the worker reports an error, fails to load, dies, is stopped, or gives no answer within 60 s, and once the worker is gone later calls reject at once. Tests pass a fake worker through the `worker` option.
- **Keys stay in the worker.** The master key, `root`, `kek`, `recovery_kek` and the recovery key never reach the page: the worker's key store (`src/worker/keyring.ts`, tested in Node) holds master keys and keks behind numeric handles (`session`, `kek`). The page gets auth keys, wrapped keys, salts, envelopes and plaintext. `unwrap(wrapped, kek, kind)` makes a session from a kek handle; `forget(handle)` drops a session's master key with every kek handle it was unlocked with, or a single kek handle (one from a failed log-in, say), and wipes the bytes. Drop key bytes with `.fill(0)` wherever the worker holds them.
- **The client API** (`src/worker/crypto-protocol.ts` has the types): `signUpKeys(password)`, `logInKeys(password, salt, kdf)`, `unwrap(wrapped, kek, kind)`, `recoveryKeys(text)`, `newPassword(session, password)`, `seal(session, SealRequest[])`, `open(session, OpenRequest[])` (each item's plaintext or `{ error: kind }`), `forget(handle)`. A worker error comes back as the same class: `CryptoError` with its `kind`, a `TypeError` for invalid arguments.
- **Errors** (`src/core/crypto/errors.ts`): data from a server, file or the user fails with `CryptoError` of kind `'authentication'`, `'malformed'` or `'typo'` (the vectors' `authentication_failed`, `malformed_envelope`, `recovery_key_typo`). The caller's own mistakes (a non-ULID id, a key of the wrong length, an unknown part or kind) throw `InvalidArgument`, a `TypeError`, before any crypto runs.
- **Vectors:** each vector file has a unit test (`tests/unit/crypto-{kdf,wrap,envelope,recovery}.test.ts`, `argon2.test.ts`), and `tests/e2e/crypto-vectors.spec.ts` runs them all in Chromium and WebKit under the policy through the spike page `/spike/vectors.html`: the pure functions in a test worker, then the account chain (log in, unwrap, open, recover) through the app's crypto worker. `tests/shared/` holds the case shapes and runner both share. The Argon2id device page checks the app's build by the auth key its root gives, since the root stays in the worker.
- **First load:** the worker, `hash-wasm` and the noble modules load only through `new Worker(...)` or `import()`. `scripts/bundle-size.ts --check` fails if their strings show up in the first load.

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
for d in .git/index node_modules dist dist-cloud test-results playwright-report; do [ -e "$d" ] && xattr -w com.dropbox.ignored 1 "$d"; done
```

`scripts/test_all.sh` re-applies it to the build folders when it ends.
