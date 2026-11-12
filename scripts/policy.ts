// The security headers, in one place. The preview server sends them and the build writes them to
// dist/_headers for Cloudflare Pages, so the tests run under the headers production sends.

export type PolicyOptions = { cloudOrigin?: string }

export function contentSecurityPolicy(opts: PolicyOptions = {}): string {
  let connect = "'self'"
  if (opts.cloudOrigin !== undefined) {
    if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(opts.cloudOrigin)) throw new Error('cloudOrigin must be an https origin')
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

/** Cloudflare Pages `_headers` text for every path. */
export function headersFile(opts: PolicyOptions = {}): string {
  const lines = Object.entries(securityHeaders(opts)).map(([name, value]) => `  ${name}: ${value}`)
  return ['/*', ...lines].join('\n') + '\n'
}
