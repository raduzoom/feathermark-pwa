// The notebook dot's colour: one of --c-notebook-1…4, picked by a hash of the top-level notebook's id, so a notebook
// and everything below it share one colour in the library and the note list.
import type { Notebook } from '../core/library/types.ts'

const TINTS = 4

export function tint(id: string): number {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.codePointAt(0)!) % 1_000_003
  return h % TINTS
}

/** Each notebook's id mapped to its name and its top-level notebook's tint. Built once per render, not per row. */
export function notebookInfo(notebooks: Notebook[]): Map<string, { name: string; tint: number }> {
  const byId = new Map(notebooks.map((n) => [n.id, n]))
  const out = new Map<string, { name: string; tint: number }>()
  for (const nb of notebooks) {
    let top = nb
    for (let depth = 0; top.parentId && depth < notebooks.length; depth++) top = byId.get(top.parentId) ?? top
    out.set(nb.id, { name: nb.name, tint: tint(top.id) })
  }
  return out
}
