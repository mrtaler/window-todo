require('./runtime.cjs').ensureRuntime({ host: process })
const store = require('./state.cjs')
const inbox = require('./inbox.cjs')
const { buildTree, statusLine } = require('../shared/tree.js')
const { displayOrder, windowStatus } = require('../shared/window.js')
const { dueColor, dueState, localDay, shortDue } = require('../shared/due.js')
const { sessionCells, SESSIONS_CAP } = require('../shared/sessions.js')
const sessions = require('./sessions.cjs')
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
const PAGES = ['overview', 'plan', 'window', 'activity', 'sessions']
const PAGE_TITLES = { overview: 'All', plan: 'Plan', window: 'Window', activity: 'Activity', sessions: 'Sessions' }
const HINT = '↑↓ select · Space done · s skip · Tab page · / command'
const SESSIONS_HINT = '↑↓ select · Enter go to the session · Tab page'
// The sessions page reads the stores, the sessions folder and the transcripts again this often.
const SESSIONS_REFRESH_MS = 3000
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

// The ` · MM-DD` of an open item with a day: red once passed, yellow on the day, dim before.
function dueTail(item, today) {
  if (!item.due || item.isDone) return []
  const color = dueColor(dueState(item.due, today))
  return [{ text: ' · ', dim: true }, { text: shortDue(item.due, today), ...(color ? { color, bold: true } : { dim: true }) }]
}

