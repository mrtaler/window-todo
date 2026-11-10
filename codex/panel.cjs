require('./runtime.cjs').ensureRuntime({ host: process })
const store = require('./state.cjs')
const inbox = require('./inbox.cjs')
const { buildTree, statusLine } = require('../shared/tree.js')
const { displayOrder, windowStatus } = require('../shared/window.js')
const { activityLabel } = require('../shared/activity.js')
const { applyInboxEntries } = require('../shared/inbox.js')
const { progress } = require('../shared/plan.js')
const { clean } = require('../shared/sanitize.js')
const binding = require('./binding.cjs')
const readline = require('node:readline')
const commands = require('./commands.cjs')

const foreground = { black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37, gray: 90 }
const ACCENT = 'cyan'
// The pages, in Tab order; the number key of each is its index.
const PAGES = ['overview', 'plan', 'window', 'activity']
const PAGE_TITLES = { overview: 'All', plan: 'Plan', window: 'Window', activity: 'Activity' }
const HINT = '↑↓ select · Space done · s skip · Tab page · / command'
// A state file that does not parse is most likely being written (Claude's mod has no rename): the
// last good frame stays up for this many reads before the error shows.
const PARSE_RETRIES = 4

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
    if (segment.inverse) codes.push(7)
    if (segment.strikethrough) codes.push(9)
    if (Object.hasOwn(foreground, segment.color)) codes.push(foreground[segment.color])
    output += color && codes.length ? `\x1b[${codes.join(';')}m${text}\x1b[0m` : text
  }
  return output
}

const shorten = (text, max) => (text.length <= max ? text : max <= 1 ? '…' : `${text.slice(0, max - 1)}…`)

// The window list with checkboxes, open items first. With a cursor (an interactive pane) every
// row has a two-column gutter and the selected row is drawn inverted.
function windowSection(list, width, cursor) {
  if (list.items.length === 0) return { header: null, rows: [] }
  const gutter = cursor === undefined ? 0 : 2
  const rows = displayOrder(list).map(item => {
    const box = item.isDone ? '[x] ' : '[ ] '
    const title = shorten(item.title, Math.max(1, width - gutter - box.length - item.id.length - 1))
    const segments = item.isDone
      ? [{ text: box, color: 'green' }, { text: `${item.id} `, dim: true }, { text: title, dim: true, strikethrough: true }]
      : [{ text: box }, { text: item.id, color: ACCENT, bold: true }, { text: ` ${title}` }]
    const selected = cursor === item.id
    const lead = gutter ? [{ text: selected ? '› ' : '  ', color: ACCENT, bold: true }] : []
    return { id: item.id, segments: [...lead, ...segments.map(segment => (selected ? { ...segment, inverse: true } : segment))] }
  })
  return { header: [{ text: 'Window', bold: true }], rows }
}

// At most `room` rows of `rows`, scrolled so the row at `focus` (or the one at `offset`) shows.
function visible(rows, room, { focus = -1, offset = 0 } = {}) {
  if (rows.length <= room) return rows
  const size = Math.max(1, room)
  let start = Math.min(Math.max(0, offset), rows.length - size)
  if (focus >= 0) start = Math.min(Math.max(0, focus - Math.floor(size / 2)), rows.length - size)
  return rows.slice(start, start + size)
}

const clock = ms => new Date(ms).toTimeString().slice(0, 8)

function activityRows(state, width) {
  const activity = state.activity
  const label = activityLabel(activity) || 'Idle'
  const busy = activity.phase !== 'idle'
  const rows = [[{ text: label, color: activity.phase === 'error' ? 'red' : busy ? ACCENT : undefined, bold: busy }]]
  if (activity.since > 0) rows.push([{ text: `since ${clock(activity.since)}`, dim: true }])
  for (const call of activity.running || []) rows.push([{ text: '▸ ', color: ACCENT }, { text: shorten(clean(call.tool), Math.max(1, width - 2)) }])
  if (activity.subagents && activity.subagents.length) rows.push([{ text: `${activity.subagents.length} subagent${activity.subagents.length === 1 ? '' : 's'} running` }])
  rows.push([])
  if (state.plan.nodes.length) {
    const { done, total } = progress(state.plan)
    rows.push([{ text: 'Plan ', bold: true }, { text: `${done}/${total} ` }, { text: shorten(state.plan.title, Math.max(1, width - 12)), dim: true }])
  }
  rows.push([{ text: 'Window ', bold: true }, { text: windowStatus(state.window) || 'nothing open' }])
  if (state.updatedAt) rows.push([{ text: `Updated ${clock(state.updatedAt)}`, dim: true }])
  return rows
}

