// Live preview as CodeMirror decorations: the marks from planPreview, built for the visible lines only, so a long
// note costs what its viewport costs. Hidden markers are replaced (not removed) and atomic, so the caret skips
// them; the text in the editor is always the note's exact Markdown.
import { isolateHistory } from '@codemirror/commands'
import { defineLanguageFacet, Language, LanguageSupport, syntaxTree } from '@codemirror/language'
import { Facet, type EditorState, type Extension, type Range as CMRange } from '@codemirror/state'
import { textOfDoc } from './doc-text.ts'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { CODE_LANGUAGES, setCodeLanguage, toggleCheckbox } from './commands/index.ts'
import { documentFromTree, type Block } from './markdown/document.ts'
import { limitedMarkdownParser } from './markdown/parser.ts'
import { planPreview, type Mark } from './preview-plan.ts'

/** The note's Markdown as a CodeMirror language (CommonMark + GFM, nesting-limited). */
export const markdownLanguage = new Language(defineLanguageFacet(), limitedMarkdownParser, [], 'markdown')
export const markdown = (): Extension => new LanguageSupport(markdownLanguage)

/** Raw mode ("Markdown" pressed): every character shown, nothing drawn. */
export const rawMode = Facet.define<boolean, boolean>({ combine: (v) => v.some(Boolean) })

export type ResolvedAttachment = { objectUrl: string; filename: string; mime: string; image: boolean }
/** Turns a `feather://attachment/<id>` URL into the file to draw or open; null when the library doesn't have it. */
export const attachmentResolver = Facet.define<(url: string) => ResolvedAttachment | null, (url: string) => ResolvedAttachment | null>({
  combine: (v) => v[0] ?? (() => null),
})
/** Opens an attachment (a chip's click). */
export const attachmentOpener = Facet.define<(url: string) => void, (url: string) => void>({ combine: (v) => v[0] ?? (() => {}) })

export function docText(state: EditorState): string {
  return textOfDoc(state.doc)
}

class BulletWidget extends WidgetType {
  override eq() {
    return true
  }
  toDOM() {
    const s = document.createElement('span')
    s.className = 'cm-bullet'
    s.setAttribute('aria-hidden', 'true')
    s.textContent = '•'
    return s
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  override eq(o: CheckboxWidget) {
    return o.checked === this.checked
  }
  toDOM(view: EditorView) {
    const s = document.createElement('span')
    s.className = 'cm-checkbox' + (this.checked ? ' cm-checkbox-on' : '')
    s.setAttribute('role', 'checkbox')
    s.setAttribute('aria-checked', String(this.checked))
    s.setAttribute('aria-label', this.checked ? 'Done' : 'To do')
    s.addEventListener('mousedown', (e) => {
      e.preventDefault()
      if (view.state.readOnly) return
      const pos = view.posAtDOM(s)
      const e2 = toggleCheckbox(docText(view.state), documentFromTree(syntaxTree(view.state), docText(view.state), pos, pos), pos)
      if (e2) view.dispatch({ changes: { from: e2.from, to: e2.to, insert: e2.insert }, annotations: isolateHistory.of('full'), userEvent: 'input.toggle' })
    })
    return s
  }
  override ignoreEvent() {
    return true
  }
}

function badge(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot > 0 && dot < filename.length - 1 ? filename.slice(dot + 1, dot + 5).toUpperCase() : 'FILE'
}

class ChipWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly label: string,
    readonly file: ResolvedAttachment | null,
  ) {
    super()
  }
  override eq(o: ChipWidget) {
    return o.url === this.url && o.label === this.label && o.file?.objectUrl === this.file?.objectUrl
  }
  toDOM(view: EditorView) {
    const s = document.createElement('span')
    const missing = this.file === null
    s.className = 'cm-chip' + (missing ? ' cm-chip-missing' : '')
    s.setAttribute('role', 'link')
    s.setAttribute('aria-label', missing ? `${this.label}, missing attachment` : `${this.file!.filename}, attachment`)
    const b = document.createElement('span')
    b.className = 'cm-chip-badge'
    b.setAttribute('aria-hidden', 'true')
    b.textContent = missing ? '?' : badge(this.file!.filename)
    const l = document.createElement('span')
    l.className = 'cm-chip-label'
    l.setAttribute('aria-hidden', 'true')
    l.textContent = this.label
    s.append(b, l)
    if (!missing) {
      // the caret stays put; the file opens on the click (Chromium starts no download from a mousedown)
      s.addEventListener('mousedown', (e) => e.preventDefault())
      s.addEventListener('click', (e) => {
        e.preventDefault()
        view.state.facet(attachmentOpener)(this.url)
      })
    }
    return s
  }
  override ignoreEvent() {
    return true
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
    readonly file: ResolvedAttachment | null,
  ) {
    super()
  }
  override eq(o: ImageWidget) {
    return o.url === this.url && o.alt === this.alt && o.file?.objectUrl === this.file?.objectUrl
  }
  toDOM(view: EditorView) {
    if (!this.file || !this.file.image) return new ChipWidget(this.url, this.alt || this.file?.filename || 'image', this.file).toDOM(view)
    const wrap = document.createElement('span')
    wrap.className = 'cm-image'
    const img = document.createElement('img')
    img.src = this.file.objectUrl
    img.alt = this.alt || this.file.filename
    img.draggable = false
    // An image the browser can't draw (HEIC in Chrome, for example) shows as a chip.
    img.addEventListener('error', () => wrap.replaceWith(new ChipWidget(this.url, this.alt || this.file!.filename, this.file).toDOM(view)))
    wrap.append(img)
    return wrap
  }
  override ignoreEvent() {
    return false
  }
}

