import { defineConfig, devices } from '@playwright/test'

// FEATHER_ENGINES picks the engines, e.g. "chromium,webkit". Playwright's Firefox does not start on
// macOS 27.2 ("Could not find profile folder", 2026-11-12), so scripts/test_all.sh leaves it out there.
const engines = (process.env.FEATHER_ENGINES ?? 'chromium,firefox,webkit').split(',')
const all = [
  { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  { name: 'webkit', use: { ...devices['Desktop Safari'] } },
]

// FEATHER_LIVE_URL (e.g. https://app.feathermark.com) runs tests/live/ against the published demo instead: no
// local server, the same leak fixture.
const live = process.env.FEATHER_LIVE_URL

export default defineConfig(
  live
    ? {
        testDir: 'tests/live',
        outputDir: 'test-results',
        use: { baseURL: live },
        projects: all.filter((p) => engines.includes(p.name)),
      }
    : {
        testDir: 'tests/e2e',
        outputDir: 'test-results',
        use: { baseURL: 'http://localhost:8431' },
        projects: all.filter((p) => engines.includes(p.name)),
        webServer: {
          command: 'FEATHER_SPIKE=1 pnpm build && pnpm preview',
          url: 'http://localhost:8431',
          reuseExistingServer: false,
        },
      },
)
