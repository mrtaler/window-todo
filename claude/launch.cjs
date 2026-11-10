// Starts Claude Code on the left of a tmux session and the window-todo pane on the right: Claude keeps
// its own scrollback, the pane scrolls on its own. Not part of the Claude hooks module (nothing
// imports it); it runs under Node from a checkout or the installed plugin folder.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const child = require('node:child_process')

const root = path.resolve(__dirname, '..')
const runtime = path.join(root, 'dist', 'codex')
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
// Claude's own commands and the flags that make a run non-interactive: these go to Claude directly.
const commands = new Set(['mcp', 'plugin', 'plugins', 'doctor', 'update', 'upgrade', 'install', 'config', 'setup-token', 'migrate-installer', 'auth'])
const direct = new Set(['-p', '--print', '-h', '--help', '-v', '--version'])
// The launcher's own flag: print the two commands instead of starting tmux (Claude owns --print).
const PRINT = '--print-commands'

function interactive(args) {
  if (args.some(arg => direct.has(arg))) return false
  return !(args[0] !== undefined && commands.has(args[0]))
}

// The value of a `--name value` or `--name=value` option, or undefined.
function optionValue(args, names) {
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1)
      if (args[i] === name) return args[i + 1] !== undefined && !args[i + 1].startsWith('-') ? args[i + 1] : ''
    }
  }
  return undefined
}

// The session Claude will run under, when the launcher can know it before Claude starts: a new
// one it chooses (`--session-id`), or the one named by `--session-id` or `--resume <id>`. Null for
// `--continue`, the `--resume` picker and `--fork-session`; the mod then binds the pane itself.
function chooseSession(args) {
  if (args.includes('--fork-session')) return { sessionId: null, args }
  const given = optionValue(args, ['--session-id'])
  if (given) return { sessionId: given, args }
  const resumed = optionValue(args, ['-r', '--resume'])
  if (resumed !== undefined) return { sessionId: UUID.test(resumed) ? resumed : null, args }
  if (args.includes('-c') || args.includes('--continue')) return { sessionId: null, args }
  const sessionId = crypto.randomUUID()
  return { sessionId, args: ['--session-id', sessionId, ...args] }
}

// Builds dist/ (the pane and the shared core) when it is missing, as in a fresh plugin install.
function ensureBuilt(base = root) {
  const needed = ['dist/codex/panel.cjs', 'dist/codex/inbox.cjs', 'dist/codex/tmux.cjs', 'dist/shared/inbox.js']
  if (needed.every(file => fs.existsSync(path.join(base, file)))) return
  const hint = `Build it with: cd ${JSON.stringify(base)} && npm ci && npm run build`
  if (!fs.existsSync(path.join(base, 'node_modules', 'typescript'))) throw new Error(`The window-todo pane is not built and TypeScript is not installed. ${hint}`)
  const result = child.spawnSync(process.execPath, [path.join(base, 'scripts', 'build.js')], { cwd: base, stdio: ['ignore', 'ignore', 'inherit'] })
  if (result.status !== 0) throw new Error(`Building the window-todo pane failed. ${hint}`)
}

function prepare(args = [], env = process.env) {
  const store = require(path.join(runtime, 'state.cjs'))
  const { command } = require(path.join(runtime, 'tmux.cjs'))
  const chosen = chooseSession(args)
  const panelBinding = crypto.randomUUID()
  const stateDir = path.resolve(store.directory(env))
  const environment = {
    WINDOW_TODO_PANE: '1',
    WINDOW_TODO_STATE_DIR: stateDir,
    WINDOW_TODO_PANEL_BINDING: panelBinding,
    WINDOW_TODO_INITIAL_THREAD: chosen.sessionId || '',
  }
  const claudeArgs = ['claude', ...chosen.args]
  // run.cjs binds the pane to the initial session and closes the binding when Claude exits.
  const left = command([process.execPath, path.join(runtime, 'run.cjs'), ...claudeArgs], environment)
  const right = command([process.execPath, path.join(runtime, 'panel.cjs'), '--binding', panelBinding], { WINDOW_TODO_STATE_DIR: stateDir })
  return { sessionId: chosen.sessionId, panelBinding, stateDir, environment, claudeArgs, left, right }
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const print = args.includes(PRINT)
  const rest = args.filter(arg => arg !== PRINT)
  if (!print && !interactive(rest)) {
    const result = child.spawnSync('claude', rest, { stdio: 'inherit' })
    if (result.error) console.error(result.error.message)
    process.exit(result.status ?? 1)
  }
  try { ensureBuilt() }
  catch (error) { console.error(error.message); process.exit(1) }
  const setup = prepare(rest)
  // The mod writes with the default file mode; a private directory keeps the plan to this user.
  fs.mkdirSync(setup.stateDir, { recursive: true, mode: 0o700 })
  if (print) {
    console.log(JSON.stringify({ sessionId: setup.sessionId, claude: setup.left, panel: setup.right }, null, 2))
  } else {
    const tmux = require(path.join(runtime, 'tmux.cjs'))
    const binding = require(path.join(runtime, 'binding.cjs'))
    if (!tmux.available()) {
      console.error(`tmux is required for two panes in one terminal. Install it, or use ${PRINT} to run the two commands in terminal splits. On macOS: brew install tmux`)
      process.exit(1)
    }
    tmux.open({
      left: setup.left,
      right: setup.right,
      label: 'Claude',
      mouse: true,
      notice: setup.sessionId ? `window-todo: Claude session ${setup.sessionId}.` : undefined,
      cleanup: () => binding.close(setup.panelBinding, { ...process.env, WINDOW_TODO_STATE_DIR: setup.stateDir }),
    })
  }
}
module.exports = { prepare, interactive, chooseSession, ensureBuilt }
