// Draws the sample note's picture (DemoLibrary.swift's shieldImage: sky, hill and a white post, 640×360) into a
// PNG and writes it, as base64 with its SHA-256, to src/core/library/sample-image.ts. The app decodes the bytes
// itself (no data: URL, no request). Run: node scripts/sample-image.ts
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const W = 640
const H = 360
const rgb = (r: number, g: number, b: number): [number, number, number] => [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
const SKY = rgb(0.86, 0.9, 0.95)
const HILL = rgb(0.55, 0.66, 0.56)
const WHITE = rgb(1, 1, 1)
const POST = rgb(0.35, 0.38, 0.4)

function colour(x: number, y: number): [number, number, number] {
  const px = x + 0.5
  const py = y + 0.5
  // the post, then the shield (a rounded rectangle), then the hill (an ellipse), then the sky
  if (px >= 314 && px < 326 && py >= 160 && py < 270) return POST
  const [rx, ry, rw, rh, r] = [280, 90, 80, 70, 10]
  if (px >= rx && px < rx + rw && py >= ry && py < ry + rh) {
    const cx = Math.min(Math.max(px, rx + r), rx + rw - r)
    const cy = Math.min(Math.max(py, ry + r), ry + rh - r)
    if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) return WHITE
  }
  const [ex, ey, ew, eh] = [-160, 230, 960, 320]
  if (((px - (ex + ew / 2)) / (ew / 2)) ** 2 + ((py - (ey + eh / 2)) / (eh / 2)) ** 2 <= 1) return HILL
  return SKY
}

const raw = Buffer.alloc((W * 3 + 1) * H)
for (let y = 0; y < H; y++) {
  const row = y * (W * 3 + 1)
  raw[row] = 0 // filter: none
  for (let x = 0; x < W; x++) raw.set(colour(x, y), row + 1 + x * 3)
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr.set([8, 2, 0, 0, 0], 8) // 8-bit RGB, no interlace
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const out = new URL('../src/core/library/sample-image.ts', import.meta.url)
writeFileSync(
  out,
  `// Written by scripts/sample-image.ts; don't edit. The sample note's picture (DemoLibrary.swift's shieldImage).\n` +
    `export const RADIATION_SHIELD_PNG_BASE64 =\n  '${png.toString('base64')}'\n` +
    `export const RADIATION_SHIELD_PNG_SHA256 = '${createHash('sha256').update(png).digest('hex')}'\n`,
)
console.log(`radiation-shield.png: ${png.length} bytes`)
