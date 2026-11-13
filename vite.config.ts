import preact from '@preact/preset-vite'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import { cloudOrigin, headersFile, securityHeaders, type PolicyOptions } from './scripts/policy.ts'

const pagesHeaders = (options: PolicyOptions): Plugin => ({
  name: 'feather-pages-headers',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: '_headers', source: headersFile(options) })
  },
})

const root = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const spike = process.env.FEATHER_SPIKE === '1'

export default defineConfig(({ mode }) => {
  // VITE_FEATHER_CLOUD_URL (from the environment or a .env file) turns accounts on and opens the policy to that origin.
  const origin = cloudOrigin(loadEnv(mode, process.cwd(), 'VITE_'))
  const policy: PolicyOptions = origin === null ? {} : { cloudOrigin: origin }
  return {
    plugins: [preact(), pagesHeaders(policy)],
    resolve: { alias: { '@vectors': root('../universal/test-vectors') } },
    build: {
      assetsInlineLimit: 0,
      rollupOptions: {
        // The test pages (Argon2id, crypto vectors) are built only on request (FEATHER_SPIKE=1), never in a normal build.
        input: (spike
          ? { main: root('index.html'), spike: root('spike/argon2.html'), vectors: root('spike/vectors.html') }
          : { main: root('index.html') }) as Record<string, string>,
      },
    },
    worker: { format: 'es' },
    server: { fs: { allow: ['.', '../universal/test-vectors'] } },
    preview: { headers: securityHeaders(policy) },
    test: { include: ['tests/unit/**/*.test.ts'] },
  }
})
