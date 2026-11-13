import { expect, test } from 'vitest'
import { bodyFromTextarea, lineStyle, textareaValue } from '../../src/model/line-endings.ts'

// A <textarea> turns CRLF into LF in its value. These keep a note's own line endings when it's edited.

test('a CRLF note keeps CRLF after an edit', () => {
  const body = 'one\r\ntwo\r\n'
  const shown = textareaValue(body)
  expect(shown).toBe('one\ntwo\n')
  expect(bodyFromTextarea(shown + 'three', body)).toBe('one\r\ntwo\r\nthree')
})

test('an LF note stays LF', () => {
  expect(bodyFromTextarea('a\nb', 'a\n')).toBe('a\nb')
})

test('unchanged text gives back the exact body', () => {
  for (const body of ['', 'x', 'a\r\nb', 'a\nb', 'é\t\t  \n']) {
    expect(bodyFromTextarea(textareaValue(body), body)).toBe(body)
  }
})

test('a note with mixed line endings uses LF for new lines and keeps the rest', () => {
  const body = 'a\r\nb\nc'
  expect(bodyFromTextarea(textareaValue(body), body)).toBe(body)
  expect(bodyFromTextarea(textareaValue(body) + '\nd', body)).toBe('a\r\nb\nc\nd')
})

test('a lone CR is kept: the editor shows it as a line break and maps it back', () => {
  const body = 'a\rb\r\nc'
  expect(textareaValue(body)).toBe('a\nb\nc')
  expect(bodyFromTextarea('a\nb\nc', body)).toBe(body)
  expect(bodyFromTextarea('a\nb\ncd', body)).toBe('a\rb\r\ncd')
})

test('the note’s style, given by the editor, decides new line breaks', () => {
  expect(lineStyle('a\r\nb\r\n')).toBe('\r\n')
  expect(lineStyle('a\nb')).toBe('\n')
  expect(lineStyle('a\r\nb\nc')).toBe('\n') // mixed: new lines are LF
  expect(lineStyle('a\rb')).toBe('\n')
  expect(lineStyle('')).toBe('\n')
  // a note with no line break yet, given a pasted CRLF style
  expect(bodyFromTextarea('x\ny', '', '\r\n')).toBe('x\r\ny')
})

// Final review: removing a CRLF note's last line break and bringing it back (Backspace then Undo, or select all,
// delete, Undo) made it LF, because the style was re-derived from what was left.
test('a CRLF note stays CRLF after its last line break is removed and brought back', () => {
  expect(bodyFromTextarea('a\nb', 'ab', '\r\n')).toBe('a\r\nb')
  expect(bodyFromTextarea('- one\n- two\n', '', '\r\n')).toBe('- one\r\n- two\r\n')
})

test('a note without CR is exactly the editor’s text (the fast path), whatever the edit', () => {
  let seed = 7
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n)
  const pieces = ['a', ' ', '\n', 'é', '😀', '\t']
  for (const original of ['', 'x', 'a\nb\n', 'one\ntwo\nthree']) {
    for (let k = 0; k < 200; k++) {
      const from = rand(original.length + 1)
      const to = from + rand(original.length - from + 1)
      let insert = ''
      for (let i = rand(4); i > 0; i--) insert += pieces[rand(pieces.length)]
      const value = original.slice(0, from) + insert + original.slice(to)
      expect(bodyFromTextarea(value, original)).toBe(value)
      // a CRLF note whose breaks are all gone: new breaks are CRLF
      expect(bodyFromTextarea(value, original, '\r\n')).toBe(/\n/.test(original) ? bodyFromTextarea(value, original, '\r\n') : value.replace(/\n/g, '\r\n'))
    }
  }
})
