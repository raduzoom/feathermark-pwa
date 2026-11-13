// The block menu (specs/editor.md "Block menu"): "+" beside the caret's line, or "/" where a line's text begins,
// then type to filter. A pick replaces the caret's line, removing the "/query" in the same edit (one undo step).
// The menu is a CodeMirror tooltip (positioned by CodeMirror through the CSSOM, which the policy allows); the
// editor keeps the focus and points at the selected row with aria-activedescendant.
import { isolateHistory } from '@codemirror/commands'
import { Facet, Prec, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, keymap, showTooltip, ViewPlugin, WidgetType, type DecorationSet, type Tooltip, type ViewUpdate } from '@codemirror/view'
import { block, BlockMenuState, choice, mediaEdit, mediaInsertionPoint, slashOpensMenu, type BlockChoiceId, type Selection } from './commands/index.ts'
import { dispatchEdit, documentAt } from './keymap.ts'
import { docText, rawMode } from './live-preview.ts'

/** What the web doesn't offer: Scan from iPhone is the Mac's. */
const HIDDEN = new Set<BlockChoiceId>(['scan'])

export type BlockMenu = { trigger: Selection | null; at: number; query: string; items: BlockChoiceId[]; selected: number }

/** Adds picked files to the library and returns their Markdown snippets (Task 8 provides it). */
export const attachmentAdder = Facet.define<(files: File[]) => Promise<string[]>, (files: File[]) => Promise<string[]>>({
  combine: (v) => v[0] ?? (async () => []),
})

export const openBlockMenu = StateEffect.define<{ trigger: Selection | null; at: number }>()
export const closeBlockMenu = StateEffect.define<null>()
const moveBlockMenu = StateEffect.define<number>()
/** Where picked files go once they arrive, mapped through edits made meanwhile. */
const setPendingMedia = StateEffect.define<number | null>()

function fresh(trigger: Selection | null, at: number): BlockMenu {
  const s = new BlockMenuState(HIDDEN)
  return { trigger, at, query: '', items: s.items, selected: 0 }
}

/** The menu after the user typed: the query is the text from after "/" to the caret. Null closes it. */
function retyped(menu: BlockMenu, state: EditorState, from: number): BlockMenu | null {
  const sel = state.selection.main
  const line = state.doc.lineAt(from)
  if (!sel.empty || sel.head <= from || sel.head > line.to || state.sliceDoc(from, from + 1) !== '/') return null
  const query = state.sliceDoc(from + 1, sel.head)
  if (query === menu.query) return { ...menu, trigger: { from, to: sel.head } }
  const s = new BlockMenuState(HIDDEN)
  if (query !== '' && !s.setQuery(query)) return null
  return { ...menu, trigger: { from, to: sel.head }, query, items: s.items, selected: 0 }
}

/** A "/" just typed where the line's text begins (live mode, editable). */
function typedSlash(state: EditorState, tr: { changes: { iterChanges(f: (fa: number, ta: number, fb: number, tb: number, ins: { toString(): string }) => void): void }; isUserEvent(e: string): boolean }): number | null {
  if (!tr.isUserEvent('input.type') || state.facet(rawMode) || state.readOnly) return null
  let at: number | null = null
  let count = 0
  tr.changes.iterChanges((fa, ta, fb, _tb, ins) => {
    count++
    if (fa === ta && ins.toString() === '/') at = fb
  })
  if (count !== 1 || at === null) return null
  return slashOpensMenu(docText(state), documentAt(state, at, at), at) ? at : null
}

export const blockMenuField = StateField.define<BlockMenu | null>({
  create: () => null,
  update(menu, tr) {
    for (const e of tr.effects) {
      if (e.is(openBlockMenu)) return fresh(e.value.trigger, e.value.at)
      if (e.is(closeBlockMenu)) return null
      if (e.is(moveBlockMenu) && menu) {
        const n = menu.items.length
        return { ...menu, selected: (((menu.selected + e.value) % n) + n) % n }
      }
    }
    if (!menu) {
      if (!tr.docChanged) return null
      const at = typedSlash(tr.state, tr)
      return at === null ? null : { ...fresh({ from: at, to: at + 1 }, tr.state.doc.lineAt(at).from) }
    }
    if (!tr.docChanged && !tr.selection) return menu
    // opened by "+": any edit or a move to another line closes it
    if (!menu.trigger) {
      if (tr.docChanged) return null
      return tr.state.doc.lineAt(tr.state.selection.main.head).from === menu.at ? menu : null
    }
    return retyped(menu, tr.state, tr.changes.mapPos(menu.trigger.from))
  },
  provide: (f) => [
    showTooltip.compute([f], (s) => {
      const m = s.field(f)
      return m ? menuTooltip(m.trigger?.from ?? s.selection.main.head) : null
    }),
    EditorView.contentAttributes.compute([f], (s): Record<string, string> => {
      const m = s.field(f)
      return m ? { 'aria-controls': 'block-menu', 'aria-activedescendant': `block-menu-${m.items[m.selected]}`, 'aria-autocomplete': 'list' } : {}
    }),
  ],
})

const pendingMedia = StateField.define<number | null>({
  create: () => null,
  update(pos, tr) {
    for (const e of tr.effects) if (e.is(setPendingMedia)) return e.value
    return pos === null ? null : tr.changes.mapPos(pos)
  },
})

export function menuOf(state: EditorState): BlockMenu | null {
  return state.field(blockMenuField, false) ?? null
}

