const path = require('node:path')
const crypto = require('node:crypto')
const child = require('node:child_process')
const store = require('./state.cjs')

const quote = text => "'" + String(text).replaceAll("'", "'\"'\"'") + "'"

function command(args, env) {
  return [...Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`), ...args.map(quote)].join(' ')
}

function prepare(args = [], env = process.env) {
  const options = [...args]
  const sessionIndex = options.indexOf('--session')
  const sessionId = store.sessionFrom({ sessionId: sessionIndex >= 0 ? options.splice(sessionIndex, 2)[1] : env.WINDOW_TODO_SESSION || crypto.randomUUID() }, env)
  const enforceIndex = options.indexOf('--enforce')
  const enforce = enforceIndex >= 0
  if (enforce) options.splice(enforceIndex, 1)
  if (options[0] === '--') options.shift()
  const stateDir = store.directory(env)
  const environment = { WINDOW_TODO_SESSION: sessionId, WINDOW_TODO_STATE_DIR: stateDir, WINDOW_TODO_ENFORCE: String(enforce) }
  const codexArgs = ['codex', '--no-daemon',
    '-c', 'mcp_servers.window-todo.command=' + JSON.stringify(process.execPath),
    '-c', 'mcp_servers.window-todo.args=' + JSON.stringify([path.join(__dirname, 'mcp.cjs')]),
    '-c', 'mcp_servers.window-todo.env=' + '{' + Object.entries(environment).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(',') + '}',
    ...options]
  return { sessionId, environment, codexArgs, left: command(codexArgs, environment), right: command([process.execPath, path.join(__dirname, 'panel.cjs')], environment) }
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const print = args.includes('--print')
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
      run(['split-window', '-h', '-l', '35%', '-t', `${name}:0`, '-c', process.cwd(), setup.right])
      run(['select-pane', '-t', `${name}:0.0`])
      console.log(`window-todo session: ${setup.sessionId}. Resume the list with --session ${setup.sessionId}.`)
      if (process.env.TMUX) run(['switch-client', '-t', name])
      else run(['attach-session', '-t', name])
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}
module.exports = { prepare, command }
