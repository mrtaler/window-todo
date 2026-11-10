require('./runtime.cjs').ensureRuntime({ host: process })
const child = require('node:child_process')
const binding = require('./binding.cjs')

if (require.main === module) {
  const token = process.env.WINDOW_TODO_PANEL_BINDING
  if (token) binding.initialize(token, process.env, process.env.WINDOW_TODO_INITIAL_THREAD)
  const args = process.argv.slice(2)
  const codex = child.spawn(args[0], args.slice(1), { stdio: 'inherit' })
  // Ctrl+C reaches both processes in the terminal's foreground group. Let Codex handle it.
  process.on('SIGINT', () => {})
  process.on('SIGTERM', () => { codex.kill('SIGTERM') })
  process.on('exit', () => { if (token) binding.close(token) })
  codex.on('error', error => { process.stderr.write(`window-todo: ${error.message}\n`); process.exitCode = 1 })
  codex.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
}
