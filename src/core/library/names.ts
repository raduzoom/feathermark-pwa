// Name order, tag keys, previews and display titles (data-model.md "Views and sort orders").

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'accent' })

/** Ignores case and character width, compares digits as numbers. Use with a stable sort. */
export function nameOrder(a: string, b: string): number {
  return collator.compare(a.normalize('NFKC'), b.normalize('NFKC'))
}

export function tagKey(name: string): string {
  return name.toLowerCase()
}

/** White-space runs become one space, leading white space goes, then the first 200 characters (code points). */
export function preview(body: string): string {
  let out = ''
  let count = 0
  let pendingSpace = false
  for (const ch of body) {
    if (/\s/u.test(ch)) {
      pendingSpace = count > 0
      continue
    }
    if (pendingSpace) {
      if (count === 200) break
      out += ' '
      count++
      pendingSpace = false
    }
    if (count === 200) break
    out += ch
    count++
  }
  return out
}

export function displayTitle(title: string): string {
  return title.trim() === '' ? 'Untitled' : title
}
