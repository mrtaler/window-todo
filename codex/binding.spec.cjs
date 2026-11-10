const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const child = require('node:child_process')
const adapter = path.resolve(__dirname, '../dist/codex')
const binding = require(path.join(adapter, 'binding.cjs'))
const store = require(path.join(adapter, 'state.cjs'))
const { handle } = require(path.join(adapter, 'hook.cjs'))
const { call } = require(path.join(adapter, 'service.cjs'))
const { prepare, interactive } = require(path.join(adapter, 'launch.cjs'))

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-todo-binding-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, env: { WINDOW_TODO_STATE_DIR: dir, WINDOW_TODO_SESSION: '', WINDOW_TODO_PANEL_BINDING: 'pane-token' } }
}

test('normal launches follow native threads and preserve caller options without inheriting a legacy list', () => {
  const setup = prepare(['-c', 'model_reasoning_effort="high"', 'resume', '--last'], { WINDOW_TODO_SESSION: 'old-list' })
  assert.equal(setup.sessionId, null)
  assert.equal(setup.environment.WINDOW_TODO_SESSION, '')
  assert.equal(setup.environment.WINDOW_TODO_PANEL_BINDING, setup.panelBinding)
  assert.deepEqual(setup.codexArgs.slice(-4), ['-c', 'model_reasoning_effort="high"', 'resume', '--last'])
  assert.match(setup.left, /run\.cjs/)
  assert.match(setup.right, /--binding/)
  const start = setup.codexArgs.find(arg => arg.startsWith('hooks.SessionStart='))
  const command = JSON.parse(start.slice(start.indexOf('command=') + 8, -4))
  assert.equal(command, `node "${path.join(adapter, 'hook.cjs')}"`)
  assert.ok(!setup.codexArgs.some(arg => arg.includes('bypass-hook-trust')))
})

test('admin, help and non-interactive commands go directly to Codex', () => {
  for (const args of [[], ['resume', '--last'], ['-p', 'dev', 'resume', 'thread'], ['fork', '--last'], ['--', '--help']]) assert.equal(interactive(args), true, args.join(' '))
  for (const args of [['--help'], ['resume', '--help'], ['--version'], ['plugin', 'list'], ['-c', 'x=1', 'exec', 'prompt'], ['-p', 'dev', 'mcp', 'list']]) assert.equal(interactive(args), false, args.join(' '))
})

test('an explicit resume ID binds the list before Codex runs its first hook', async t => {
  const f = fixture(t)
  const thread = '01a1c0ac-1763-7003-be74-5a84fb5c5b9b'
  for (const args of [['--', 'resume', thread], ['-p', 'resume', 'resume', '--all', thread], ['resume', thread, '-c', 'model_reasoning_effort="high"']]) {
    const setup = prepare(args, f.env)
    assert.equal(setup.initialThreadId, thread)
    binding.initialize(setup.panelBinding, setup.environment, setup.initialThreadId)
    assert.equal(binding.read(setup.panelBinding, setup.environment).sessionId, thread)
    await call('window', { sessionId: thread, op: 'add', kind: 'T', title: 'Visible before the first prompt' }, { env: f.env })
    const panel = child.spawnSync(process.execPath, [path.join(adapter, 'panel.cjs'), '--binding', setup.panelBinding, '--once'], { env: { ...process.env, ...setup.environment }, encoding: 'utf8' })
    assert.equal(panel.status, 0, panel.stderr)
    assert.match(panel.stdout, /Visible before the first prompt/)
    assert.ok(!panel.stdout.includes('Waiting'))
  }
  for (const args of [[], ['resume', '--last'], ['fork', thread], ['-p', 'resume', thread]]) assert.equal(prepare(args, f.env).initialThreadId, null)
})

test('the hook binds the waiting panel to the native thread; another thread and child agents stay isolated', async t => {
  const f = fixture(t)
  binding.initialize(f.env.WINDOW_TODO_PANEL_BINDING, f.env)
  const reply = await handle({ hook_event_name: 'SessionStart', session_id: 'native-a' }, f.env)
  assert.match(reply.hookSpecificOutput.additionalContext, /native-a/)
  assert.equal(binding.read('pane-token', f.env).sessionId, 'native-a')
  await handle({ hook_event_name: 'SessionStart', session_id: 'child', agent_id: 'worker' }, f.env)
  assert.equal(binding.read('pane-token', f.env).sessionId, 'native-a')
  await handle({ hook_event_name: 'SessionStart', session_id: 'native-b' }, f.env)
  await handle({ hook_event_name: 'SessionEnd', session_id: 'native-a' }, f.env)
  assert.deepEqual(binding.read('pane-token', f.env), { sessionId: 'native-b', closed: false })
  assert.equal(fs.statSync(binding.filename('pane-token', f.env)).mode & 0o777, 0o600)
})

