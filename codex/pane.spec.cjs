const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const child = require('node:child_process')
const adapter = path.resolve(__dirname, '../dist/codex')
const store = require(path.join(adapter, 'state.cjs'))
const inbox = require(path.join(adapter, 'inbox.cjs'))
const { render, withPending } = require(path.join(adapter, 'panel.cjs'))
const { change } = require(path.join(adapter, 'commands.cjs'))
const strip = text => text.replace(/\x1b\[[0-9;]*m/g, '')

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-todo-pane-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, env: { WINDOW_TODO_STATE_DIR: dir } }
}

function sample(sessionId = 'pane', client) {
  const state = store.emptyState(sessionId)
  if (client) state.client = client
  state.plan = { title: 'Ship', issued: [], nodes: [
    { id: '1', title: 'Build', status: 'completed', parentId: null, source: 'plan', updatedAt: 0 },
    { id: '2', title: 'Test', status: 'in_progress', parentId: null, source: 'plan', updatedAt: 0 },
  ] }
  state.activity = { phase: 'tool', tool: 'Bash', subagents: ['a1'], running: [{ id: 'c1', tool: 'Bash' }], since: Date.now() }
  state.window = { items: [
    { id: 'T1', kind: 'T', title: 'First task', isDone: false },
    { id: 'F1', kind: 'F', title: 'A fix', isDone: false },
    { id: 'T2', kind: 'T', title: 'Closed task', isDone: true },
  ], issued: { T: 2, F: 1, Q: 0, W: 0 } }
  return state
}

// A Claude session's state file as the mod writes it.
function writeClaude(f, sessionId, applied = 0) {
  const state = { ...sample(sessionId, 'claude'), inbox: { applied } }
  fs.writeFileSync(store.filename(sessionId, f.dir), JSON.stringify(state))
  return state
}

test('the window list has checkboxes, and the selected row is inverted', () => {
  const plain = render(sample(), 60, 40)
  assert.match(plain, /\[ \] T1 First task/)
  assert.match(plain, /\[x\] T2 Closed task/)
  const selected = render(sample(), 60, 40, { color: true, cursor: 'F1', footer: false })
  assert.ok(selected.includes('\x1b[1;7;36mF1\x1b[0m'))
  assert.match(strip(selected), /› \[ \] F1 A fix/)
  assert.match(strip(selected), /  \[ \] T1 First task/)
  assert.ok(!strip(selected).includes('Ctrl+C closes'))
})

test('pages show the plan, the window list and the activity on their own', () => {
  const plan = render(sample(), 60, 40, { page: 'plan' })
  assert.match(plan, /WINDOW TODO · Plan/)
  assert.match(plan, /Test/)
  assert.doesNotMatch(plan, /First task/)
  const list = render(sample(), 60, 40, { page: 'window' })
  assert.match(list, /First task/)
  assert.doesNotMatch(list, /Build/)
  const activity = render(sample(), 60, 40, { page: 'activity' })
  assert.match(activity, /Running Bash · 1 subagent/)
  assert.match(activity, /▸ Bash/)
  assert.match(activity, /Plan 1\/2 Ship/)
  assert.match(activity, /Window T1 F1/)
  assert.match(render(store.emptyState('e'), 60, 40, { page: 'window' }), /The window list is empty/)
})

test('a long window page scrolls so the selected item stays in view', () => {
  const state = sample()
  state.window.items = Array.from({ length: 40 }, (_, i) => ({ id: `T${i + 1}`, kind: 'T', title: `Item ${i + 1}`, isDone: false }))
  const output = render(state, 40, 15, { page: 'window', cursor: 'T30' })
  assert.match(output, /› \[ \] T30 Item 30/)
  assert.doesNotMatch(output, /T1 Item 1\n/)
  assert.ok(output.split('\n').length <= 15)
})

test('a Codex list changes in the state file at once', async t => {
  const f = fixture(t)
  await store.change('codex', state => { state.window = sample().window }, f.dir)
  assert.equal(await change('codex', 'done', ['F1'], f.env), 'Closed: F1.')
  assert.equal(await change('codex', 'skip', ['T1'], f.env), 'Moved down: T1.')
  assert.deepEqual(store.read('codex', f.dir).window.items.map(item => `${item.id}:${item.isDone}`), ['F1:true', 'T2:true', 'T1:false'])
  assert.equal(fs.existsSync(inbox.filename('codex', f.dir)), false)
})

