const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const child = require('node:child_process')
const adapter = path.resolve(__dirname, '../dist/codex')
const store = require(path.join(adapter, 'state.cjs'))
const { call } = require(path.join(adapter, 'service.cjs'))
const { execute } = require(path.join(adapter, 'commands.cjs'))

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-todo-command-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, env: { WINDOW_TODO_STATE_DIR: dir } }
}

test('prune preserves open items and plan; clear empties both and never reuses item IDs', async t => {
  const f = fixture(t)
  await call('plan', { sessionId: 'one', op: 'set', title: 'Keep', nodes: [{ title: 'Open step' }] }, { env: f.env })
  for (const title of ['Done', 'Open']) await call('window', { sessionId: 'one', op: 'add', kind: 'T', title }, { env: f.env })
  await call('window', { sessionId: 'one', op: 'done', ids: ['T1'] }, { env: f.env })
  assert.match(await execute('/todo prune', 'one', f.env), /Removed 1/)
  assert.equal(store.read('one', f.dir).plan.nodes.length, 1)
  assert.deepEqual(store.read('one', f.dir).window.items.map(item => item.id), ['T2'])
  await execute('/todo clear', 'one', f.env)
  assert.equal(store.read('one', f.dir).plan.nodes.length, 0)
  assert.equal(store.read('one', f.dir).window.items.length, 0)
  await call('window', { sessionId: 'one', op: 'add', kind: 'T', title: 'Next' }, { env: f.env })
  assert.equal(store.read('one', f.dir).window.items[0].id, 'T3')
  assert.equal(store.read('two', f.dir).window.items.length, 0)
})

test('help works before binding; invalid commands do not mutate state', async t => {
  const f = fixture(t)
  assert.match(await execute('/todo help', null, f.env), /prune/)
  await assert.rejects(execute('/todo clear yes', 'one', f.env))
  await assert.rejects(execute('/todo clear', null, f.env))
  assert.equal(fs.readdirSync(f.dir).length, 0)
})

test('/todo sessions answers the sessions page, also before binding, and is named in the usage', async t => {
  const f = fixture(t)
  assert.deepEqual(await execute('/todo sessions', null, f.env), { page: 'sessions', text: '' })
  assert.deepEqual(await execute('/todo SESSIONS', 'one', f.env), { page: 'sessions', text: '' })
  await assert.rejects(execute('/todo sessions all', 'one', f.env), /\/todo sessions/)
  assert.match(await execute('/todo help', null, f.env), /\/todo sessions/)
  assert.equal(fs.readdirSync(f.dir).length, 0)
})

test('the panel accepts local slash commands through its input interface', async t => {
  const f = fixture(t)
  await call('window', { sessionId: 'one', op: 'add', kind: 'T', title: 'Remove me' }, { env: f.env })
  await call('window', { sessionId: 'one', op: 'done', ids: ['T1'] }, { env: f.env })
  const panel = child.spawnSync(process.execPath, [path.join(adapter, 'panel.cjs'), '--session', 'one', '--interactive'], { env: { ...process.env, ...f.env }, input: '/todo prune\n/todo show\n', encoding: 'utf8', timeout: 3000 })
  assert.equal(panel.status, 0, panel.stderr)
  assert.match(panel.stdout, /Removed 1 completed/)
  assert.match(panel.stdout, /0 open/)
  assert.equal(store.read('one', f.dir).window.items.length, 0)
})

test('the Codex window tool takes a day on add and op due, and /todo due sets or clears it', async t => {
  const f = fixture(t)
  const reply = await call('window', { sessionId: 'one', op: 'add', kind: 'W', title: 'Answer from DBA', due: '2031-11-15' }, { env: f.env })
  assert.match(reply, /W1 \[open\] Answer from DBA \(come back on 2031-11-15\)/)
  await call('window', { sessionId: 'one', op: 'add', kind: 'T', title: 'Task' }, { env: f.env })
  assert.match(await call('window', { sessionId: 'one', op: 'due', ids: ['T1'], due: '2031-01-02' }, { env: f.env }), /Changed: T1\./)
  await assert.rejects(call('window', { sessionId: 'one', op: 'due', ids: ['T1'], due: 'someday' }, { env: f.env }), /not a date/)
  assert.equal(await execute('/todo due W1 clear', 'one', f.env), 'Day cleared: W1.')
  assert.equal(await execute('/todo due T1, W1 2031-12-24', 'one', f.env), 'Day 2031-12-24 set: W1, T1.')
  await assert.rejects(execute('/todo due W1', 'one', f.env), /\/todo due <ids> <date\|clear>/)
  assert.deepEqual(store.read('one', f.dir).window.items.map(item => item.due), ['2031-12-24', '2031-12-24'])
  const { tools } = require(path.join(adapter, 'service.cjs'))
  assert.deepEqual(tools.find(tool => tool.name === 'window').inputSchema.properties.op.enum, ['show', 'add', 'done', 'skip', 'prune', 'due'])
})

test('/todo due on a Claude list goes through the inbox with the day it sets', async t => {
  const f = fixture(t)
  const state = { ...store.emptyState('claude'), client: 'claude', window: { items: [{ id: 'W1', kind: 'W', title: 'x', isDone: false }], issued: { T: 0, F: 0, Q: 0, W: 1 } } }
  fs.mkdirSync(f.dir, { recursive: true })
  fs.writeFileSync(store.filename('claude', f.dir), JSON.stringify(state))
  assert.equal(await execute('/todo due W1 2031-11-15', 'claude', f.env), 'Day 2031-11-15: W1. Claude applies it within a few seconds.')
  await execute('/todo due W1 clear', 'claude', f.env)
  const inbox = require(path.join(adapter, 'inbox.cjs'))
  assert.deepEqual(inbox.read('claude', f.dir).map(entry => [entry.op, entry.ids, entry.due]), [['due', ['W1'], '2031-11-15'], ['due', ['W1'], undefined]])
})
