const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const child = require('node:child_process')
const store = require('./state.cjs')
const recent = require('./recent.cjs')
const { parseStoredWindow } = require('../shared/window.js')
const { localDay } = require('../shared/due.js')
const {
  buildSessionRows, detailOf, hasTitle, isSameProcess, mergeFacts, parsePsStart, parseSessionFile, parseStoredEntry,
  projectFolderName, resumeCommand, scanTranscript,
} = require('../shared/sessions.js')
const { clean } = require('../shared/sanitize.js')

// The sessions list as the terminal pane reads it, read-only: the window lists Claude Code's plugin
// stores hold (every window-todo store file, so a list kept under an earlier marketplace still
// counts), the Codex lists in the state directory, the running Claude Code processes, and each
// session's folder and title from its transcript.

// A read from the end of a transcript; the titles are written again and again near the end.
const TAIL_BYTES = 512 * 1024
// The most read from the end when the first read found no title.
const TAIL_MAX_BYTES = 4 * 1024 * 1024
// The start, for the folder; more of it for the first prompt when no title was found.
const HEAD_BYTES = 64 * 1024
const HEAD_PROMPT_BYTES = 1024 * 1024

function roots(env = process.env) {
  const home = env.HOME || os.homedir()
  return {
    home,
    claude: env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    state: store.directory(env),
    codex: env.CODEX_HOME || path.join(home, '.codex'),
  }
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))

const listDir = dir => {
  try { return fs.readdirSync(dir, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []; throw error }
}

// The window-todo plugin store files, newest first; the `.before-*` copies are backups, not stores.
function storeFiles(claudeDir) {
  const dir = path.join(claudeDir, 'plugins', 'store')
  return listDir(dir)
    .filter(entry => entry.isFile() && /^window-todo_.+\.json$/.test(entry.name) && !entry.name.includes('.before-'))
    .map(entry => path.join(dir, entry.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
}

// Every list the Claude stores hold; a store that does not parse is left out and named in `notes`.
function claudeStored(claudeDir, notes = []) {
  const found = []
  for (const file of storeFiles(claudeDir)) {
    let value
    try { value = readJson(file) }
    catch { notes.push(`Store ${path.basename(file)} could not be read.`); continue }
    if (typeof value !== 'object' || value === null) continue
    for (const [key, entry] of Object.entries(value)) {
      const parsed = parseStoredEntry(key, entry, 'claude')
      if (parsed) found.push(parsed)
    }
  }
  return found
}

// The Codex sessions' lists. A Claude session's state file (its pane mirror) is skipped: the store
// holds that list.
function codexStored(stateDir) {
  const found = []
  for (const entry of listDir(stateDir)) {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) continue
    let value
    try { value = readJson(path.join(stateDir, entry.name)) }
    catch { continue }
    if (!value || value.client === 'claude' || typeof value.sessionId !== 'string') continue
    const list = parseStoredWindow(value.window)
    if (list) found.push({ sessionId: value.sessionId, client: 'codex', updatedAt: Number(value.updatedAt) || 0, list })
  }
  return found
}

// The start time of each pid that runs, by one `ps` call; null when ps cannot be run.
function processStarts(pids) {
  if (pids.length === 0) return new Map()
  const result = child.spawnSync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 2000 })
  if (result.error || (result.status !== 0 && result.status !== 1)) return null
  return parsePsStart(result.stdout || '')
}

// Signal 0 only asks whether the pid exists; nothing is sent to the process.
function pidExists(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code === 'EPERM' }
}

// The Claude Code processes running now, by session id. Only `<pid>.json` is read; the key files
// beside it are never opened.
function runningClaude(claudeDir, starts = processStarts) {
  const dir = path.join(claudeDir, 'sessions')
  const files = []
  for (const entry of listDir(dir)) {
    if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) continue
    try {
      const parsed = parseSessionFile(readJson(path.join(dir, entry.name)))
      if (parsed) files.push(parsed)
    } catch { /* A file being written is read again next time. */ }
  }
  const started = starts(files.map(file => file.pid))
  const running = new Map()
  for (const file of files) {
    const alive = started ? isSameProcess(file.procStart, started.get(file.pid)) : pidExists(file.pid)
    if (!alive) continue
    const { procStart, ...session } = file
    running.set(file.sessionId, session)
  }
  return running
}

function readRange(file, start, length) {
  const handle = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const read = fs.readSync(handle, buffer, 0, length, start)
    return buffer.subarray(0, read).toString('utf8')
  } finally { fs.closeSync(handle) }
}

// The facts of a transcript, read from its end and its start within the byte limits above.
function transcriptFacts(file, size) {
  const tailLength = Math.min(size, TAIL_BYTES)
  let tail = scanTranscript(readRange(file, size - tailLength, tailLength), tailLength < size)
  if (!hasTitle(tail) && size > TAIL_BYTES) {
    const longer = Math.min(size, TAIL_MAX_BYTES)
    tail = scanTranscript(readRange(file, size - longer, longer), longer < size)
  }
  if (size <= tailLength) return tail
  const headLength = Math.min(size, hasTitle(tail) ? HEAD_BYTES : HEAD_PROMPT_BYTES)
  // A head read that stops inside a line loses only that line.
  const head = scanTranscript(readRange(file, 0, headLength))
  return mergeFacts(tail, head)
}