test('a Claude list changes through the inbox, numbered after what Claude applied', async t => {
  const f = fixture(t)
  writeClaude(f, 'claude', 4)
  assert.match(await change('claude', 'done', ['F1'], f.env), /Done: F1\. Claude applies it/)
  await change('claude', 'skip', ['T1'], f.env)
  assert.deepEqual(inbox.read('claude', f.dir).map(entry => [entry.seq, entry.op, entry.ids]), [[5, 'done', ['F1']], [6, 'skip', ['T1']]])
  // The state file is Claude's: the pane leaves it alone and draws the changes on top.
  assert.equal(store.read('claude', f.dir).window.items.find(item => item.id === 'F1').isDone, false)
  const shown = withPending(store.read('claude', f.dir), f.dir)
  assert.equal(shown.pending.length, 2)
  assert.deepEqual(shown.state.window.items.map(item => `${item.id}:${item.isDone}`), ['F1:true', 'T2:true', 'T1:false'])
  assert.match(render(shown.state, 60, 40, { pending: shown.pending.length }), /2 changes waiting for Claude/)
  // Once Claude reports entry 5 applied it is dropped; when all are, the file goes.
  assert.equal((await inbox.acknowledge('claude', 5, f.dir)).length, 1)
  assert.deepEqual(inbox.read('claude', f.dir).map(entry => entry.seq), [6])
  await inbox.acknowledge('claude', 6, f.dir)
  assert.equal(fs.existsSync(inbox.filename('claude', f.dir)), false)
  assert.equal(fs.statSync(path.dirname(inbox.filename('claude', f.dir))).mode & 0o077, 0)
})

test('the plan of a Claude session cannot be cleared from the pane', async t => {
  const f = fixture(t)
  writeClaude(f, 'claude')
  const { execute } = require(path.join(adapter, 'commands.cjs'))
  await assert.rejects(execute('/todo clear', 'claude', f.env), /run \/todo clear in the Claude pane/)
  assert.match(await execute('/todo prune', 'claude', f.env), /Prune\. Claude applies it/)
  assert.match(await execute('/todo show', 'claude', f.env), /1 waiting for Claude/)
})

function panel(f, sessionId, keys) {
  return child.spawnSync(process.execPath, [path.join(adapter, 'panel.cjs'), '--session', sessionId, '--interactive'], {
    env: { ...process.env, ...f.env }, input: keys, encoding: 'utf8', timeout: 5000,
  })
}

test('/todo sessions in the command line opens the sessions page, even before a conversation is bound', t => {
  const f = fixture(t)
  // Claude Code's folders in the temporary directory, so nothing under the real home is read.
  const home = path.join(f.dir, 'home')
  const env = { ...process.env, ...f.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') }
  delete env.TMUX
  const binding = require(path.join(adapter, 'binding.cjs'))
  binding.initialize('pane-token', env)
  const out = child.spawnSync(process.execPath, [path.join(adapter, 'panel.cjs'), '--binding', 'pane-token', '--interactive'], {
    env, input: '/todo sessions\r', encoding: 'utf8', timeout: 5000,
  })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /Waiting for the conversation\.\.\.[\s\S]*WINDOW TODO · Sessions/)
  assert.doesNotMatch(out.stdout, /\/todo show \|/)
})

test('arrow keys select an item, Space marks it done and s moves it down', async t => {
  const f = fixture(t)
  await store.change('keys', state => { state.window = sample().window }, f.dir)
  const out = panel(f, 'keys', '\x1b[B \x1b[As')
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /Closed: F1\./)
  assert.match(out.stdout, /Moved down: T1\./)
  assert.deepEqual(store.read('keys', f.dir).window.items.map(item => `${item.id}:${item.isDone}`), ['F1:true', 'T2:true', 'T1:false'])
})

test('in a Claude session the keys queue inbox entries, and Space on a done item does nothing', t => {
  const f = fixture(t)
  writeClaude(f, 'ckeys', 2)
  const out = panel(f, 'ckeys', 'x\x1b[B\x1b[B ')
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /T2 is already done\./)
  assert.deepEqual(inbox.read('ckeys', f.dir).map(entry => [entry.seq, entry.op, entry.ids]), [[3, 'done', ['T1']]])
})

test('a state file caught half-written keeps the last good frame instead of an error', async t => {
  const f = fixture(t)
  writeClaude(f, 'half')
  const pane = child.spawn(process.execPath, [path.join(adapter, 'panel.cjs'), '--session', 'half', '--interactive'], { env: { ...process.env, ...f.env }, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => pane.kill())
  let stdout = ''
  pane.stdout.on('data', chunk => { stdout += chunk })
  const until = async (check, ms) => { for (const end = Date.now() + ms; Date.now() < end && !check();) await new Promise(resolve => setTimeout(resolve, 50)) }
  await until(() => stdout.includes('First task'), 3000)
  assert.match(stdout, /First task/)
  // Claude's mod writes without a rename; a reader can see the file cut short.
  fs.writeFileSync(store.filename('half', f.dir), '{"version":1,"sessionId":"ha')
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.doesNotMatch(stdout, /window-todo:/)
  writeClaude(f, 'half', 0)
  pane.stdin.end()
  await new Promise(resolve => pane.on('close', resolve))
})
