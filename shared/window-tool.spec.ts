import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWindowInput, readDue, WINDOW_INPUT_SCHEMA, WINDOW_TOOL_DESCRIPTION } from './window-tool'

test('op add may carry a day as written; "clear" on an add is no day', () => {
  assert.deepEqual(parseWindowInput({ op: 'add', kind: 'w', title: 'DBA', due: '+3d' }), { op: 'add', kind: 'W', title: 'DBA', due: '+3d' })
  assert.deepEqual(parseWindowInput({ op: 'add', kind: 'W', title: 'DBA', due: 'clear' }), { op: 'add', kind: 'W', title: 'DBA' })
  assert.deepEqual(parseWindowInput({ op: 'add', kind: 'W', title: 'DBA', due: 5 }), { error: '"due" is a string' })
})

test('op due takes ids and a day, and refuses either missing', () => {
  assert.deepEqual(parseWindowInput({ op: 'due', ids: ['W1'], due: 'tomorrow' }), { op: 'due', ids: ['W1'], due: 'tomorrow' })
  assert.match(String((parseWindowInput({ op: 'due', ids: ['W1'] }) as { error: string }).error), /op due needs "due"/)
  assert.match(String((parseWindowInput({ op: 'due', due: 'today' }) as { error: string }).error), /needs "ids"/)
  assert.match(String((parseWindowInput({ op: 'explode' }) as { error: string }).error), /add, done, skip, due or prune/)
})

test('a written day is read against today, and clear asks to remove it', () => {
  assert.deepEqual(readDue('tomorrow', '2026-11-12'), { due: '2026-11-13' })
  assert.deepEqual(readDue(' Clear ', '2026-11-12'), { due: null })
  assert.ok('error' in readDue('someday', '2026-11-12'))
})

test('the schema and the description name the day', () => {
  assert.deepEqual(WINDOW_INPUT_SCHEMA.properties.op.enum, ['add', 'done', 'skip', 'prune', 'due'])
  assert.equal(WINDOW_INPUT_SCHEMA.properties.due.type, 'string')
  assert.match(WINDOW_TOOL_DESCRIPTION, /op "due"/)
})
