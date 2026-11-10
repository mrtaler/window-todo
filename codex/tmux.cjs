const crypto = require('node:crypto')
const child = require('node:child_process')

const quote = text => "'" + String(text).replaceAll("'", "'\"'\"'") + "'"

// A shell command line: the environment assignments, then the arguments, each quoted.
function command(args, env) {
  return [...Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`), ...args.map(quote)].join(' ')
}

function available() {
  return !child.spawnSync('tmux', ['-V'], { stdio: 'ignore' }).error
}

// Starts a tmux session with `left` (the client) and `right` (the pane) side by side, prefix
// Ctrl+A, and attaches to it (or switches to it inside tmux). `label` names the left pane in the
// status line; `mouse` turns tmux mouse mode on for the session (wheel scrollback, click to focus).
// `cleanup` runs when the session cannot be set up.
function open({ left, right, label, mouse = false, notice, cleanup = () => {} }) {
  const name = `window-todo-${crypto.randomUUID().slice(0, 8)}`
  const run = params => {
    const result = child.spawnSync('tmux', params, { stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`tmux ${params[0]} failed`)
  }
  run(['new-session', '-d', '-s', name, '-c', process.cwd(), left])
  try {
    run(['set-option', '-t', name, 'prefix', 'C-a'])
    run(['set-option', '-t', name, 'prefix2', 'None'])
    if (mouse) run(['set-option', '-t', name, 'mouse', 'on'])
    run(['split-window', '-h', '-l', '35%', '-t', `${name}:0`, '-c', process.cwd(), right])
    run(['set-window-option', '-t', `${name}:0`, 'window-status-current-format', `#I:#{?#{==:#{pane_index},0},${label},Window Todo}#F`])
    run(['select-pane', '-t', `${name}:0.0`])
    if (notice) console.log(notice)
    if (process.env.TMUX) run(['switch-client', '-t', name])
    else run(['attach-session', '-t', name])
  } catch (error) {
    child.spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' })
    cleanup()
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { quote, command, available, open }