/** Asks for files the way a browser can: a file input, clicked while the key or click is still being handled. */
function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.addEventListener('change', () => resolve([...(input.files ?? [])]))
    input.addEventListener('cancel', () => resolve([]))
    input.click()
  })
}

export function pick(view: EditorView, id: BlockChoiceId) {
  const menu = menuOf(view.state)
  if (!menu) return
  const text = docText(view.state)
  const caret = view.state.selection.main.head
  if (id === 'imageOrFile') {
    const point = mediaInsertionPoint(text, caret, menu.trigger)
    view.dispatch({
      changes: point.edit ? { from: point.edit.from, to: point.edit.to, insert: point.edit.insert } : undefined,
      effects: [closeBlockMenu.of(null), setPendingMedia.of(point.location)],
      annotations: isolateHistory.of('full'),
      userEvent: 'input.command',
    })
    const add = view.state.facet(attachmentAdder)
    void pickFiles()
      .then((files) => (files.length ? add(files) : []))
      .then((snippets) => {
        const at = view.state.field(pendingMedia, false)
        view.dispatch({ effects: setPendingMedia.of(null) })
        if (at === null || at === undefined || snippets.length === 0) return
        dispatchEdit(view, mediaEdit(snippets, docText(view.state), at))
      })
    return
  }
  const e = block(id, text, caret, menu.trigger)
  view.dispatch({ effects: closeBlockMenu.of(null) })
  if (e) dispatchEdit(view, e)
}

function render(dom: HTMLElement, menu: BlockMenu, view: EditorView) {
  dom.replaceChildren(
    ...menu.items.map((id, i) => {
      const c = choice(id)
      const row = document.createElement('div')
      row.id = `block-menu-${id}`
      row.className = 'block-menu-row'
      row.setAttribute('role', 'option')
      row.setAttribute('aria-label', c.title)
      row.setAttribute('aria-selected', String(i === menu.selected))
      const title = document.createElement('span')
      title.className = 'block-menu-title'
      title.textContent = c.title
      const hint = document.createElement('span')
      hint.className = 'block-menu-hint'
      hint.textContent = c.hint
      row.append(title, hint)
      // the pointer moves the selection, as in a native menu (mousemove, so a keyboard scroll under a still pointer doesn't)
      row.addEventListener('mousemove', () => {
        const m = menuOf(view.state)
        if (m && m.selected !== i) view.dispatch({ effects: moveBlockMenu.of(i - m.selected) })
      })
      row.addEventListener('mousedown', (e) => {
        e.preventDefault() // the editor keeps the focus
        pick(view, id)
      })
      return row
    }),
  )
}

function menuTooltip(pos: number): Tooltip {
  return {
    pos,
    above: false,
    create(view) {
      const dom = document.createElement('div')
      dom.id = 'block-menu'
      dom.className = 'block-menu'
      dom.setAttribute('role', 'listbox')
      dom.setAttribute('aria-label', 'Insert')
      render(dom, menuOf(view.state)!, view)
      return {
        dom,
        update(u: ViewUpdate) {
          const m = menuOf(u.state)
          if (m && m !== menuOf(u.startState)) render(dom, m, u.view)
        },
      }
    },
  }
}

const menuKeys = Prec.highest(
  keymap.of([
    { key: 'ArrowDown', run: (v) => (menuOf(v.state) ? (v.dispatch({ effects: moveBlockMenu.of(1) }), true) : false) },
    { key: 'ArrowUp', run: (v) => (menuOf(v.state) ? (v.dispatch({ effects: moveBlockMenu.of(-1) }), true) : false) },
    { key: 'Enter', run: (v) => pickSelected(v) },
    { key: 'Tab', run: (v) => pickSelected(v) },
    { key: 'Escape', run: (v) => (menuOf(v.state) ? (v.dispatch({ effects: closeBlockMenu.of(null) }), true) : false) },
  ]),
)

function pickSelected(view: EditorView): boolean {
  const m = menuOf(view.state)
  if (!m) return false
  pick(view, m.items[m.selected]!)
  return true
}

class PlusWidget extends WidgetType {
  override eq() {
    return true
  }
  toDOM(view: EditorView) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'cm-insert-block'
    b.setAttribute('aria-label', 'Insert block')
    b.tabIndex = -1
    b.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const line = view.state.doc.lineAt(view.state.selection.main.head)
      view.dispatch({ effects: openBlockMenu.of({ trigger: null, at: line.from }) })
    })
    return b
  }
  override ignoreEvent() {
    return true
  }
}

const plus = Decoration.widget({ widget: new PlusWidget(), side: -1 })

/** "+" in the margin beside the caret's line, while the editor has the focus (live mode, editable). */
const plusButton = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none
    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }
    update(u: ViewUpdate) {
      if (u.focusChanged || u.selectionSet || u.docChanged || u.state.facet(rawMode) !== u.startState.facet(rawMode) || u.state.readOnly !== u.startState.readOnly) {
        this.decorations = this.build(u.view)
      }
    }
    build(view: EditorView): DecorationSet {
      if (!view.hasFocus || view.state.readOnly || view.state.facet(rawMode)) return Decoration.none
      return Decoration.set([plus.range(view.state.doc.lineAt(view.state.selection.main.head).from)])
    }
  },
  { decorations: (p) => p.decorations },
)

export function blockMenu(): Extension {
  return [blockMenuField, pendingMedia, menuKeys, plusButton]
}
