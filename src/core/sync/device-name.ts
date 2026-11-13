// The name this browser gives itself when it signs in (sync-protocol.md, `device_name`): "Safari on macOS".
// The user can see it in the devices list, so it names the browser and system, never anything unique to the person.
type Hints = { userAgent: string; userAgentData?: { brands?: Array<{ brand: string }>; platform?: string } }

const FALLBACK = 'Browser on this computer'

function browserFromBrands(brands: Array<{ brand: string }> | undefined): string | null {
  const names = (brands ?? []).map((b) => b.brand)
  if (names.includes('Microsoft Edge')) return 'Edge'
  if (names.includes('Google Chrome')) return 'Chrome'
  if (names.includes('Firefox')) return 'Firefox'
  return null
}

function browserFromUserAgent(ua: string): string | null {
  if (/\b(OPR|Opera|OPiOS|SamsungBrowser)\b/.test(ua)) return null
  if (/\b(Edg|EdgA|EdgiOS)\//.test(ua)) return 'Edge'
  if (/\b(Firefox|FxiOS)\//.test(ua)) return 'Firefox'
  if (/\b(Chrome|CriOS)\//.test(ua)) return 'Chrome'
  if (/\bSafari\//.test(ua)) return 'Safari'
  return null
}

function systemFromPlatform(platform: string | undefined): string | null {
  switch (platform) {
    case 'macOS': return 'macOS'
    case 'Windows': return 'Windows'
    case 'Android': return 'Android'
    case 'Linux': return 'Linux'
    case 'iOS': return 'iOS'
    default: return null
  }
}

function systemFromUserAgent(ua: string): string | null {
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return 'iOS'
  if (/\bAndroid\b/.test(ua)) return 'Android'
  if (/\bWindows\b/.test(ua)) return 'Windows'
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return 'macOS'
  if (/\bLinux\b|\bX11\b/.test(ua)) return 'Linux'
  return null
}

export function deviceName(n: Hints): string {
  const ua = n.userAgent ?? ''
  const browser = browserFromBrands(n.userAgentData?.brands) ?? browserFromUserAgent(ua)
  const system = systemFromPlatform(n.userAgentData?.platform) ?? systemFromUserAgent(ua)
  return browser && system ? `${browser} on ${system}` : FALLBACK
}