// The window list with checkboxes, open items first. With a cursor (an interactive pane) every
// row has a two-column gutter and the selected row is drawn inverted.
function windowSection(list, width, cursor, today = localDay(Date.now())) {
  if (list.items.length === 0) return { header: null, rows: [] }
  const gutter = cursor === undefined ? 0 : 2
  const rows = displayOrder(list).map(item => {
    const box = item.isDone ? '[x] ' : '[ ] '
    const tail = dueTail(item, today)
    const tailLength = tail.reduce((sum, segment) => sum + segment.text.length, 0)
    const title = shorten(item.title, Math.max(1, width - gutter - box.length - item.id.length - 1 - tailLength))
    const segments = item.isDone
      ? [{ text: box, color: 'green' }, { text: `${item.id} `, dim: true }, { text: title, dim: true, strikethrough: true }]
      : [{ text: box }, { text: item.id, color: ACCENT, bold: true }, { text: ` ${title}` }, ...tail]
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

// The sessions page: two rows per session, the first with whether it runs, its id, its open count,
// its nearest day and how long ago its list changed; the second with its folder and title.
function sessionLines(data, width, cursor, now, today) {
  if (!data) return { lines: [[{ text: 'Reading the sessions...', dim: true }]], focus: -1 }
  if (data.error) return { lines: [[{ text: `Sessions could not be read: ${clean(data.error)}`, color: 'red' }]], focus: -1 }
  const shown = data.rows.slice(0, SESSIONS_CAP)
  const gutter = cursor === undefined ? '' : '  '
  const lines = [[{ text: data.rows.length ? `${data.rows.length} session${data.rows.length === 1 ? '' : 's'} with open items` : 'No session has an open window item.', bold: true }]]
  let focus = -1
  for (const row of shown) {
    const cells = sessionCells(row, now, today, data.home)
    const selected = cursor === row.sessionId
    if (selected) focus = lines.length
    const dueColorName = row.dueState ? dueColor(row.dueState) : undefined
    const first = [
      { text: cells.mark, ...(row.isRunning ? { color: 'green', bold: true } : { dim: true }) },
      { text: ' ' },
      { text: cells.id, color: ACCENT, bold: true },
      ...(row.isCurrent ? [{ text: ' here', dim: true }] : []),
      { text: `  ${cells.open}` },
      ...(cells.due ? [{ text: '  ' }, { text: cells.due, ...(dueColorName ? { color: dueColorName, bold: true } : { dim: true }) }] : []),
      { text: `  ${cells.age}`, dim: true },
      ...(cells.client ? [{ text: `  ${cells.client}`, dim: true }] : []),
    ]
    const folder = shorten(cells.folder, Math.max(8, Math.floor((width - gutter.length - 2) / 2)))
    const second = [{ text: `  ${folder}`, dim: true }, { text: ' · ', dim: true }, { text: shorten(clean(cells.title), Math.max(1, width - gutter.length - folder.length - 5)) }]
    for (const segments of [first, second]) {
      const lead = gutter ? [{ text: selected && segments === first ? '› ' : '  ', color: ACCENT, bold: true }] : []
      lines.push([...lead, ...segments.map(segment => (selected ? { ...segment, inverse: true } : segment))])
    }
  }
  if (data.rows.length > shown.length) lines.push([{ text: `+${data.rows.length - shown.length} more`, dim: true }])
  for (const note of data.notes || []) lines.push([{ text: shorten(clean(note), width), dim: true }])
  return { lines, focus }
}

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
function render(state, width = 56, height = 30, { color = false, page = 'overview', cursor, pending = 0, offset = 0, footer = true, sessions: sessionData, sessionCursor, now = Date.now() } = {}) {
  const today = localDay(now)
  const status = [statusLine(state.plan, state.activity), windowStatus(state.window, today)].filter(Boolean).join(' · ')
  const header = [
    [{ text: 'WINDOW TODO', color: ACCENT, bold: true }, ...(page === 'overview' ? [] : [{ text: ` · ${PAGE_TITLES[page]}`, bold: true }])],
    [{ text: `Session: ${clean(state.sessionId) || 'none bound'}`, dim: true }],
    [{ text: status || 'No open items' }],
    // The blank row under the header says how many changes Claude has not applied yet.
    pending ? [{ text: `${pending} change${pending === 1 ? '' : 's'} waiting for Claude`, color: 'yellow' }] : [],
  ]
  const tail = footer ? [[], [{ text: 'Ctrl+C closes this pane.', dim: true }]] : []
  const room = Math.max(1, height - header.length - tail.length)
  const section = windowSection(state.window, width, cursor, today)
  const focus = section.rows.findIndex(row => row.id === cursor)
  let body
  if (page === 'sessions') {
    const shown = sessionLines(sessionData, width, sessionCursor, now, today)
    body = visible(shown.lines, room, { focus: shown.focus })
  } else if (page === 'plan') {
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

// The page `--page` names, by name or number; the combined view when absent.
function pageFrom(args) {
  const at = args.indexOf('--page')
  if (at < 0) return 'overview'
  const value = String(args[at + 1] ?? '').toLowerCase()
  const page = /^\d+$/.test(value) ? PAGES[Number(value)] : PAGES.find(name => name === value)
  if (!page) throw new Error(`--page takes ${PAGES.map((name, i) => `${i} or ${name}`).join(', ')}.`)
  return page
}

function main(args = process.argv.slice(2)) {
  const index = args.indexOf('--session')
  const bindingIndex = args.indexOf('--binding')
  const panelBinding = bindingIndex >= 0 ? args[bindingIndex + 1] : undefined
  const startPage = pageFrom(args)
  // The sessions page needs no conversation of its own.
  const given = index >= 0 ? { sessionId: args[index + 1] } : {}
  let sessionId = null
  if (!panelBinding) {
    try { sessionId = store.sessionFrom(given) }
    catch (error) { if (startPage !== 'sessions') throw error }
  }
  const dir = store.directory()
  const terminal = Boolean(process.stdout.isTTY)
  const color = terminal && !Object.hasOwn(process.env, 'NO_COLOR')
  const forcedInput = args.includes('--interactive')
  const once = args.includes('--once') || (!terminal && !panelBinding && !forcedInput)
  const view = { page: startPage, cursor: undefined, offset: 0, session: undefined }
  // The sessions page's rows, read again every SESSIONS_REFRESH_MS while it shows.
  let sessionData = null
  let sessionsAt = 0
  const transcripts = new Map()
  const refreshSessions = () => {
    if (sessionData && Date.now() - sessionsAt < SESSIONS_REFRESH_MS) return
    sessionsAt = Date.now()
    try { sessionData = sessions.collect({ cache: transcripts, current: sessionId || undefined }) }
    catch (error) { sessionData = { error: error.message, rows: [] } }
  }
  const shownSessions = () => (sessionData?.rows || []).slice(0, SESSIONS_CAP)
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
        if (!sessionId && view.page !== 'sessions') text = 'WINDOW TODO\nWaiting for the conversation...'
      }
      let sessionOptions = {}
      if (view.page === 'sessions') {
        refreshSessions()
        const ids = shownSessions().map(row => row.sessionId)
        if (!ids.includes(view.session)) view.session = ids[0]
        sessionOptions = { sessions: sessionData, sessionCursor: input ? view.session : undefined }
      }
      if (!sessionId && view.page === 'sessions') text = render(store.emptyState(''), width, height - reserved, { color, page: view.page, footer: !input, ...sessionOptions })
      if (sessionId) {
        const shown = withPending(current(), dir)
        if (shown.stale && !acknowledging) {
          acknowledging = true
          const bound = sessionId
          pending = pending.then(() => inbox.acknowledge(bound, shown.applied, dir)).catch(() => {}).finally(() => { acknowledging = false })
        }
        shownItems = displayOrder(shown.state.window).map(item => item.id)
        if (input && !shownItems.includes(view.cursor)) view.cursor = shownItems[0]
        text = render(shown.state, width, height - reserved, { color, page: view.page, cursor: input ? view.cursor : undefined, pending: shown.pending.length, offset: view.offset, footer: !input, ...sessionOptions })
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
        process.stdout.write(`\x1b[${height - 2};1H` + line([{ text: view.page === 'sessions' ? SESSIONS_HINT : HINT, dim: true }], width, color))
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
    if (!id || !sessionId || view.page === 'sessions') return
    act(async () => {
      const item = current().window.items.find(entry => entry.id === id)
      if (op === 'done' && item?.isDone) return `${id} is already done.`
      return commands.change(sessionId, op, [id])
    })
  }
  const move = step => {
    if (view.page === 'plan') { view.offset = Math.max(0, view.offset + step); return }
    if (view.page === 'sessions') {
      const ids = shownSessions().map(row => row.sessionId)
      const at = ids.indexOf(view.session)
      if (ids.length) view.session = ids[Math.min(ids.length - 1, Math.max(0, at + step))]
      return
    }
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
    else if (new RegExp(`^[0-${PAGES.length - 1}]$`).test(text || '')) view.page = PAGES[Number(text)]
    else if ((key.name === 'return' || key.name === 'enter') && view.page === 'sessions') {
      const row = shownSessions().find(entry => entry.sessionId === view.session)
      if (row) act(async () => { const said = sessions.openSession(row); sessionData = null; return said })
    }
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
module.exports = { render, main, withPending, pageFrom, PAGES }
