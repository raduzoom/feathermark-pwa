import preact from '@preact/preset-vite'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import { headersFile, securityHeaders } from './scripts/policy.ts'

const pagesHeaders: Plugin = {
  name: 'feather-pages-headers',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: '_headers', source: headersFile() })
  },
}

const root = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const spike = process.env.FEATHER_SPIKE === '1'

export default defineConfig({
  plugins: [preact(), pagesHeaders],
  resolve: { alias: { '@vectors': root('../universal/test-vectors') } },
  build: {
    assetsInlineLimit: 0,
    rollupOptions: {
      // The Argon2id device page is built only on request (FEATHER_SPIKE=1), never in a normal build.
      input: spike ? { main: root('index.html'), spike: root('spike/argon2.html') } : { main: root('index.html') },
    },
  },
  worker: { format: 'es' },
  server: { fs: { allow: ['.', '../universal/test-vectors'] } },
  preview: { headers: securityHeaders() },
  test: { include: ['tests/unit/**/*.test.ts'] },
})