/** A code block's bar (specs/editor.md "Code bar"): the language menu and Copy. */
class CodeBarWidget extends WidgetType {
  constructor(
    readonly language: string | null,
    readonly active: boolean,
  ) {
    super()
  }
  override eq(o: CodeBarWidget) {
    return o.language === this.language && o.active === this.active
  }
  toDOM(view: EditorView) {
    const bar = document.createElement('span')
    bar.className = 'cm-code-bar' + (this.active ? ' cm-code-bar-active' : '')
    const current = this.language ?? ''
    // the label shows the language; a transparent native menu over it picks one
    const picker = document.createElement('span')
    picker.className = 'cm-code-language'
    const label = document.createElement('span')
    label.setAttribute('aria-hidden', 'true')
    label.textContent = CODE_LANGUAGES.find(([, id]) => id === current)?.[0] ?? current
    const select = document.createElement('select')
    select.setAttribute('aria-label', 'Code language')
    const known = CODE_LANGUAGES.some(([, id]) => id === current)
    for (const [label, id] of known ? CODE_LANGUAGES : [[current, current] as const, ...CODE_LANGUAGES]) {
      const o = document.createElement('option')
      o.value = id
      o.textContent = label
      o.selected = id === current
      select.append(o)
    }
    select.disabled = view.state.readOnly
    select.addEventListener('change', () => {
      const pos = view.posAtDOM(bar)
      const text = docText(view.state)
      const sel = view.state.selection.main
      const e = setCodeLanguage(text, documentFromTree(syntaxTree(view.state), text, pos, pos), pos, select.value, sel)
      if (e) view.dispatch({ changes: { from: e.from, to: e.to, insert: e.insert }, selection: { anchor: e.selection.from, head: e.selection.to }, annotations: isolateHistory.of('full'), userEvent: 'input.language' })
      view.focus()
    })
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'cm-code-copy'
    copy.textContent = 'Copy'
    copy.addEventListener('mousedown', (e) => e.preventDefault()) // the caret stays in the editor
    copy.addEventListener('click', () => {
      const pos = view.posAtDOM(bar)
      const text = docText(view.state)
      const block = documentFromTree(syntaxTree(view.state), text, pos, pos).blocks.find((b) => b.kind === 'codeBlock' && b.range.from <= pos && pos <= b.range.to)
      if (block?.kind !== 'codeBlock') return
      void navigator.clipboard.writeText(text.slice(block.content.from, block.content.to).replace(/\r?\n$/, ''))
    })
    picker.append(label, select)
    bar.append(picker, copy)
    return bar
  }
  override ignoreEvent() {
    return true
  }
}