// The pane as text. `page` is one of PAGES (the combined view by default); `cursor` the id of the
// selected window item in an interactive pane; `pending` how many changes wait in the inbox;
// `offset` the scroll position of the plan page.
function render(state, width = 56, height = 30, { color = false, page = 'overview', cursor, pending = 0, offset = 0, footer = true } = {}) {
  const status = [statusLine(state.plan, state.activity), windowStatus(state.window)].filter(Boolean).join(' · ')
  const header = [
    [{ text: 'WINDOW TODO', color: ACCENT, bold: true }, ...(page === 'overview' ? [] : [{ text: ` · ${PAGE_TITLES[page]}`, bold: true }])],
    [{ text: `Session: ${clean(state.sessionId)}`, dim: true }],
    [{ text: status || 'No open items' }],
    // The blank row under the header says how many changes Claude has not applied yet.
    pending ? [{ text: `${pending} change${pending === 1 ? '' : 's'} waiting for Claude`, color: 'yellow' }] : [],
  ]
  const tail = footer ? [[], [{ text: 'Ctrl+C closes this pane.', dim: true }]] : []
  const room = Math.max(1, height - header.length - tail.length)
  const section = windowSection(state.window, width, cursor)
  const focus = section.rows.findIndex(row => row.id === cursor)
  let body
  if (page === 'plan') {
    body = visible(buildTree(state.plan, state.activity, { width, maxLines: Number.POSITIVE_INFINITY, accent: ACCENT }).map(row => row.segments), room, { offset })
  } else if (page === 'window') {
    body = section.header ? [section.header, ...visible(section.rows, room - 1, { focus }).map(row => row.segments)] : [[{ text: 'The window list is empty.', dim: true }]]
  } else if (page === 'activity') {
    body = activityRows(state, width)
  } else {
    const plan = buildTree(state.plan, state.activity, { width, maxLines: Math.max(3, height - section.rows.length - 7), accent: ACCENT }).map(row => row.segments)
    const windowRoom = Math.max(1, room - plan.length - 2)
    body = section.header ? [...plan, [], section.header, ...visible(section.rows, windowRoom, { focus }).map(row => row.segments)] : plan
  }
  return [...header, ...body, ...tail].slice(0, height).map(segments => line(segments, width, color)).join('\n')
}

