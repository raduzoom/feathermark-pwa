#!/usr/bin/env bash
# Every check, in order; stops at the first failure. Prints "all tests: OK" last.
# FEATHER_ENGINES picks the browser engines (default: all three; chromium,webkit on macOS, where
# Playwright's Firefox does not start as of macOS 27.2).
set -euo pipefail
cd "$(dirname "$0")/.."

flag() { for d in node_modules dist dist-cloud test-results playwright-report; do [ -e "$d" ] && xattr -w com.dropbox.ignored 1 "$d" 2>/dev/null || true; done; }
trap flag EXIT

if [ -z "${FEATHER_ENGINES:-}" ]; then
  if [ "$(uname)" = Darwin ]; then
    export FEATHER_ENGINES=chromium,webkit
    echo "note: Firefox skipped on macOS (Playwright's Firefox does not start here); CI runs it"
  else
    export FEATHER_ENGINES=chromium,firefox,webkit
  fi
fi

step() { echo "== $*"; }

step install;      pnpm install --frozen-lockfile
step typecheck;    pnpm exec tsc --noEmit
step "design system"; node scripts/design-system.ts --check
step unit;         pnpm test
step build;        pnpm build
step headers;      test -f dist/_headers
step no-spike;     test ! -e dist/spike
step bundle-size;  node scripts/bundle-size.ts --check
step "e2e ($FEATHER_ENGINES)"; pnpm e2e --grep-invert @speed
# timing tests alone, one worker: other workers running beside them skew the numbers
step "speed ($FEATHER_ENGINES)"; pnpm e2e --grep @speed --workers=1

# the accounts build against a local Feather Cloud on 8420 (AGENTS.md, "Local Feather Cloud")
if curl -sS -o /dev/null --max-time 3 http://localhost:8420/ 2>/dev/null; then
  step "cloud ($FEATHER_ENGINES)"; pnpm e2e:cloud --grep-invert @speed
  # the kept copy at 1,000 notes, alone on one worker, as the editor's timing tests
  step "cloud speed ($FEATHER_ENGINES)"; pnpm e2e:cloud --grep @speed --workers=1
  # the accounts build (dist-cloud/, made by e2e:cloud) holds the same first-load promise as the demo
  step "bundle-size (accounts build)"; node scripts/bundle-size.ts --check --dir dist-cloud
else
  step cloud; echo "skipped: no local server"
fi

echo "all tests: OK"
