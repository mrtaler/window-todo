const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const child = require('node:child_process')
const adapter = path.resolve(__dirname, '../dist/codex')
const store = require(path.join(adapter, 'state.cjs'))
const sessions = require(path.join(adapter, 'sessions.cjs'))
const { render } = require(path.join(adapter, 'panel.cjs'))
const strip = text => text.replace(/\x1b\[[0-9;]*m/g, '')

const NOW = new Date(2026, 10, 12, 12).getTime()
const HOUR = 60 * 60 * 1000
const item = (id, extra = {}) => ({ id, kind: id[0], title: `${id} title`, isDone: false, ...extra })
const list = (...items) => ({ items, issued: { T: 9, F: 9, Q: 9, W: 9 } })
const line = value => JSON.stringify(value) + '\n'

// A home folder in a temporary directory: Claude Code's stores, sessions files and transcripts, and
// the window-todo state directory, as the real ones are laid out. Nothing under the real home is read.
function world(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'window-todo-sessions-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const claude = path.join(home, '.claude')
  const state = path.join(home, 'state')
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
  const storeFile = (name, entries) => write(path.join(claude, 'plugins', 'store', name), JSON.stringify(entries))
  const transcript = (cwd, id, text) => write(path.join(claude, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`), text)
  const sessionFile = (pid, value) => write(path.join(claude, 'sessions', `${pid}.json`), JSON.stringify({ pid, ...value }))
  const env = { HOME: home, CLAUDE_CONFIG_DIR: claude, WINDOW_TODO_STATE_DIR: state, CODEX_HOME: path.join(home, '.codex') }
  return { home, claude, state, env, write, storeFile, transcript, sessionFile }
}

// Every store a machine may hold: the installed one, an earlier marketplace's, and a backup that
// must not count. Session `a` has a newer list in the installed store, where it is all done.
function stores(w) {
  w.storeFile('window-todo_mrtaler-1.json', {
    'window:aaaaaaaa-1': { updatedAt: NOW - 1 * HOUR, list: list(item('T1', { isDone: true })) },
    'window:bbbbbbbb-2': { updatedAt: NOW - 2 * HOUR, list: list(item('W1', { due: '2026-11-11' }), item('T2')) },
    'window:cccccccc-3': { updatedAt: NOW - 3 * HOUR, list: list(item('F1')) },
    'carry:window:x': { from: 'z', at: NOW, list: list(item('T1')) },
    accentColor: 'claude',
  })
  w.storeFile('window-todo_old-market-2.json', {
    'window:aaaaaaaa-1': { updatedAt: NOW - 9 * HOUR, list: list(item('T1')) },
    'window:dddddddd-4': { updatedAt: NOW - 30 * HOUR, list: list(item('Q1')) },
  })
  w.storeFile('window-todo_mrtaler-1.before-merge-17.json', { 'window:eeeeeeee-5': { updatedAt: NOW, list: list(item('T1')) } })
}

test('the rows merge every store, skip backups and done lists, and put the due session first', t => {
  const w = world(t)
  stores(w)
  const { rows, notes } = sessions.collect({ env: w.env, now: NOW, starts: () => new Map() })
  assert.deepEqual(rows.map(row => row.sessionId), ['bbbbbbbb-2', 'cccccccc-3', 'dddddddd-4'])
  assert.deepEqual(rows.map(row => row.open), [2, 1, 1])
  assert.equal(rows[0].dueState, 'overdue')
  assert.deepEqual(notes, [])
})

test('a running session is one whose sessions file names a live pid that started then; key files are never read', t => {
  const w = world(t)
  stores(w)
  w.sessionFile(101, { sessionId: 'bbbbbbbb-2', cwd: '/live', tmux: 'window-todo-1:@3.%4', procStart: 'Thu Nov 12 10:00:00 2026' })
  w.sessionFile(102, { sessionId: 'cccccccc-3', cwd: '/reused', procStart: 'Thu Nov 12 09:00:00 2026' })
  w.sessionFile(103, { sessionId: 'dddddddd-4', procStart: 'Thu Nov 12 09:00:00 2026' })
  // A key file holds a secret; one that does not parse as JSON shows it was not opened.
  w.write(path.join(w.claude, 'sessions', '101.deadbeef.key'), 'secret')
  const asked = []
  const starts = pids => { asked.push(pids); return new Map([[101, 'Thu Nov 12 11:00:00 2026'], [102, 'Thu Nov 12 11:30:07 2026']]) }
  const { rows } = sessions.collect({ env: w.env, now: NOW, starts })
  assert.deepEqual(asked.map(pids => [...pids].sort()), [[101, 102, 103]])
  const byId = Object.fromEntries(rows.map(row => [row.sessionId, row]))
  assert.equal(byId['bbbbbbbb-2'].isRunning, true)
  assert.equal(byId['bbbbbbbb-2'].tmux, 'window-todo-1:@3.%4')
  assert.equal(byId['bbbbbbbb-2'].cwd, '/live')
  // pid 102 runs, but a process started at another time: its pid was reused.
  assert.equal(byId['cccccccc-3'].isRunning, false)
  assert.equal(byId['dddddddd-4'].isRunning, false)
})

test('folder and title come from the transcript, read in bounded parts even when it is large', t => {
  const w = world(t)
  stores(w)
  // A transcript larger than the tail read: the prompt at the start, titles far from the start.
  const big = line({ type: 'user', message: { content: 'first prompt of b' }, cwd: '/Users/me/repo' }) +
    line({ type: 'user', message: { content: 'x'.repeat(sessions.TAIL_BYTES) } }) +
    line({ type: 'ai-title', aiTitle: 'AI title of b' }) + line({ type: 'custom-title', customTitle: 'named b' }) + line({ type: 'ai-title', aiTitle: 'AI title of b' })
  w.transcript('/Users/me/repo', 'bbbbbbbb-2', big)
  // A small one with only a prompt, filed under another folder than the session's.
  w.transcript('/elsewhere', 'cccccccc-3', line({ type: 'user', message: { content: '<command-name>/clear</command-name>' }, cwd: '/c' }) + line({ type: 'user', message: { content: 'typed for c' }, cwd: '/c' }))
  const reads = []
  const open = fs.openSync
  fs.openSync = (file, ...rest) => { reads.push(file); return open(file, ...rest) }
  t.after(() => { fs.openSync = open })
  const cache = new Map()
  const first = sessions.collect({ env: w.env, now: NOW, starts: () => new Map(), cache })
  const byId = Object.fromEntries(first.rows.map(row => [row.sessionId, row]))
  assert.deepEqual([byId['bbbbbbbb-2'].title, byId['bbbbbbbb-2'].cwd], ['named b', '/Users/me/repo'])
  assert.deepEqual([byId['cccccccc-3'].title, byId['cccccccc-3'].cwd], ['typed for c', '/c'])
  assert.equal(byId['dddddddd-4'].title, undefined)
  // A second pass reads nothing that has not changed.
  const before = reads.length
  sessions.collect({ env: w.env, now: NOW, starts: () => new Map(), cache })
  assert.equal(reads.length, before)
})

test('a Codex list is listed with its thread folder and title; a Claude mirror in the state directory is not', async t => {
  const w = world(t)
  await store.change('codex-thread', state => { state.window = list(item('T1')) }, w.state)
  fs.writeFileSync(store.filename('mirror', w.state), JSON.stringify({ ...store.emptyState('mirror'), client: 'claude', window: list(item('T1')) }))
  const asked = []
  const threads = ids => { asked.push(ids); return new Map([['codex-thread', { cwd: '/codex', title: 'Codex title' }]]) }
  const { rows } = sessions.collect({ env: w.env, now: NOW, starts: () => new Map(), threads })
  assert.deepEqual(asked, [['codex-thread']])
  assert.deepEqual(rows.map(row => [row.sessionId, row.client, row.cwd, row.title]), [['codex-thread', 'codex', '/codex', 'Codex title']])
})

const row = extra => ({ sessionId: 'bbbbbbbb-2222', client: 'claude', isRunning: false, isCurrent: false, open: 1, updatedAt: NOW, ...extra })

test('Enter on a running session in tmux switches the client to its pane, after checking the pane is there', () => {
  const calls = []
  const run = (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: 'window-todo-1\n', stderr: '' } }
  const said = sessions.openSession(row({ isRunning: true, tmux: 'window-todo-1:@3.%4' }), { env: { TMUX: '/tmp/x,1,0' }, run })
  assert.equal(said, 'Switched to bbbbbbbb in window-todo-1.')
  assert.deepEqual(calls, [['tmux', 'display-message', '-p', '-t', '%4', '#{session_name}'], ['tmux', 'switch-client', '-t', 'window-todo-1:@3.%4']])
  const gone = sessions.openSession(row({ isRunning: true, tmux: 'window-todo-1:@3.%4' }), { env: { TMUX: 'x' }, run: () => ({ status: 1, stderr: "can't find pane" }) })
  assert.match(gone, /pane %4 is not there/)
  assert.match(sessions.openSession(row({ isRunning: true, tmux: 'window-todo-1:@3.%4' }), { env: {}, run }), /tmux attach -t window-todo-1/)
  assert.match(sessions.openSession(row({ isRunning: true }), { env: { TMUX: 'x' }, run }), /runs outside tmux/)
  assert.match(sessions.openSession(row({ isCurrent: true, isRunning: true }), { env: { TMUX: 'x' }, run }), /session of this pane/)
})

test('Enter on a stopped session resumes it through its launcher in its own folder; outside tmux it only says how', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'window-todo-resume-'))
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  const calls = []
  const run = (command, args, options) => { calls.push({ command, args, cwd: options.cwd }); return { status: 0, stdout: '', stderr: '' } }
  const paths = { claude: path.resolve(__dirname, '../claude/launch.cjs'), codex: path.join(adapter, 'launch.cjs') }
  assert.equal(sessions.openSession(row({ cwd: folder }), { env: { TMUX: 'x' }, run, paths }), `Resumed bbbbbbbb in ${folder} beside its pane.`)
  assert.deepEqual(calls.at(-1), { command: process.execPath, args: [paths.claude, '--resume', 'bbbbbbbb-2222'], cwd: folder })
  sessions.openSession(row({ cwd: folder, client: 'codex' }), { env: { TMUX: 'x' }, run, paths })
  assert.deepEqual(calls.at(-1).args, [paths.codex, 'resume', 'bbbbbbbb-2222'])
  assert.equal(calls.length, 2)
  assert.equal(sessions.openSession(row({ cwd: folder }), { env: {}, run, paths }), `Not inside tmux. Resume it with: cd ${folder} && claude --resume bbbbbbbb-2222`)
  assert.match(sessions.openSession(row({ cwd: '/no/such/folder' }), { env: { TMUX: 'x' }, run, paths }), /is not there/)
  assert.match(sessions.openSession(row({ cwd: folder }), { env: { TMUX: 'x' }, run: () => ({ status: 1, stderr: 'tmux new-session failed\n' }), paths }), /Resume failed \(tmux new-session failed\)/)
  assert.equal(calls.length, 2)
})

test('the sessions page draws two rows a session, marks the running and the due ones, and the cursor', () => {
  const data = {
    home: '/Users/me',
    notes: ['Store x could not be read.'],
    rows: [
      row({ sessionId: 'aaaaaaaa-1', isRunning: true, open: 3, due: '2026-11-11', dueState: 'overdue', cwd: '/Users/me/repo', title: 'Waiting on DBA', updatedAt: NOW - 2 * HOUR }),
      row({ sessionId: 'bbbbbbbb-2', open: 1, cwd: '/tmp', title: 'Other', updatedAt: NOW - 30 * HOUR, client: 'codex' }),
    ],
  }
  const plain = render(store.emptyState('s'), 60, 30, { page: 'sessions', sessions: data, now: NOW })
  assert.match(plain, /WINDOW TODO · Sessions/)
  assert.match(plain, /2 sessions with open items/)
  assert.match(plain, /● aaaaaaaa  3 open  !11-11  2h\n  ~\/repo · Waiting on DBA/)
  assert.match(plain, /○ bbbbbbbb  1 open  30h  codex\n  \/tmp · Other/)
  assert.match(plain, /Store x could not be read\./)
  const colored = render(store.emptyState('s'), 60, 30, { page: 'sessions', sessions: data, now: NOW, color: true, sessionCursor: 'bbbbbbbb-2', footer: false })
  assert.ok(colored.includes('\x1b[1;31m!11-11\x1b[0m'))
  assert.ok(colored.includes('\x1b[1;32m●\x1b[0m'))
  assert.match(strip(colored), /› ○ bbbbbbbb/)
  assert.match(strip(colored), /  ● aaaaaaaa/)
  const many = { rows: Array.from({ length: 35 }, (_, i) => row({ sessionId: `${String(i).padStart(8, '0')}-x`, updatedAt: NOW - i * HOUR })) }
  const capped = render(store.emptyState('s'), 60, 200, { page: 'sessions', sessions: many, now: NOW })
  assert.match(capped, /\+5 more/)
  assert.doesNotMatch(capped, /00000030/)
  assert.match(render(store.emptyState('s'), 60, 30, { page: 'sessions', sessions: null }), /Reading the sessions/)
})

test('the window list in the pane shows each day, coloured once it has come', () => {
  const state = store.emptyState('s')
  state.window = list(item('W1', { due: '2026-11-15' }), item('W2', { due: '2026-11-12' }), item('W3', { due: '2026-11-01' }), item('T1'))
  const plain = render(state, 60, 30, { page: 'window', now: NOW })
  assert.match(plain, /\[ \] W1 W1 title · 11-15/)
  assert.match(plain, /T1 W3 \(2 due\)/)
  const colored = render(state, 60, 30, { page: 'window', now: NOW, color: true })
  assert.ok(colored.includes('\x1b[1;33m11-12\x1b[0m'))
  assert.ok(colored.includes('\x1b[1;31m11-01\x1b[0m'))
  assert.ok(colored.includes('\x1b[2m11-15\x1b[0m'))
})

function panel(w, keys, args = []) {
  const env = { ...process.env, ...w.env }
  delete env.TMUX
  return child.spawnSync(process.execPath, [path.join(adapter, 'panel.cjs'), '--interactive', ...args], { env, input: keys, encoding: 'utf8', timeout: 8000 })
}

test('--page 4 opens the sessions page without a conversation; Tab and 4 reach it, Enter acts on the selected row', async t => {
  const w = world(t)
  stores(w)
  const once = child.spawnSync(process.execPath, [path.join(adapter, 'panel.cjs'), '--once', '--page', 'sessions'], { env: { ...process.env, ...w.env, WINDOW_TODO_SESSION: '' }, encoding: 'utf8' })
  assert.equal(once.status, 0, once.stderr)
  assert.match(once.stdout, /3 sessions with open items/)
  assert.match(once.stdout, /bbbbbbbb  2 open  !11-11/)
  const bad = child.spawnSync(process.execPath, [path.join(adapter, 'panel.cjs'), '--once', '--page', '9'], { env: { ...process.env, ...w.env }, encoding: 'utf8' })
  assert.match(bad.stderr, /--page takes 0 or overview/)
  await store.change('mine', state => { state.window = list(item('T1')) }, w.state)
  // Tab four times from the combined view, then down past this pane's own session (the newest) to
  // the third row and Enter: outside tmux the pane says how to resume it and runs nothing.
  const out = panel(w, '\t\t\t\t\x1b[B\x1b[B\r', ['--session', 'mine'])
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /WINDOW TODO · Sessions/)
  assert.match(out.stdout, /Not inside tmux\. Resume it with: claude --resume cccccccc-3/)
  const direct = panel(w, '4\r', ['--session', 'mine'])
  assert.match(direct.stdout, /Not inside tmux\. Resume it with: claude --resume bbbbbbbb-2/)
  const own = panel(w, '4\x1b[B\r', ['--session', 'mine'])
  assert.match(own.stdout, /mine is the session of this pane\./)
})
