import { expect, test } from 'claude-code/testing'
import {
  addItem,
  closeItems,
  describeWindow,
  displayOrder,
  emptyWindow,
  hasOpenQuestion,
  normaliseId,
  parseStoredWindow,
  skipItems,
  windowLines,
  windowStatus,
} from './window'
import type { WindowKind, WindowList } from './window'

// Adds items in order and fails the test on a refused add.
const withItems = (entries: Array<[WindowKind, string]>, start: WindowList = emptyWindow()): WindowList =>
  entries.reduce((list, [kind, title]) => {
    const result = addItem(list, kind, title)
    if ('error' in result) throw new Error(result.error)

    return result.list
  }, start)

const ids = (list: WindowList): string[] => displayOrder(list).map(item => item.id)

test('ids are numbered per kind', () => {
  const list = withItems([
    ['T', 'Write the store'],
    ['F', 'Upload bypasses the toggle'],
    ['T', 'Wire the observer'],
    ['Q', 'Pane or section?'],
  ])
  expect(ids(list)).toEqual(['T1', 'F1', 'T2', 'Q1'])
})

test('a closed id is never handed out again', () => {
  const closed = closeItems(withItems([['F', 'One'], ['F', 'Two']]), ['F2']).list
  const next = withItems([['F', 'Three']], closed)
  expect(ids(next)).toEqual(['F1', 'F3', 'F2'])
})

test('a stored list keeps its counters, so ids continue after a resume', () => {
  const stored = JSON.parse(JSON.stringify(closeItems(withItems([['W', 'CI'], ['W', 'Review']]), ['W1', 'W2']).list))
  const restored = parseStoredWindow(stored)
  expect(restored).not.toBeNull()
  const next = withItems([['W', 'Deploy']], restored ?? emptyWindow())
  expect(next.items.at(-1)?.id).toBe('W3')
})

test('«F1 can wait» moves F1 to the bottom with the same id and keeps it open', () => {
  const list = withItems([['F', 'First'], ['T', 'Task'], ['F', 'Second']])
  const result = skipItems(list, ['f1'])
  expect(result.changed).toEqual(['F1'])
  expect(ids(result.list)).toEqual(['T1', 'F2', 'F1'])
  expect(result.list.items.find(item => item.id === 'F1')?.isDone).toBe(false)
})

test('a skipped item stays above the done ones', () => {
  const list = closeItems(withItems([['T', 'A'], ['T', 'B'], ['T', 'C']]), ['T3']).list
  expect(ids(skipItems(list, ['T1']).list)).toEqual(['T2', 'T1', 'T3'])
})

test('unknown and malformed ids are reported and change nothing', () => {
  const list = withItems([['T', 'Only']])
  const closed = closeItems(list, ['T9', 'X1', 'T1'])
  expect(closed.unknown).toEqual(['T9', 'X1'])
  expect(closed.changed).toEqual(['T1'])
  expect(skipItems(list, ['nothing']).list).toEqual(list)
})

test('closing an item twice reports it once', () => {
  const once = closeItems(withItems([['Q', 'Ask']]), ['Q1']).list
  expect(closeItems(once, ['Q1']).changed).toEqual([])
})

test('an empty or overlong title is refused, and control characters are cleaned', () => {
  expect(addItem(emptyWindow(), 'T', '   ')).toEqual({ error: 'The title is empty.' })
  expect('error' in addItem(emptyWindow(), 'T', 'x'.repeat(121))).toBe(true)
  const result = addItem(emptyWindow(), 'T', 'a\u001b[31mb\nc')
  expect('list' in result && result.list.items[0]?.title).toBe('a [31mb c')
})

test('normaliseId accepts any case and surrounding space only', () => {
  expect(normaliseId(' f12 ')).toBe('F12')
  expect(normaliseId('F01')).toBe('F1')
  expect(normaliseId('F')).toBeNull()
  expect(normaliseId('FF1')).toBeNull()
})

test('an open question is seen only while it is open', () => {
  const list = withItems([['Q', 'Which pane?']])
  expect(hasOpenQuestion(list)).toBe(true)
  expect(hasOpenQuestion(closeItems(list, ['Q1']).list)).toBe(false)
})

test('the status line counts open items per kind', () => {
  const list = closeItems(withItems([['T', 'a'], ['T', 'b'], ['F', 'c'], ['Q', 'd']]), ['F1']).list
  expect(windowStatus(list)).toBe('T2 Q1')
  expect(windowStatus(emptyWindow())).toBeUndefined()
})

test('the pane section is empty for an empty list and fits the width otherwise', () => {
  expect(windowLines(emptyWindow(), 40, 'claude')).toEqual([])
  const list = closeItems(withItems([['T', 'x'.repeat(80)], ['F', 'Done one']]), ['F1']).list
  const lines = windowLines(list, 40, 'claude')
  expect(lines.map(line => line.text.slice(0, 6))).toEqual(['Window', '○ T1 x', '✓ F1 D'])
  expect(lines.every(line => line.text.length <= 40)).toBe(true)
  expect(lines[2]?.segments.some(s => s.strikethrough === true)).toBe(true)
})

test('describeWindow lists open items first with their state', () => {
  const list = closeItems(withItems([['T', 'a'], ['W', 'b']]), ['T1']).list
  expect(describeWindow(list)).toBe('W1 [open] b\nT1 [done] a')
  expect(describeWindow(emptyWindow())).toBe('The window list is empty.')
})

test('a stored value of another shape is not a list', () => {
  expect(parseStoredWindow(undefined)).toBeNull()
  expect(parseStoredWindow({ items: [], issued: { T: 0 } })).toBeNull()
  expect(parseStoredWindow({ items: [{ id: 'Z1', kind: 'Z', title: 't', isDone: false }], issued: { T: 0, F: 0, Q: 0, W: 0 } })).toBeNull()
})
