import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyInboxEntries, INBOX_MAX_ENTRIES, parseInbox, pendingEntries } from './inbox'
import { addItem, displayOrder, emptyWindow } from './window'
import type { WindowList } from './window'

const list = (): WindowList =>
  ['One', 'Two', 'Three'].reduce((current, title) => {
    const added = addItem(current, 'T', title)
    if ('error' in added) throw new Error(added.error)

    return added.list
  }, emptyWindow())

const inbox = (entries: unknown[], sessionId = 's1'): unknown => ({ version: 1, sessionId, entries })

test('an inbox for another session or of another shape has no entries', () => {
  const entries = [{ seq: 1, op: 'done', ids: ['T1'], at: 5 }]
  assert.deepEqual(parseInbox(inbox(entries, 'other'), 's1'), [])
  assert.deepEqual(parseInbox({ version: 2, sessionId: 's1', entries }, 's1'), [])
  assert.deepEqual(parseInbox(null, 's1'), [])
  assert.deepEqual(parseInbox(inbox(entries), 's1'), [{ seq: 1, op: 'done', ids: ['T1'], at: 5 }])
})

test('malformed entries are dropped, the rest kept in sequence order', () => {
  const parsed = parseInbox(
    inbox([
      { seq: 3, op: 'skip', ids: ['T2', 7] },
      { seq: 0, op: 'done', ids: ['T1'] },
      { seq: 2, op: 'explode', ids: ['T1'] },
      { seq: 4, op: 'done', ids: [] },
      { seq: 1, op: 'prune' },
      'nonsense',
    ]),
    's1',
  )
  assert.deepEqual(parsed, [
    { seq: 1, op: 'prune', ids: [], at: 0 },
    { seq: 3, op: 'skip', ids: ['T2'], at: 0 },
  ])
  const many = Array.from({ length: INBOX_MAX_ENTRIES + 5 }, (_, i) => ({ seq: i + 1, op: 'done', ids: ['T1'] }))
  assert.equal(parseInbox(inbox(many), 's1').length, INBOX_MAX_ENTRIES)
})

test('only entries after the applied number are pending', () => {
  const entries = parseInbox(inbox([{ seq: 1, op: 'done', ids: ['T1'] }, { seq: 2, op: 'skip', ids: ['T2'] }]), 's1')
  assert.deepEqual(pendingEntries(entries, 1).map(entry => entry.seq), [2])
  assert.deepEqual(pendingEntries(entries, 2), [])
})

test('entries apply in order and answer the highest sequence number', () => {
  const entries = parseInbox(
    inbox([
      { seq: 1, op: 'done', ids: ['T1'] },
      { seq: 2, op: 'skip', ids: ['T2'] },
      { seq: 3, op: 'done', ids: ['T9'] },
    ]),
    's1',
  )
  const out = applyInboxEntries(list(), entries)
  assert.equal(out.applied, 3)
  assert.deepEqual(out.changed, ['T1', 'T2'])
  assert.deepEqual(
    displayOrder(out.list).map(item => `${item.id}:${item.isDone}`),
    ['T3:false', 'T2:false', 'T1:true'],
  )
  const pruned = applyInboxEntries(out.list, parseInbox(inbox([{ seq: 4, op: 'prune' }]), 's1'))
  assert.deepEqual(pruned.list.items.map(item => item.id), ['T3', 'T2'])
  assert.equal(applyInboxEntries(list(), []).applied, 0)
})

test('a due entry sets the day it carries, and one without a day clears it', () => {
  const parsed = parseInbox(
    inbox([
      { seq: 1, op: 'due', ids: ['T1', 'T2'], due: '2026-11-15' },
      { seq: 2, op: 'due', ids: ['T2'] },
      { seq: 3, op: 'due', ids: ['T3'], due: 'soon' },
    ]),
    's1',
  )
  assert.deepEqual(parsed.map(entry => entry.due), ['2026-11-15', undefined, undefined])
  const out = applyInboxEntries(list(), parsed)
  assert.deepEqual(out.list.items.map(item => item.due), ['2026-11-15', undefined, undefined])
  assert.deepEqual(out.changed, ['T1', 'T2', 'T2'])
  assert.equal(out.applied, 3)
})
