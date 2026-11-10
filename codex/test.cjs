const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const child = require('node:child_process')
const store = require('./state.cjs')
const { call } = require('./service.cjs')
const { handle } = require('./hook.cjs')
const { render } = require('./panel.cjs')
const { prepare } = require('./launch.cjs')

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-todo-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { directory: dir, env: { WINDOW_TODO_STATE_DIR: dir } }
}

function mcp(rows, env) {
  return new Promise((resolve, reject) => {
    const process = child.spawn(global.process.execPath, [path.join(__dirname, 'mcp.cjs')], { env: { ...global.process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    process.stdout.on('data', value => { stdout += value })
    process.stderr.on('data', value => { stderr += value })
    process.on('error', reject)
    process.on('close', code => {
      try { assert.equal(code, 0, stderr); resolve(stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))) }
      catch (error) { reject(error) }
    })
    process.stdin.end(rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n')
  })
}

test('MCP negotiates versions, lists tools, persists changes and reports invalid requests', async t => {
  const f = fixture(t)
  const replies = await mcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'window', arguments: { op: 'add', kind: 'Q', title: 'Pick a color' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'window', arguments: { op: 'add', kind: 'invalid', title: 'Never saved' } } },
    '{invalid',
  ], { ...f.env, WINDOW_TODO_SESSION: 'conversation' })
  assert.equal(replies.length, 5)
  assert.equal(replies[0].result.protocolVersion, '2025-03-26')
  assert.deepEqual(replies[1].result.tools.map(tool => tool.name), ['plan', 'window'])
  assert.match(replies[2].result.content[0].text, /Added Q1/)
  assert.equal(replies[3].result.isError, true)
  assert.equal(replies[4].error.code, -32700)
  assert.equal(store.read('conversation', f.directory).window.items.length, 1)
})

test('parallel MCP processes keep all items and never issue duplicate IDs', async t => {
  const f = fixture(t)
  await Promise.all(Array.from({ length: 3 }, (_, worker) => mcp(Array.from({ length: 8 }, (_, index) => ({ jsonrpc: '2.0', id: index, method: 'tools/call', params: { name: 'window', arguments: { op: 'add', kind: 'T', title: `Task ${worker}:${index}` } } })), { ...f.env, WINDOW_TODO_SESSION: 'shared' })))
  const list = store.read('shared', f.directory).window
  assert.equal(list.items.length, 24)
  assert.equal(new Set(list.items.map(item => item.id)).size, 24)
  assert.equal(list.issued.T, 24)
})

test('close, skip and prune survive restart, preserve counters and isolate sessions', async t => {
  const f = fixture(t)
  await call('window', { sessionId: 'one', op: 'add', kind: 'F', title: 'First' }, f)
  await call('window', { sessionId: 'one', op: 'add', kind: 'F', title: 'Second' }, f)
  await call('window', { sessionId: 'one', op: 'done', ids: ['F1'] }, f)
  await call('window', { sessionId: 'one', op: 'prune' }, f)
  await call('window', { sessionId: 'one', op: 'add', kind: 'F', title: 'Third' }, f)
  await call('window', { sessionId: 'one', op: 'skip', ids: ['F2'] }, f)
  const state = store.read('one', f.directory)
  assert.deepEqual(state.window.items.map(item => item.id), ['F3', 'F2'])
  const restarted = await mcp([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'window', arguments: { op: 'show' } } }], { ...f.env, WINDOW_TODO_SESSION: 'one' })
  assert.match(restarted[0].result.content[0].text, /F3/)
  assert.equal(store.read('two', f.directory).window.items.length, 0)
  await assert.rejects(call('window', { op: 'show' }, { ...f, env: {} }), /sessionId/)
  assert.equal(fs.statSync(store.filename('one', f.directory)).mode & 0o777, 0o600)
})

test('shared plan reducers roll up children and render the companion tree', async t => {
  const f = fixture(t)
  await call('plan', { sessionId: 'plan', op: 'set', title: 'Task', nodes: [{ title: 'Group', children: [{ title: 'Inspect' }, { title: 'Implement' }] }] }, f)
  await call('plan', { sessionId: 'plan', op: 'update', updates: [{ id: '1.1', status: 'completed' }, { id: '1.2', status: 'blocked', note: 'Waiting for input' }] }, f)
  await call('window', { sessionId: 'plan', op: 'add', kind: 'Q', title: 'Which option?\u001b[2J' }, f)
  const output = render(store.read('plan', f.directory), 80, 35)
  assert.match(output, /Inspect/)
  assert.match(output, /Waiting for input/)
  assert.match(output, /Q1/)
  assert.ok(!output.includes('\u001b'))
  const before = fs.readFileSync(store.filename('plan', f.directory), 'utf8')
  await assert.rejects(call('plan', { sessionId: 'plan', op: 'update', updates: [{ id: 'missing', status: 'completed' }] }, f))
  assert.equal(fs.readFileSync(store.filename('plan', f.directory), 'utf8'), before)
})