const hideDeco = Decoration.replace({})
const bulletDeco = Decoration.replace({ widget: new BulletWidget() })
const lineDecos = new Map<string, Decoration>()
const markDecos = new Map<string, Decoration>()

function decorate(marks: Mark[], resolve: (url: string) => ResolvedAttachment | null): { all: CMRange<Decoration>[]; atomic: CMRange<Decoration>[] } {
  const all: CMRange<Decoration>[] = []
  const atomic: CMRange<Decoration>[] = []
  for (const m of marks) {
    switch (m.type) {
      case 'hide':
        all.push(hideDeco.range(m.from, m.to))
        atomic.push(hideDeco.range(m.from, m.to))
        break
      case 'bullet':
        all.push(bulletDeco.range(m.from, m.to))
        atomic.push(bulletDeco.range(m.from, m.to))
        break
      case 'checkbox': {
        const d = Decoration.replace({ widget: new CheckboxWidget(m.checked) }).range(m.from, m.to)
        all.push(d)
        atomic.push(d)
        break
      }
      case 'chip': {
        const d = Decoration.replace({ widget: new ChipWidget(m.url, m.label, resolve(m.url)) }).range(m.from, m.to)
        all.push(d)
        atomic.push(d)
        break
      }
      case 'codeBar':
        all.push(Decoration.widget({ widget: new CodeBarWidget(m.language, m.active), side: -1 }).range(m.at))
        break
      case 'image':
        all.push(Decoration.widget({ widget: new ImageWidget(m.url, m.alt, resolve(m.url)), side: -1 }).range(m.from))
        break
      case 'line': {
        let d = lineDecos.get(m.class)
        if (!d) lineDecos.set(m.class, (d = Decoration.line({ class: m.class })))
        all.push(d.range(m.at))
        break
      }
      case 'span': {
        let d = markDecos.get(m.class)
        if (!d) markDecos.set(m.class, (d = Decoration.mark({ class: m.class })))
        if (m.to > m.from) all.push(d.range(m.from, m.to))
        break
      }
    }
  }
  return { all, atomic }
}

function build(view: EditorView): { decorations: DecorationSet; atomic: DecorationSet } {
  const state = view.state
  const text = docText(state)
  const tree = syntaxTree(state)
  const raw = state.facet(rawMode)
  // without the focus there is no caret (editor.md "Live preview", web): every marker hides
  const sel = view.hasFocus ? state.selection.main : { from: -1, to: -1 }
  const seen = new Set<number>()
  const blocks: Block[] = []
  for (const r of view.visibleRanges) {
    for (const b of documentFromTree(tree, text, r.from, r.to).blocks) {
      if (seen.has(b.range.from)) continue
      seen.add(b.range.from)
      blocks.push(b)
    }
  }
  const marks = planPreview({ blocks }, text, { from: sel.from, to: sel.to }, raw)
  const { all, atomic } = decorate(marks, state.facet(attachmentResolver))
  return { decorations: Decoration.set(all, true), atomic: Decoration.set(atomic, true) }
}

const previewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    atomic: DecorationSet
    constructor(view: EditorView) {
      ;({ decorations: this.decorations, atomic: this.atomic } = build(view))
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        u.focusChanged ||
        syntaxTree(u.state) !== syntaxTree(u.startState) ||
        u.state.facet(rawMode) !== u.startState.facet(rawMode) ||
        u.state.facet(attachmentResolver) !== u.startState.facet(attachmentResolver)
      ) {
        ;({ decorations: this.decorations, atomic: this.atomic } = build(u.view))
      }
    }
  },
  {
    decorations: (p) => p.decorations,
    provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.atomic ?? Decoration.none),
  },
)

/** Live preview, or raw mode when `rawMode` is on. */
export function livePreview(): Extension {
  return [markdown(), previewPlugin, EditorView.editorAttributes.compute([rawMode], (s) => ({ class: s.facet(rawMode) ? 'cm-raw' : 'cm-live' }))]
}
