import { expect, test } from 'vitest'
import { displayTitle, nameOrder, preview, tagKey } from '../../src/core/library/names.ts'

test('names sort ignoring case, numbers by value, ties in creation order', () => {
  const names = ['note 10', 'Note 2', 'apple', 'Ｂanana', 'NOTE 2', 'banana']
  const sorted = [...names].sort(nameOrder)
  expect(sorted).toEqual(['apple', 'Ｂanana', 'banana', 'Note 2', 'NOTE 2', 'note 10'])
})

test('preview collapses white space and keeps 200 characters', () => {
  expect(preview('  Starter fed\n\n- at 8\t\tready ')).toBe('Starter fed - at 8 ready')
  expect(preview('x'.repeat(250))).toHaveLength(200)
  expect(preview('é'.repeat(201))).toBe('é'.repeat(200))
})

test('tag keys are lowercase only', () => {
  expect(tagKey('Été')).toBe('été')
})

test('display title is Untitled when blank', () => {
  expect(displayTitle('  \n')).toBe('Untitled')
  expect(displayTitle(' Groceries ')).toBe(' Groceries ')
})
