const store = require('./state.cjs')
const { buildTree, statusLine } = require('./core/tree')
const { windowLines, windowStatus } = require('./core/window')
const { clean } = require('./core/sanitize')

function render(state, width = 56, height = 30) {
  const status = [statusLine(state.plan, state.activity), windowStatus(state.window)].filter(Boolean).join(' · ')
  const window = windowLines(state.window, width, 'cyan')
  const plan = buildTree(state.plan, state.activity, { width, maxLines: Math.max(3, height - window.length - 6), accent: 'cyan' })
  return [ 'WINDOW TODO', `Session: ${clean(state.sessionId)}`, status || 'No open items', '', ...plan.map(line => line.text), '', ...window.map(line => line.text), '', 'Ctrl+C closes this pane.' ].slice(0, height).map(line => line.slice(0, width)).join('\n')
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const index = args.indexOf('--session')
  const sessionId = store.sessionFrom(index >= 0 ? { sessionId: args[index + 1] } : {})
  const once = args.includes('--once') || !process.stdout.isTTY
  const draw = () => {
    let text
    try { text = render(store.read(sessionId), Math.max(20, process.stdout.columns || 56), process.stdout.rows || 30) }
    catch (error) { text = `window-todo: ${error.message}` }
    if (!once) process.stdout.write('\x1b[2J\x1b[H')
    process.stdout.write(text + '\n')
  }
  if (!once) {
    process.stdout.write('\x1b[?1049h\x1b[?25l')
    const done = () => { process.stdout.write('\x1b[?25h\x1b[?1049l'); process.exit(0) }
    process.on('SIGINT', done)
    process.on('SIGTERM', done)
  }
  draw()
  if (!once) setInterval(draw, 500)
}
module.exports = { render }