test('hooks use the launcher session, remain advisory by default and allow planning', async t => {
  const f = fixture(t)
  const env = { ...f.env, WINDOW_TODO_SESSION: 'launcher' }
  const start = await handle({ hook_event_name: 'SessionStart', session_id: 'native' }, env)
  assert.match(start.hookSpecificOutput.additionalContext, /launcher/)
  const event = { hook_event_name: 'PreToolUse', session_id: 'native', tool_name: 'Bash' }
  assert.deepEqual(await handle(event, env), {})
  const enforced = { ...env, WINDOW_TODO_ENFORCE: 'true' }
  for (const tool_name of ['Bash', 'apply_patch', 'exec_command']) assert.equal((await handle({ ...event, tool_name }, enforced)).hookSpecificOutput.permissionDecision, 'deny', tool_name)
  assert.deepEqual(await handle({ ...event, tool_name: 'mcp__window-todo__plan' }, enforced), {})
  await call('plan', { op: 'set', title: 'Task', nodes: [{ title: 'Edit' }] }, { ...f, env })
  assert.deepEqual(await handle(event, enforced), {})
  assert.deepEqual(await handle({ ...event, agent_id: 'child' }, enforced), {})
  assert.equal(store.read('native', f.directory).plan.nodes.length, 0)
})

test('an unavailable plan cannot trap the session in an endless gate loop', async t => {
  const f = fixture(t)
  const env = { ...f.env, WINDOW_TODO_SESSION: 'gate', WINDOW_TODO_ENFORCE: 'true' }
  const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash' }
  for (let index = 0; index < 3; index++) assert.equal((await handle(event, env)).hookSpecificOutput.permissionDecision, 'deny')
  assert.deepEqual(await handle(event, env), {})
  await handle({ hook_event_name: 'UserPromptSubmit' }, env)
  assert.equal((await handle(event, env)).hookSpecificOutput.permissionDecision, 'deny')
})

test('corrupt state is preserved and hook failures do not block tools', async t => {
  const f = fixture(t)
  const file = store.filename('broken', f.directory)
  fs.writeFileSync(file, '{bad data')
  await assert.rejects(call('window', { sessionId: 'broken', op: 'add', kind: 'T', title: 'Not written' }, f))
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad data')
  const out = child.spawnSync(process.execPath, [path.join(__dirname, 'hook.cjs')], { input: JSON.stringify({ hook_event_name: 'PreToolUse' }), encoding: 'utf8', env: { ...process.env, ...f.env, WINDOW_TODO_SESSION: 'broken' } })
  assert.equal(out.status, 0)
  assert.deepEqual(JSON.parse(out.stdout), {})
})

test('launcher gives both panes one session, quotes paths and preserves Codex options', () => {
  const setup = prepare(['--session', 'resume-key', '--enforce', '--', 'resume', 'thread-id'], { WINDOW_TODO_STATE_DIR: "/tmp/path with 'quotes'" })
  assert.equal(setup.sessionId, 'resume-key')
  assert.equal(setup.environment.WINDOW_TODO_ENFORCE, 'true')
  assert.deepEqual(setup.codexArgs.slice(-2), ['resume', 'thread-id'])
  assert.ok(setup.left.includes('WINDOW_TODO_SESSION=') && setup.right.includes('WINDOW_TODO_SESSION='))
  assert.ok(setup.left.includes("'\"'\"'"))
  assert.ok(!setup.codexArgs.includes('--dangerously-bypass-hook-trust'))
})

function locked(t) {
  const f = fixture(t)
  const lock = store.filename('locked', f.directory) + '.lock'
  const old = Date.now() / 1000 - 60
  const add = () => store.change('locked', state => { state.window.items.push({ id: 'T1' }) }, f.directory)
  return { directory: f.directory, lock, old, add }
}

test('an old lock directory left by the previous lock format is reclaimed', async t => {
  const l = locked(t)
  fs.mkdirSync(l.lock)
  fs.utimesSync(l.lock, l.old, l.old)
  await l.add()
  assert.equal(fs.existsSync(l.lock), false)
  assert.deepEqual(fs.readdirSync(l.directory).filter(name => name.includes('.stale.')), [])
})

test('an old empty lock file is reclaimed', async t => {
  const l = locked(t)
  fs.writeFileSync(l.lock, '')
  fs.utimesSync(l.lock, l.old, l.old)
  await l.add()
  assert.equal(fs.existsSync(l.lock), false)
})

test('a fresh lock held by a dead process is reclaimed at once', async t => {
  const l = locked(t)
  fs.writeFileSync(l.lock, String(child.spawnSync(process.execPath, ['-e', '']).pid))
  const started = Date.now()
  await l.add()
  assert.ok(Date.now() - started < 1000)
  assert.equal(fs.existsSync(l.lock), false)
})

test('an old lock held by a live process is never reclaimed', async t => {
  const l = locked(t)
  fs.writeFileSync(l.lock, String(process.pid))
  fs.utimesSync(l.lock, l.old, l.old)
  await assert.rejects(l.add(), /busy/)
  assert.equal(fs.readFileSync(l.lock, 'utf8'), String(process.pid))
})
