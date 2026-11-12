// WCAG contrast and alpha compositing, for checking token pairs. Colours are #RRGGBB or rgba(r,g,b,a).

type Rgba = [number, number, number, number]

function parse(colour: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour)
  if (hex) {
    const n = parseInt(hex[1]!, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(colour)
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])]
  throw new Error(`not a colour: ${colour}`)
}

function toHex([r, g, b]: Rgba): string {
  return '#' + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** The opaque colour `colour` gives when painted over the opaque `background`. */
export function compositeOver(colour: string, background: string): string {
  const [r, g, b, a] = parse(colour)
  const [br, bg, bb] = parse(background)
  return toHex([r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1])
}

function luminance(colour: string): number {
  const [r, g, b] = parse(colour).map((c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as Rgba
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2 contrast ratio between two opaque colours, from 1 to 21. */
export function contrastRatio(foreground: string, background: string): number {
  const [hi, lo] = [luminance(foreground), luminance(background)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
