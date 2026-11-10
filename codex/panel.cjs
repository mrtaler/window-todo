require('./runtime.cjs').ensureRuntime({ host: process })
const store = require('./state.cjs')
const { buildTree, statusLine } = require('../shared/tree.js')
const { windowLines, windowStatus } = require('../shared/window.js')
const { clean } = require('../shared/sanitize.js')
const binding = require('./binding.cjs')
const readline = require('node:readline')
const commands = require('./commands.cjs')

const foreground = { black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37, gray: 90 }

function line(segments, width, color) {
  let remaining = Math.max(0, width)
  let output = ''
  for (const segment of segments) {
    const text = segment.text.slice(0, remaining)
    remaining -= text.length
    if (!text) continue
    const codes = []
    if (segment.bold) codes.push(1)
    if (segment.dim) codes.push(2)
    if (segment.strikethrough) codes.push(9)
    if (Object.hasOwn(foreground, segment.color)) codes.push(foreground[segment.color])
    output += color && codes.length ? `\x1b[${codes.join(';')}m${text}\x1b[0m` : text
  }
  return output
}

function render(state, width = 56, height = 30, { color = false } = {}) {
  const status = [statusLine(state.plan, state.activity), windowStatus(state.window)].filter(Boolean).join(' · ')
  const window = windowLines(state.window, width, 'cyan')
  const plan = buildTree(state.plan, state.activity, { width, maxLines: Math.max(3, height - window.length - 6), accent: 'cyan' })
  const header = [
    [{ text: 'WINDOW TODO', color: 'cyan', bold: true }],
    [{ text: `Session: ${clean(state.sessionId)}`, dim: true }],
    [{ text: status || 'No open items' }],
    [],
  ]
  return [...header, ...plan.map(row => row.segments), [], ...window.map(row => row.segments), [], [{ text: 'Ctrl+C closes this pane.', dim: true }]]
    .slice(0, height).map(segments => line(segments, width, color)).join('\n')
}

function main(args = process.argv.slice(2)) {
  const index = args.indexOf('--session')
  const bindingIndex = args.indexOf('--binding')
  const panelBinding = bindingIndex >= 0 ? args[bindingIndex + 1] : undefined
  let sessionId = panelBinding ? null : store.sessionFrom(index >= 0 ? { sessionId: args[index + 1] } : {})
  const dir = store.directory()
  const terminal = Boolean(process.stdout.isTTY)
  const color = terminal && !Object.hasOwn(process.env, 'NO_COLOR')
  const forcedInput = args.includes('--interactive')
  const once = args.includes('--once') || (!terminal && !panelBinding && !forcedInput)
  let previousText
  let closing = false
  let input
  let notice = ''
  let failed = false
  let pending = Promise.resolve()
  const done = () => {
    if (closing) return
    closing = true
    if (input) input.close()
    if (terminal && !once) process.stdout.write('\x1b[?25h\x1b[?1049l')
    try { if (panelBinding && binding.read(panelBinding)?.closed) binding.remove(panelBinding) }
    finally { process.exit(0) }
  }
  const draw = () => {
    if (closing) return
    let text
    const width = Math.max(20, process.stdout.columns || 56)
    const height = Math.max(8, process.stdout.rows || 30)
    try {
      if (panelBinding) {
        const current = binding.read(panelBinding)
        if (current?.closed) { done(); return }
        sessionId = current?.sessionId
        if (sessionId && notice === 'No conversation bound yet.') { notice = ''; failed = false }
        if (!sessionId) {
          text = 'WINDOW TODO\nWaiting for the Codex conversation...'
        }
      }
      if (sessionId) {
        const state = store.read(sessionId, dir)
        text = render(state, width, height - (input ? 3 : 0), { color })
      }
    }
    catch (error) { text = `window-todo: ${error.message}` }
    const frame = text + notice
    if ((!terminal || input) && frame === previousText) return
    previousText = frame
    if (terminal && !once) process.stdout.write('\x1b[2J\x1b[H')
    process.stdout.write(text + '\n')
    if (input) {
      if (terminal) {
        process.stdout.write(`\x1b[${height - 2};1H` + line([{ text: '/todo prune | /todo clear', dim: true }], width, color))
        process.stdout.write(`\x1b[${height - 1};1H` + line([{ text: clean(notice), color: failed ? 'red' : 'green' }], width, color))
        process.stdout.write(`\x1b[${height};1H\x1b[?25h`)
        process.stdout.write('> ' + input.line.replace(/[\x00-\x1f\x7f]/g, '').slice(0, width - 2))
        const cursor = input.getCursorPos()
        process.stdout.write(`\x1b[${height};${Math.min(width, cursor.cols + 1)}H`)
      } else if (notice) process.stdout.write(notice + '\n')
    }
  }
  if (!once) {
    if (terminal) process.stdout.write('\x1b[?1049h\x1b[?25l')
    process.on('SIGINT', done)
    process.on('SIGTERM', done)
    if ((terminal && process.stdin.isTTY) || forcedInput) {
      input = readline.createInterface({ input: process.stdin, output: process.stdout, terminal })
      input.setPrompt('> ')
      input.on('SIGINT', done)
      input.on('line', text => {
        if (!text.trim()) return
        pending = pending.then(async () => {
          try {
            const current = panelBinding ? binding.read(panelBinding)?.sessionId : sessionId
            notice = await commands.execute(text, current)
            failed = false
          } catch (error) { notice = clean(error.message); failed = true }
          draw()
        })
      })
      input.on('close', () => { if (!closing) void pending.finally(done) })
    }
  }
  draw()
  if (!once) setInterval(draw, 500)
}
if (require.main === module) {
  try { main() }
  catch (error) { process.stderr.write(`window-todo: ${error.message}\n`); process.exitCode = 1 }
}
module.exports = { render, main }
