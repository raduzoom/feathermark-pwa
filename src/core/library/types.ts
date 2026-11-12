export type Origin = 'sample' | 'user'

export type Note = {
  id: string
  title: string
  body: string
  notebookId: string | null
  tagIds: string[]
  pinned: boolean
  created: number
  modified: number
  trashedAt: number | null
  origin: Origin
}
export type NoteSummary = Omit<Note, 'body' | 'tagIds'> & { preview: string }
export type Notebook = { id: string; name: string; parentId: string | null; created: number; modified: number; origin: Origin }
export type Tag = { id: string; name: string; created: number; modified: number; origin: Origin }
export type View = { kind: 'all' | 'recent' | 'pinned' | 'trash' } | { kind: 'notebook'; id: string } | { kind: 'tag'; id: string }
export type Counts = { all: number; pinned: number; trash: number; notebooks: Map<string, number> }
export type SearchHit = { note: NoteSummary; snippet: string; matches: Array<[start: number, end: number]> }

export type LibraryErrorKind = 'notFound' | 'notebookCycle' | 'duplicateTagName' | 'invalidName'
export class LibraryError extends Error {
  override name = 'LibraryError'
  constructor(
    readonly kind: LibraryErrorKind,
    readonly detail?: string,
  ) {
    super(detail ? `${kind}: ${detail}` : kind)
  }
}
