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
