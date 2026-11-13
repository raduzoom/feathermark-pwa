import { expect, test } from 'vitest'
import { deviceName } from '../../src/core/sync/device-name.ts'

const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'
const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
const EDGE_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0'
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
const SAFARI_IPAD = 'Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

test('names the browser and system from the user agent', () => {
  expect(deviceName({ userAgent: SAFARI_MAC })).toBe('Safari on macOS')
  expect(deviceName({ userAgent: CHROME_ANDROID })).toBe('Chrome on Android')
  expect(deviceName({ userAgent: EDGE_WIN })).toBe('Edge on Windows')
  expect(deviceName({ userAgent: FIREFOX_LINUX })).toBe('Firefox on Linux')
  expect(deviceName({ userAgent: SAFARI_IPHONE })).toBe('Safari on iOS')
  expect(deviceName({ userAgent: SAFARI_IPAD })).toBe('Safari on iOS')
})

test('Chrome is not mistaken for Safari, nor Edge for Chrome', () => {
  expect(deviceName({ userAgent: CHROME_MAC })).toBe('Chrome on macOS')
  expect(deviceName({ userAgent: EDGE_WIN })).toBe('Edge on Windows')
})

test('user agent data wins when present', () => {
  const userAgentData = { brands: [{ brand: 'Not A;Brand' }, { brand: 'Chromium' }, { brand: 'Microsoft Edge' }], platform: 'Windows' }
  expect(deviceName({ userAgent: CHROME_MAC, userAgentData })).toBe('Edge on Windows')
  expect(deviceName({ userAgent: CHROME_MAC, userAgentData: { brands: [{ brand: 'Google Chrome' }], platform: 'macOS' } })).toBe('Chrome on macOS')
})

test('anything unrecognised is "Browser on this computer"', () => {
  expect(deviceName({ userAgent: '' })).toBe('Browser on this computer')
  expect(deviceName({ userAgent: 'curl/8.0' })).toBe('Browser on this computer')
})