// The state to draw: the file as read, with the changes still waiting in the inbox applied on top,
// so a checkbox shows as ticked before Claude has applied it.
function withPending(state, dir) {
  if (state.client !== 'claude') return { state, pending: [], applied: 0 }
  const applied = inbox.appliedOf(state)
  const entries = inbox.read(state.sessionId, dir)
  const pending = entries.filter(entry => entry.seq > applied)
  const shown = pending.length ? { ...state, window: applyInboxEntries(state.window, pending).list } : state
  return { state: shown, pending, applied, stale: entries.length > pending.length }
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
  const view = { page: 'overview', cursor: undefined, offset: 0 }
  let previousText
  let closing = false
  let input = false
  let command = null
  let notice = ''
  let failed = false
  let pending = Promise.resolve()
  let acknowledging = false
  let lastGood
  let parseFailures = 0
  let shownItems = []
  const done = () => {
    if (closing) return
    closing = true
    if (input && process.stdin.isTTY) process.stdin.setRawMode(false)
    if (terminal && !once) process.stdout.write('\x1b[?25h\x1b[?1049l')
    try { if (panelBinding && binding.read(panelBinding)?.closed) binding.remove(panelBinding) }
    catch { /* A binding being rewritten is left to the launcher. */ }
    finally { process.exit(0) }
  }
  // Reads the session's state; a file that does not parse keeps the last good one for a few reads.
  const current = () => {
    try {
      const state = store.read(sessionId, dir)
      lastGood = { sessionId, state }
      parseFailures = 0
      return state
    } catch (error) {
      if (!(error instanceof SyntaxError) || lastGood?.sessionId !== sessionId || ++parseFailures > PARSE_RETRIES) throw error
      return lastGood.state
    }
  }
  const draw = () => {
    if (closing) return
    let text
    const width = Math.max(20, process.stdout.columns || 56)
    const height = Math.max(8, process.stdout.rows || 30)
    const reserved = input && terminal ? 3 : 0
    try {
      if (panelBinding) {
        let bound
        try { bound = binding.read(panelBinding) }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; bound = { sessionId, closed: false } }
        if (bound?.closed) { done(); return }
        sessionId = bound?.sessionId
        if (sessionId && notice === 'No conversation bound yet.') { notice = ''; failed = false }
        if (!sessionId) text = 'WINDOW TODO\nWaiting for the conversation...'
      }
      if (sessionId) {
        const shown = withPending(current(), dir)
        if (shown.stale && !acknowledging) {
          acknowledging = true
          const bound = sessionId
          pending = pending.then(() => inbox.acknowledge(bound, shown.applied, dir)).catch(() => {}).finally(() => { acknowledging = false })
        }
        shownItems = displayOrder(shown.state.window).map(item => item.id)
        if (input && !shownItems.includes(view.cursor)) view.cursor = shownItems[0]
        text = render(shown.state, width, height - reserved, { color, page: view.page, cursor: input ? view.cursor : undefined, pending: shown.pending.length, offset: view.offset, footer: !input })
      }
    }
    catch (error) { text = `window-todo: ${error.message}` }
    // Without a terminal a typed command is not echoed, so it does not count as a change of frame.
    const frame = text + notice + (terminal ? command ?? '' : '')
    if ((!terminal || input) && frame === previousText) return
    previousText = frame
    if (terminal && !once) process.stdout.write('\x1b[2J\x1b[H')
    process.stdout.write(text + '\n')
    if (input) {
      if (terminal) {
        process.stdout.write(`\x1b[${height - 2};1H` + line([{ text: HINT, dim: true }], width, color))
        process.stdout.write(`\x1b[${height - 1};1H` + line([{ text: clean(notice), color: failed ? 'red' : 'green' }], width, color))
        if (command === null) process.stdout.write('\x1b[?25l')
        else {
          const shownCommand = command.replace(/[\x00-\x1f\x7f]/g, '').slice(-(width - 2))
          process.stdout.write(`\x1b[${height};1H> ${shownCommand}\x1b[?25h`)
        }
      } else if (notice) process.stdout.write(notice + '\n')
    }
  }
  // Runs one change or command after the ones before it and shows its answer.
  const act = work => {
    pending = pending.then(async () => {
      try { notice = await work(); failed = false }
      catch (error) { notice = clean(error.message); failed = true }
      draw()
    })
    return pending
  }
  const mark = op => {
    const id = view.cursor
    if (!id || !sessionId) return
    act(async () => {
      const item = current().window.items.find(entry => entry.id === id)
      if (op === 'done' && item?.isDone) return `${id} is already done.`
      return commands.change(sessionId, op, [id])
    })
  }
  const move = step => {
    if (view.page === 'plan') { view.offset = Math.max(0, view.offset + step); return }
    const at = shownItems.indexOf(view.cursor)
    if (shownItems.length) view.cursor = shownItems[Math.min(shownItems.length - 1, Math.max(0, at + step))]
  }
  const onKey = (text, key = {}) => {
    if (key.ctrl && key.name === 'c') { done(); return }
    if (command !== null) {
      if (key.name === 'return' || key.name === 'enter') {
        const typed = command
        command = null
        if (typed.trim()) act(() => commands.execute(typed, sessionId))
      } else if (key.name === 'escape') command = null
      else if (key.name === 'backspace') command = command.length > 1 ? command.slice(0, -1) : null
      else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) command += text
    } else if (text === '/') command = '/'
    else if (key.name === 'tab') view.page = PAGES[(PAGES.indexOf(view.page) + (key.shift ? PAGES.length - 1 : 1)) % PAGES.length]
    else if (/^[0-3]$/.test(text || '')) view.page = PAGES[Number(text)]
    else if (key.name === 'up' || text === 'k') move(-1)
    else if (key.name === 'down' || text === 'j') move(1)
    else if (key.name === 'pageup') move(-10)
    else if (key.name === 'pagedown') move(10)
    else if (key.name === 'space' || text === 'x') mark('done')
    else if (text === 's') mark('skip')
    draw()
  }
  if (!once) {
    if (terminal) process.stdout.write('\x1b[?1049h\x1b[?25l')
    process.on('SIGINT', done)
    process.on('SIGTERM', done)
    if (terminal) process.stdout.on('resize', () => { previousText = undefined; draw() })
    if ((terminal && process.stdin.isTTY) || forcedInput) {
      input = true
      readline.emitKeypressEvents(process.stdin)
      if (process.stdin.isTTY) process.stdin.setRawMode(true)
      process.stdin.on('keypress', onKey)
      process.stdin.on('end', () => { if (!closing) void pending.finally(done) })
      process.stdin.resume()
    }
  }
  draw()
  if (!once) setInterval(draw, 500)
}
if (require.main === module) {
  try { main() }
  catch (error) { process.stderr.write(`window-todo: ${error.message}\n`); process.exitCode = 1 }
}
module.exports = { render, main, withPending, PAGES }
