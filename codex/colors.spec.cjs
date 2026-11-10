const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const adapter = path.resolve(__dirname, '../dist/codex')
const store = require(path.join(adapter, 'state.cjs'))
const { render } = require(path.join(adapter, 'panel.cjs'))
const strip = text => text.replace(/\x1b\[[0-9;]*m/g, '')

function state() {
  const current = store.emptyState('colors')
  current.plan = { ...current.plan, title: 'Colorful task', nodes: [
    { id: '1', title: 'Finished', status: 'completed', parentId: null },
    { id: '2', title: 'Working', status: 'in_progress', parentId: null },
    { id: '3', title: 'Blocked', status: 'blocked', note: 'Needs input', parentId: null },
  ] }
  current.window.items = [
    { id: 'F1', kind: 'F', title: 'Open fix', isDone: false },
    { id: 'T1', kind: 'T', title: 'Closed task', isDone: true },
  ]
  return current
}

test('terminal output preserves shared colors, emphasis and strikethrough', () => {
  const colored = render(state(), 80, 40, { color: true })
  assert.ok(colored.includes('\x1b[32m✓\x1b[0m'))
  assert.ok(colored.includes('\x1b[1;36mWorking\x1b[0m'))
  assert.ok(colored.includes('\x1b[33m■\x1b[0m'))
  assert.ok(colored.includes('\x1b[2;9mClosed task\x1b[0m'))
  assert.equal(strip(colored), render(state(), 80, 40))
})

test('narrow colored lines keep all escapes intact and do not exceed plain-text width', () => {
  for (const width of [20, 30, 40, 56]) {
    const colored = render(state(), width, 40, { color: true })
    const plain = render(state(), width, 40)
    assert.equal(strip(colored), plain)
    assert.ok(!strip(colored).includes('\x1b'))
    for (const row of strip(colored).split('\n')) assert.ok(row.length <= width)
  }
})