// Where each session's transcript is: the project folder of its working folder first, else any.
function transcriptIndex(claudeDir) {
  const projects = path.join(claudeDir, 'projects')
  const folders = listDir(projects).filter(entry => entry.isDirectory()).map(entry => path.join(projects, entry.name))
  return { projects, folders }
}

function findTranscript(index, sessionId, cwd) {
  const name = `${sessionId}.jsonl`
  const preferred = cwd ? path.join(index.projects, projectFolderName(cwd)) : null
  for (const folder of preferred ? [preferred, ...index.folders.filter(f => f !== preferred)] : index.folders) {
    const file = path.join(folder, name)
    if (fs.existsSync(file)) return file
  }
  return null
}

// Cached by file, size and change time, so a pane redraw reads only transcripts that changed.
function claudeDetails(claudeDir, sessions, cache = new Map()) {
  const index = transcriptIndex(claudeDir)
  const details = new Map()
  for (const { sessionId, cwd } of sessions) {
    const known = cache.get(sessionId)
    let file = known?.file && fs.existsSync(known.file) ? known.file : findTranscript(index, sessionId, cwd)
    if (!file) continue
    let stat
    try { stat = fs.statSync(file) } catch { continue }
    const stamp = `${stat.size}:${stat.mtimeMs}`
    if (known?.file === file && known.stamp === stamp) { details.set(sessionId, known.detail); continue }
    let detail
    try { detail = detailOf(transcriptFacts(file, stat.size)) }
    catch { continue }
    cache.set(sessionId, { file, stamp, detail })
    details.set(sessionId, detail)
  }
  return details
}

// The rows of the sessions page. `options.current` is the pane's own session; `cache` keeps the
// transcript reads between calls; `starts` and `threads` stand in for ps and Codex's database.
function collect(options = {}) {
  const env = options.env || process.env
  const where = { ...roots(env), ...(options.roots || {}) }
  const now = options.now ?? Date.now()
  const notes = []
  const stored = [...claudeStored(where.claude, notes), ...codexStored(where.state)]
  const running = runningClaude(where.claude, options.starts || processStarts)
  const open = stored.filter(entry => entry.list.items.some(item => !item.isDone))
  const cache = options.cache || new Map()
  const claude = open.filter(entry => entry.client === 'claude').map(entry => ({ sessionId: entry.sessionId, cwd: running.get(entry.sessionId)?.cwd }))
  const details = claudeDetails(where.claude, claude, cache)
  const codexIds = open.filter(entry => entry.client === 'codex').map(entry => entry.sessionId)
  if (codexIds.length) {
    const threads = (options.threads || recent.threads)(codexIds, { ...env, CODEX_HOME: where.codex })
    for (const [id, detail] of threads) details.set(id, detail)
  }
  const rows = buildSessionRows({ stored, running, details, today: localDay(now), current: options.current })
  return { rows, notes, home: where.home }
}

const spawn = (command, args, options = {}) => child.spawnSync(command, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'], ...options })

function launchers() {
  return { claude: path.resolve(__dirname, '..', '..', 'claude', 'launch.cjs'), codex: path.join(__dirname, 'launch.cjs') }
}

const firstLine = result => clean(String(result.error?.message || result.stderr || result.stdout || `exit ${result.status}`).split('\n').find(text => text.trim()) || '')

// What Enter on a session row does; answers the notice. A running Claude Code inside tmux: the
// client switches to its pane (`tmux` of its sessions file, `session:@window.%pane`). One that does
// not run: its launcher resumes it in its own folder, in a tmux session of its own beside its pane,
// and the client switches there. Nothing is stopped; outside tmux only the command is shown.
function openSession(row, { env = process.env, run = spawn, paths = launchers() } = {}) {
  const short = row.sessionId.slice(0, 8)
  if (row.isCurrent) return `${short} is the session of this pane.`
  if (row.isRunning) {
    if (!row.tmux) return `${short} runs outside tmux; go to its terminal.`
    const name = row.tmux.split(':')[0]
    const pane = row.tmux.includes('.') ? row.tmux.slice(row.tmux.lastIndexOf('.') + 1) : row.tmux
    if (!env.TMUX) return `${short} runs in tmux session ${name}: tmux attach -t ${name}`
    const found = run('tmux', ['display-message', '-p', '-t', pane, '#{session_name}'], { env })
    if (found.status !== 0) return `${short}: its tmux pane ${pane} is not there any more.`
    const switched = run('tmux', ['switch-client', '-t', row.tmux], { env })
    return switched.status === 0 ? `Switched to ${short} in ${name}.` : `tmux switch-client failed: ${firstLine(switched)}`
  }
  const command = resumeCommand(row)
  if (!env.TMUX) return `Not inside tmux. Resume it with: ${command}`
  const launcher = paths[row.client]
  if (!launcher || !fs.existsSync(launcher)) return `No ${row.client} launcher here. Resume it with: ${command}`
  if (!row.cwd || !fs.existsSync(row.cwd)) return `Its folder ${row.cwd || '(unknown)'} is not there. Resume it with: ${command}`
  const args = row.client === 'codex' ? [launcher, 'resume', row.sessionId] : [launcher, '--resume', row.sessionId]
  const result = run(process.execPath, args, { cwd: row.cwd, env })
  return result.status === 0 ? `Resumed ${short} in ${row.cwd} beside its pane.` : `Resume failed (${firstLine(result)}). Run: ${command}`
}

module.exports = { roots, storeFiles, claudeStored, codexStored, runningClaude, transcriptFacts, findTranscript, claudeDetails, collect, openSession, launchers, TAIL_BYTES }
