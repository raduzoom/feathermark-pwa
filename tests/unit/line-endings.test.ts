import { expect, test } from 'vitest'
import { bodyFromTextarea, textareaValue } from '../../src/model/line-endings.ts'

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
