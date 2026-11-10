require('./runtime.cjs').ensureRuntime({ host: process })
const path = require('node:path')
const crypto = require('node:crypto')
const child = require('node:child_process')
const store = require('./state.cjs')
const binding = require('./binding.cjs')

const quote = text => "'" + String(text).replaceAll("'", "'\"'\"'") + "'"

function command(args, env) {
  return [...Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`), ...args.map(quote)].join(' ')
}

const valueOptions = new Set(['-c', '--config', '-p', '--profile', '-m', '--model', '-C', '--cd', '-s', '--sandbox', '-a', '--ask-for-approval', '-i', '--image', '--add-dir', '--remote', '--remote-auth-token-env', '--enable', '--disable', '--session'])

function firstPositional(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') return -1
    if (valueOptions.has(args[i])) { i++; continue }
    if (!args[i].startsWith('-')) return i
  }
  return -1
}

function resumeThread(args) {
  const commandIndex = firstPositional(args)
  if (args[commandIndex] !== 'resume') return null
  const rest = args.slice(commandIndex + 1)
  const candidate = rest[firstPositional(rest)]
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(candidate || '') ? candidate : null
}

function prepare(args = [], env = process.env) {
  const options = [...args]
  const sessionIndex = options.indexOf('--session')
  const sessionId = sessionIndex >= 0 ? store.sessionFrom({ sessionId: options.splice(sessionIndex, 2)[1] }, env) : null
  const panelBinding = sessionId ? null : crypto.randomUUID()
  const enforceIndex = options.indexOf('--enforce')
  const enforce = enforceIndex >= 0
  if (enforce) options.splice(enforceIndex, 1)
  if (options[0] === '--') options.shift()
  const initialThreadId = sessionId ? null : resumeThread(options)
  const stateDir = store.directory(env)
  const environment = { WINDOW_TODO_SESSION: sessionId || '', WINDOW_TODO_PANEL_BINDING: panelBinding || '', WINDOW_TODO_INITIAL_THREAD: initialThreadId || '', WINDOW_TODO_STATE_DIR: stateDir, WINDOW_TODO_ENFORCE: String(enforce) }
  // Use Node from PATH, as the installed plugin hooks do.
  const hookPath = path.join(__dirname, 'hook.cjs').replace(/[\\"$`]/g, character => '\\' + character)
  const hookCommand = `node "${hookPath}"`
  const hookArgs = panelBinding ? ['SessionStart', 'SessionEnd'].flatMap(event => ['-c', `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(hookCommand)}}]}]`]) : []
  const codexArgs = ['codex', '--no-daemon',
    '-c', 'mcp_servers.window-todo.command=' + JSON.stringify(process.execPath),
    '-c', 'mcp_servers.window-todo.args=' + JSON.stringify([path.join(__dirname, 'mcp.cjs')]),
    '-c', 'mcp_servers.window-todo.env=' + '{' + Object.entries(environment).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(',') + '}',
    ...hookArgs, ...options]
  const leftArgs = panelBinding ? [process.execPath, path.join(__dirname, 'run.cjs'), ...codexArgs] : codexArgs
  const panelArgs = [process.execPath, path.join(__dirname, 'panel.cjs'), ...(panelBinding ? ['--binding', panelBinding] : [])]
  return { sessionId, panelBinding, initialThreadId, environment, codexArgs, left: command(leftArgs, environment), right: command(panelArgs, environment) }
}

function interactive(args) {
  const commands = new Set(['exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'queue', 'archive', 'delete', 'migrate-rollouts', 'migrate-nfs-db', 'unarchive', 'cloud', 'exec-server', 'features', 'help'])
  let positional = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') return true
    if (['--help', '-h', '--version', '-V'].includes(arg)) return false
    if (valueOptions.has(arg)) { i++; continue }
    if (arg.startsWith('-')) continue
    if (!positional && commands.has(arg)) return false
    positional = true
  }
  return true
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const print = args.includes('--print')
  if (!print && !interactive(args)) {
    const result = child.spawnSync('codex', args, { stdio: 'inherit' })
    if (result.error) console.error(result.error.message)
    process.exit(result.status ?? 1)
  }
  const setup = prepare(args.filter(arg => arg !== '--print'))
  if (print) {
    console.log(JSON.stringify({ sessionId: setup.sessionId, codex: setup.left, panel: setup.right }, null, 2))
  } else {
    if (child.spawnSync('tmux', ['-V'], { stdio: 'ignore' }).error) {
      console.error('tmux is required for two panes in one terminal. Install it, or use --print to run the two commands in terminal splits. On macOS: brew install tmux')
      process.exit(1)
    }
    const name = `window-todo-${crypto.randomUUID().slice(0, 8)}`
    const run = params => {
      const result = child.spawnSync('tmux', params, { stdio: 'inherit' })
      if (result.status !== 0) throw new Error(`tmux ${params[0]} failed`)
    }
    run(['new-session', '-d', '-s', name, '-c', process.cwd(), setup.left])
    try {
      run(['set-option', '-t', name, 'prefix', 'C-a'])
      run(['set-option', '-t', name, 'prefix2', 'None'])
      run(['split-window', '-h', '-l', '35%', '-t', `${name}:0`, '-c', process.cwd(), setup.right])
      run(['set-window-option', '-t', `${name}:0`, 'window-status-current-format', '#I:#{?#{==:#{pane_index},0},Codex,Window Todo}#F'])
      run(['select-pane', '-t', `${name}:0.0`])
      if (setup.sessionId) console.log(`window-todo session: ${setup.sessionId}. Resume the list with --session ${setup.sessionId}.`)
      if (process.env.TMUX) run(['switch-client', '-t', name])
      else run(['attach-session', '-t', name])
    } catch (error) {
      child.spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' })
      if (setup.panelBinding) binding.close(setup.panelBinding, setup.environment)
      console.error(error.message)
      process.exitCode = 1
    }
  }
}
module.exports = { prepare, command, interactive }
