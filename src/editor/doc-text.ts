// One string per CodeMirror document, shared by the parser, live preview and saving: copying a long note into a
// string costs about a millisecond, so it is done once per change, not once per reader.
import type { Text } from '@codemirror/state'

const texts = new WeakMap<Text, string>()

export function textOfDoc(doc: Text): string {
  let t = texts.get(doc)
  if (t === undefined) {
    t = doc.toString()
    texts.set(doc, t)
  }
  return t
}
