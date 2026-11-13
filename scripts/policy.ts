// The security headers, in one place. The preview server sends them and the build writes them to
// dist/_headers for Cloudflare Pages, so the tests run under the headers production sends.

export type PolicyOptions = { cloudOrigin?: string }

const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i
const LOCAL_HTTP_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i

function isCloudOrigin(origin: string): boolean {
  return HTTPS_ORIGIN.test(origin) || LOCAL_HTTP_ORIGIN.test(origin)
}

/** The Feather Cloud origin from VITE_FEATHER_CLOUD_URL, or null: no address means no accounts, the plain demo.
 *  An origin only (no path); `https:`, or `http:` for localhost and 127.0.0.1. */
export function cloudOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.VITE_FEATHER_CLOUD_URL
  if (value === undefined || value === '') return null
  if (!isCloudOrigin(value)) throw new Error('cloudOrigin must be an https origin (http only for localhost or 127.0.0.1)')
  return value
}

export function contentSecurityPolicy(opts: PolicyOptions = {}): string {
  let connect = "'self'"
  if (opts.cloudOrigin !== undefined) {
    if (!isCloudOrigin(opts.cloudOrigin)) throw new Error('cloudOrigin must be an https origin (http only for localhost or 127.0.0.1)')
    connect += ` ${opts.cloudOrigin}`
  }
  return [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    "img-src 'self' blob:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

export function securityHeaders(opts: PolicyOptions = {}): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(opts),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  }
}

/** Cloudflare Pages `_headers` text: the security headers for every path, and a year's caching for the hashed
 *  files under /assets/ (their names change with their content). The page itself keeps Pages' default, which
 *  revalidates, so a new deployment is seen at once. */
export function headersFile(opts: PolicyOptions = {}): string {
  const lines = Object.entries(securityHeaders(opts)).map(([name, value]) => `  ${name}: ${value}`)
  return ['/*', ...lines, '/assets/*', '  Cache-Control: public, max-age=31536000, immutable'].join('\n') + '\n'
}