test('resuming a native thread restores its list with a fresh terminal binding', async t => {
  const f = fixture(t)
  binding.initialize('pane-token', f.env)
  await handle({ hook_event_name: 'SessionStart', session_id: 'native' }, f.env)
  await call('window', { sessionId: 'native', op: 'add', kind: 'T', title: 'Saved task' }, { env: f.env })
  binding.close('pane-token', f.env)
  const resumed = { ...f.env, WINDOW_TODO_PANEL_BINDING: 'resumed-pane' }
  binding.initialize('resumed-pane', resumed)
  await handle({ hook_event_name: 'SessionStart', session_id: 'native', source: 'resume' }, resumed)
  assert.equal(binding.read('resumed-pane', resumed).sessionId, 'native')
  const panel = child.spawnSync(process.execPath, [path.join(adapter, 'panel.cjs'), '--binding', 'resumed-pane', '--once'], { env: { ...process.env, ...resumed }, encoding: 'utf8' })
  assert.equal(panel.status, 0, panel.stderr)
  assert.match(panel.stdout, /Saved task/)
  assert.equal(store.read('native', f.dir).window.items[0].id, 'T1')
})

test('runner closes only its own binding on normal exit and startup failure', t => {
  const f = fixture(t)
  binding.initialize('other-pane', f.env)
  for (const executable of [process.execPath, path.join(f.dir, 'missing-executable')]) {
    const env = { ...process.env, ...f.env, WINDOW_TODO_PANEL_BINDING: executable === process.execPath ? 'normal' : 'failed' }
    const run = child.spawnSync(process.execPath, [path.join(adapter, 'run.cjs'), executable, '-e', 'process.exit(7)'], { env, encoding: 'utf8' })
    assert.equal(run.status, executable === process.execPath ? 7 : 1)
    assert.equal(binding.read(env.WINDOW_TODO_PANEL_BINDING, env).closed, true)
  }
  assert.equal(binding.read('other-pane', f.env).closed, false)
})

test('a closed panel exits and removes its routing file; late hooks cannot resurrect it', async t => {
  const f = fixture(t)
  binding.initialize('pane-token', f.env)
  binding.close('pane-token', f.env)
  const panel = child.spawnSync(process.execPath, [path.join(adapter, 'panel.cjs'), '--binding', 'pane-token', '--once'], { env: { ...process.env, ...f.env }, encoding: 'utf8' })
  assert.equal(panel.status, 0, panel.stderr)
  assert.equal(binding.read('pane-token', f.env), null)
  await handle({ hook_event_name: 'SessionStart', session_id: 'late-thread' }, f.env)
  assert.equal(binding.read('pane-token', f.env), null)
})

test('a bound panel keeps watching for the conversation even when stdout is a pipe', async t => {
  const f = fixture(t)
  binding.initialize('pane-token', f.env)
  const panel = child.spawn(process.execPath, [path.join(adapter, 'panel.cjs'), '--binding', 'pane-token'], { env: { ...process.env, ...f.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (panel.exitCode === null) panel.kill('SIGTERM') })
  let output = ''
  const waiting = []
  panel.stdout.on('data', chunk => {
    output += chunk
    for (const item of waiting) if (output.includes(item.text)) item.resolve()
  })
  const closed = new Promise(resolve => panel.on('close', resolve))
  const includes = text => output.includes(text) ? Promise.resolve() : new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Panel did not render ${text}: ${output}`)), 3000)
    waiting.push({ text, resolve: () => { clearTimeout(timeout); resolve() } })
  })
  await includes('Waiting for the Codex conversation...')
  await call('window', { sessionId: 'native', op: 'add', kind: 'T', title: 'Task appeared after waiting' }, { env: f.env })
  await handle({ hook_event_name: 'SessionStart', session_id: 'native' }, f.env)
  await includes('Task appeared after waiting')
  assert.equal(panel.exitCode, null)
  assert.ok(!output.includes('\x1b'), 'Piped output must remain plain text')
  binding.close('pane-token', f.env)
  assert.equal(await closed, 0)
})

test('restarting a panel preserves the active conversation binding', async t => {
  const f = fixture(t)
  binding.initialize('pane-token', f.env, 'native')
  const panel = child.spawn(process.execPath, [path.join(adapter, 'panel.cjs'), '--binding', 'pane-token'], { env: { ...process.env, ...f.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (panel.exitCode === null) panel.kill('SIGTERM') })
  const closed = new Promise(resolve => panel.on('close', resolve))
  await new Promise(resolve => panel.stdout.once('data', resolve))
  panel.kill('SIGTERM')
  assert.equal(await closed, 0)
  assert.deepEqual(binding.read('pane-token', f.env), { sessionId: 'native', closed: false })
  const restarted = child.spawnSync(process.execPath, [path.join(adapter, 'panel.cjs'), '--binding', 'pane-token', '--once'], { env: { ...process.env, ...f.env }, encoding: 'utf8' })
  assert.equal(restarted.status, 0, restarted.stderr)
  assert.match(restarted.stdout, /Session: native/)
  assert.ok(!restarted.stdout.includes('Waiting'))
})
