// The notebook dot's colour: one of --c-notebook-1…4, by the top-level notebook's place in the library's order
// (sorted by name), so a notebook and everything below it share one colour, the same on every load. (A hash of the id
// changed with every demo load, whose ids are new each time.)
import type { Notebook } from '../core/library/types.ts'

const TINTS = 4

/** Each notebook's id mapped to its name and its top-level notebook's tint. Built once per render, not per row. */
export function notebookInfo(notebooks: Notebook[]): Map<string, { name: string; tint: number }> {
  const byId = new Map(notebooks.map((n) => [n.id, n]))
  const topTint = new Map<string, number>()
  for (const nb of notebooks) if (nb.parentId === null) topTint.set(nb.id, topTint.size % TINTS)
  const out = new Map<string, { name: string; tint: number }>()
  for (const nb of notebooks) {
    let top = nb
    for (let depth = 0; top.parentId && byId.has(top.parentId) && depth < notebooks.length; depth++) top = byId.get(top.parentId)!
    out.set(nb.id, { name: nb.name, tint: topTint.get(top.id) ?? 0 })
  }
  return out
}
