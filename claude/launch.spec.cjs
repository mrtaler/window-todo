const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { prepare, interactive, chooseSession, ensureBuilt } = require('./launch.cjs')

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

test('a new session gets its id from the launcher, so both panes know it before Claude starts', () => {
  const setup = prepare(['--model', 'opus'], { WINDOW_TODO_STATE_DIR: "/tmp/state with 'quotes'" })
  assert.match(setup.sessionId, UUID)
  assert.deepEqual(setup.claudeArgs, ['claude', '--session-id', setup.sessionId, '--model', 'opus'])
  assert.deepEqual(setup.environment, {
    WINDOW_TODO_PANE: '1',
    WINDOW_TODO_STATE_DIR: "/tmp/state with 'quotes'",
    WINDOW_TODO_PANEL_BINDING: setup.panelBinding,
    WINDOW_TODO_INITIAL_THREAD: setup.sessionId,
  })
  assert.ok(setup.left.includes("WINDOW_TODO_PANE='1'"))
  assert.ok(setup.left.includes(path.join('dist', 'codex', 'run.cjs')))
  assert.ok(setup.left.includes(`'--session-id' '${setup.sessionId}'`))
  assert.ok(setup.left.includes("'\"'\"'"))
  assert.ok(setup.right.includes(path.join('dist', 'codex', 'panel.cjs')))
  assert.ok(setup.right.includes(`'--binding' '${setup.panelBinding}'`))
  // The pane needs only the directory; the enable flag is for Claude's mod.
  assert.ok(!setup.right.includes('WINDOW_TODO_PANE'))
})

test('a resumed, continued or forked session keeps Claude\'s own choice of id', () => {
  const id = '0b9a3f4c-1d2e-4f5a-8b6c-7d8e9f0a1b2c'
  assert.deepEqual(chooseSession(['--resume', id]), { sessionId: id, args: ['--resume', id] })
  assert.deepEqual(chooseSession([`--session-id=${id}`]), { sessionId: id, args: [`--session-id=${id}`] })
  assert.equal(chooseSession(['-r']).sessionId, null)
  assert.equal(chooseSession(['--continue']).sessionId, null)
  assert.equal(chooseSession(['--resume', id, '--fork-session']).sessionId, null)
  assert.deepEqual(chooseSession(['-c']).args, ['-c'])
  const unbound = prepare(['--continue'], { WINDOW_TODO_STATE_DIR: '/tmp/x' })
  assert.equal(unbound.environment.WINDOW_TODO_INITIAL_THREAD, '')
  assert.deepEqual(unbound.claudeArgs, ['claude', '--continue'])
})

test('a relative state directory is made absolute for both panes', () => {
  const setup = prepare([], { WINDOW_TODO_STATE_DIR: 'relative/state' })
  assert.equal(setup.environment.WINDOW_TODO_STATE_DIR, path.resolve('relative/state'))
})

test('help, version, print mode and Claude\'s own commands run without tmux', () => {
  for (const args of [['-p', 'hi'], ['--print'], ['--help'], ['-v'], ['mcp', 'list'], ['plugin', 'install', 'x'], ['doctor']]) assert.equal(interactive(args), false, args.join(' '))
  for (const args of [[], ['--model', 'opus'], ['fix the plugin'], ['--resume']]) assert.equal(interactive(args), true, args.join(' '))
})

test('a folder without the built pane and without TypeScript gets a build instruction', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'window-todo-launch-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  assert.throws(() => ensureBuilt(base), /npm ci && npm run build/)
  for (const file of ['dist/codex/panel.cjs', 'dist/codex/inbox.cjs', 'dist/codex/tmux.cjs', 'dist/codex/sessions.cjs', 'dist/shared/inbox.js', 'dist/shared/sessions.js']) {
    fs.mkdirSync(path.dirname(path.join(base, file)), { recursive: true })
    fs.writeFileSync(path.join(base, file), '')
  }
  assert.doesNotThrow(() => ensureBuilt(base))
})
