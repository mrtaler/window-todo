import type { EngineInterface } from 'claude-code'
import { localDay } from '../shared/due'
import {
  buildSessionRows,
  detailOf,
  hasTitle,
  isSameProcess,
  mergeFacts,
  parsePsStart,
  parseSessionFile,
  parseStoredEntry,
  projectFolderName,
  scanTranscript,
  sessionsText,
} from '../shared/sessions'
import type { RunningSession, SessionDetail, StoredSession, TranscriptFacts } from '../shared/sessions'

// `/todo sessions`: the sessions whose window list in this plugin's store still has an open item,
// with whether each runs, its folder and its title. The lists come from $.store; the running
// processes, folders and titles from Claude Code's own files, read through $.fs and, for what
// $.fs cannot do, $.process (ps for the running check, tail and head for transcripts over the
// 4 MiB a $.fs read takes). Whatever cannot be read is left out of the rows and named in a note.

// $.fs.read rejects a file over 4 MiB.
const FS_READ_MAX = 4 * 1024 * 1024
const TAIL_BYTES = 512 * 1024
const HEAD_BYTES = 64 * 1024
const HEAD_PROMPT_BYTES = 1024 * 1024

const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path)

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200)

// Claude Code's configuration folder: CLAUDE_CONFIG_DIR, else $HOME/.claude; null when neither is set.
async function claudeFolder($: EngineInterface): Promise<{ claude: string; home: string | undefined } | null> {
  const home = await $.env.get('HOME')
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configured !== undefined && configured !== '') return { claude: trimSlash(configured), home: home === undefined || home === '' ? undefined : trimSlash(home) }
  if (home === undefined || home === '') return null

  return { claude: `${trimSlash(home)}/.claude`, home: trimSlash(home) }
}

async function storedLists($: EngineInterface): Promise<StoredSession[]> {
  const found: StoredSession[] = []
  for (const key of await $.store.keys()) {
    const entry = parseStoredEntry(key, await $.store.get(key), 'claude')
    if (entry !== null) found.push(entry)
  }

  return found
}

// The running Claude Code processes by session id, from `<claude>/sessions/<pid>.json` (the key
// files beside them are never read) and one `ps` call that says which pids run and since when.
async function runningSessions($: EngineInterface, claude: string, notes: string[]): Promise<Map<string, RunningSession>> {
  const running = new Map<string, RunningSession>()
  const dir = `${claude}/sessions`
  let names: string[]
  try {
    names = (await $.fs.list(dir)).filter(entry => entry.kind === 'file' && /^\d+\.json$/.test(entry.name)).map(entry => entry.name)
  } catch (error) {
    notes.push(`Running sessions not checked: ${dir} could not be listed (${message(error)}).`)

    return running
  }
  const files: Array<RunningSession & { procStart?: string }> = []
  for (const name of names) {
    try {
      const parsed = parseSessionFile(JSON.parse(await $.fs.read(`${dir}/${name}`)))
      if (parsed !== null) files.push(parsed)
    } catch {
      // A file being written is read again next time.
    }
  }
  if (files.length === 0) return running
  let started: Map<number, string>
  try {
    const ps = await $.process.run(['ps', '-o', 'pid=,lstart=', '-p', files.map(file => file.pid).join(',')], { timeoutMs: 5000 })
    started = parsePsStart(ps.stdout)
  } catch (error) {
    notes.push(`Running sessions not checked: ps could not be run (${message(error)}).`)

    return running
  }
  for (const file of files) {
    if (!isSameProcess(file.procStart, started.get(file.pid))) continue
    const { procStart: _started, ...session } = file
    running.set(file.sessionId, session)
  }

  return running
}

// The transcript of `sessionId`: in the project folder of its working folder first, else in any.
async function findTranscript($: EngineInterface, projects: string, folders: string[], sessionId: string, cwd: string | undefined): Promise<string | null> {
  const preferred = cwd === undefined ? undefined : projectFolderName(cwd)
  const order = preferred === undefined ? folders : [preferred, ...folders.filter(folder => folder !== preferred)]
  for (const folder of order) {
    const file = `${projects}/${folder}/${sessionId}.jsonl`
    if (await $.fs.exists(file)) return file
  }

  return null
}

// A byte range of a large file through tail or head, as $.fs reads only whole files up to 4 MiB.
async function readPart($: EngineInterface, tool: 'tail' | 'head', bytes: number, file: string): Promise<string> {
  const { exitCode, stdout } = await $.process.run([tool, '-c', String(bytes), file], { timeoutMs: 10_000 })
  if (exitCode !== 0) throw new Error(`${tool} exited with ${exitCode}`)

  return stdout
}

async function transcriptFacts($: EngineInterface, file: string): Promise<TranscriptFacts> {
  const { size } = await $.fs.stat(file)
  if (size <= FS_READ_MAX) return scanTranscript(await $.fs.read(file))
  let tail = scanTranscript(await readPart($, 'tail', TAIL_BYTES, file), true)
  if (!hasTitle(tail)) tail = scanTranscript(await readPart($, 'tail', FS_READ_MAX, file), true)
  const head = scanTranscript(await readPart($, 'head', hasTitle(tail) ? HEAD_BYTES : HEAD_PROMPT_BYTES, file))

  return mergeFacts(tail, head)
}

async function sessionDetails(
  $: EngineInterface,
  claude: string,
  sessions: ReadonlyArray<{ sessionId: string; cwd: string | undefined }>,
  notes: string[],
): Promise<Map<string, SessionDetail>> {
  const details = new Map<string, SessionDetail>()
  const projects = `${claude}/projects`
  let folders: string[]
  try {
    folders = (await $.fs.list(projects)).filter(entry => entry.kind === 'dir').map(entry => entry.name)
  } catch (error) {
    notes.push(`Folders and titles not read: ${projects} could not be listed (${message(error)}).`)

    return details
  }
  const failed: string[] = []
  for (const { sessionId, cwd } of sessions) {
    try {
      const file = await findTranscript($, projects, folders, sessionId, cwd)
      if (file !== null) details.set(sessionId, detailOf(await transcriptFacts($, file)))
    } catch (error) {
      failed.push(`${sessionId.slice(0, 8)} (${message(error)})`)
    }
  }
  if (failed.length > 0) notes.push(`Transcripts not read: ${failed.join(', ')}.`)

  return details
}

// The list as `/todo sessions` prints it.
export async function sessionsReport($: EngineInterface): Promise<string> {
  const [now, current, stored] = await Promise.all([$.clock.now(), $.session.id(), storedLists($)])
  const notes: string[] = []
  const folder = await claudeFolder($)
  let running = new Map<string, RunningSession>()
  let details = new Map<string, SessionDetail>()
  if (folder === null) notes.push('Running state, folders and titles not read: neither CLAUDE_CONFIG_DIR nor HOME is set.')
  else {
    running = await runningSessions($, folder.claude, notes)
    const open = stored.filter(entry => entry.list.items.some(item => !item.isDone))
    details = await sessionDetails($, folder.claude, open.map(entry => ({ sessionId: entry.sessionId, cwd: running.get(entry.sessionId)?.cwd })), notes)
  }
  // This session runs whatever the files say.
  if (!running.has(current)) running.set(current, { sessionId: current, pid: 0 })
  const today = localDay(now)
  const rows = buildSessionRows({ stored, running, details, today, current })

  return sessionsText(rows, { now, today, ...(folder?.home !== undefined ? { home: folder.home } : {}), notes })
}
