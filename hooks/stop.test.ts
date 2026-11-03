import { expect, test } from 'claude-code/testing'
import { asksUser } from './stop'
import { parseWindowInput } from './window-tool'

test('a reply that ends on a question asks the user', () => {
  expect(asksUser('Done.\n\nPanel or section?')).toBe(true)
  expect(asksUser('Which one do you want?**')).toBe(true)
})

test('a question inside a code block or far above the end does not count', () => {
  expect(asksUser('```\nis it?\n```\nDone.')).toBe(false)
  expect(asksUser('Why?\none\ntwo\nthree')).toBe(false)
  expect(asksUser('All done.')).toBe(false)
})

test('the window tool input is parsed per op', () => {
  expect(parseWindowInput({ op: 'add', kind: 'q', title: 'Pane?' })).toEqual({ op: 'add', kind: 'Q', title: 'Pane?' })
  expect(parseWindowInput({ op: 'skip', ids: ['F1'] })).toEqual({ op: 'skip', ids: ['F1'] })
  expect('error' in parseWindowInput({ op: 'show' })).toBe(true)
  for (const raw of [null, {}, { op: 'add', kind: 'X', title: 't' }, { op: 'add', kind: 'T' }, { op: 'done', ids: [] }, { op: 'done', ids: [1] }]) {
    expect('error' in parseWindowInput(raw)).toBe(true)
  }
})
