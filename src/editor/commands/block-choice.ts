// The blocks the block menu can insert (BlockChoice.swift), and the menu's query and selection
// (BlockMenuState.swift). Every choice is plain Markdown.

export type BlockChoiceId = 'heading1' | 'heading2' | 'heading3' | 'bulleted' | 'numbered' | 'todo' | 'quote' | 'divider' | 'code' | 'imageOrFile' | 'scan'
export type BlockChoice = { id: BlockChoiceId; title: string; hint: string; aliases: string[]; textBlock: boolean }

export const BLOCK_CHOICES: readonly BlockChoice[] = [
  { id: 'heading1', title: 'Heading 1', hint: '#', aliases: ['h1', 'title'], textBlock: true },
  { id: 'heading2', title: 'Heading 2', hint: '##', aliases: ['h2'], textBlock: true },
  { id: 'heading3', title: 'Heading 3', hint: '###', aliases: ['h3'], textBlock: true },
  { id: 'bulleted', title: 'Bulleted list', hint: '-', aliases: ['ul', 'bullet'], textBlock: true },
  { id: 'numbered', title: 'Numbered list', hint: '1.', aliases: ['ol', 'ordered'], textBlock: true },
  { id: 'todo', title: 'To-do list', hint: '[ ]', aliases: ['todo', 'task', 'checkbox'], textBlock: true },
  { id: 'quote', title: 'Quote', hint: '>', aliases: ['blockquote'], textBlock: true },
  { id: 'divider', title: 'Divider', hint: '---', aliases: ['hr', 'rule', 'line', 'separator'], textBlock: false },
  { id: 'code', title: 'Code block', hint: '```', aliases: ['pre', 'snippet'], textBlock: false },
  { id: 'imageOrFile', title: 'Image or file', hint: '', aliases: ['attachment', 'photo', 'picture', 'pdf'], textBlock: false },
  { id: 'scan', title: 'Scan from iPhone', hint: '', aliases: ['camera', 'document', 'ipad'], textBlock: false },
]

export const choice = (id: BlockChoiceId): BlockChoice => BLOCK_CHOICES.find((c) => c.id === id)!

const words = (s: string) => s.toLowerCase().split(' ').filter((w) => w !== '')
const characters = (s: string) => [...new Intl.Segmenter().segment(s)].length

/** The choices whose title or alias words start with every word of `query` (case-insensitive), in menu order. An
 *  alias needs two typed characters, so "h" means the headings and not "hr". */
export function matching(query: string): BlockChoiceId[] {
  if (query.startsWith(' ')) return []
  const typed = words(query)
  return BLOCK_CHOICES.filter((c) => {
    const titleWords = words(c.title)
    return typed.every((w) => titleWords.some((t) => t.startsWith(w)) || (characters(w) >= 2 && c.aliases.some((a) => a.startsWith(w))))
  }).map((c) => c.id)
}

export class BlockMenuState {
  static readonly maxQueryLength = 24
  query = ''
  items: BlockChoiceId[]
  selected = 0

  /** `hidden`: the choices this platform doesn't offer (the web: Scan from iPhone). */
  constructor(readonly hidden: ReadonlySet<BlockChoiceId> = new Set()) {
    this.items = BLOCK_CHOICES.map((c) => c.id).filter((id) => !hidden.has(id))
  }

  get selection(): BlockChoiceId | null {
    return this.items[this.selected] ?? null
  }

  /** Filters by `query` and selects the first row. False, leaving the state as it was, when the menu should close
   *  instead: nothing matches, the query starts with a space, or it's too long. */
  setQuery(query: string): boolean {
    if (characters(query) > BlockMenuState.maxQueryLength || query.startsWith(' ')) return false
    const matches = matching(query).filter((id) => !this.hidden.has(id))
    if (matches.length === 0) return false
    this.query = query
    this.items = matches
    this.selected = 0
    return true
  }

  /** Moves the selection, wrapping at either end. */
  move(delta: number) {
    const n = this.items.length
    if (n === 0) return
    this.selected = (((this.selected + delta) % n) + n) % n
  }
}
