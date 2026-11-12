import type { WindowList } from './types'
import { nearestDue, openItems, parseStoredWindow } from './window'
import { dueState, shortDue } from './due'
import type { DueState } from './due'
import { clean } from './sanitize'

// The sessions list: every session whose stored window list still has an open item, so the person
// can see what waits where and go back to it. The sources are read by each client's own adapter
// (the Claude mod through $.store and $.fs, the terminal pane through Node); this module only
// shapes what they read.

export type SessionClient = 'claude' | 'codex'
// One stored window list: whose session, which client keeps it, and when it last changed.
export type StoredSession = { sessionId: string; client: SessionClient; updatedAt: number; list: WindowList }
// A Claude Code process as its sessions file names it, already checked to be running.
export type RunningSession = { sessionId: string; pid: number; cwd?: string; tmux?: string }
// What the transcript (or Codex's thread table) says about a session.
export type SessionDetail = { cwd?: string; title?: string }

export type SessionRow = {
  sessionId: string
  client: SessionClient
  isRunning: boolean
  isCurrent: boolean
  // `session:@window.%pane` of a running Claude Code inside tmux.
  tmux?: string
  open: number
  updatedAt: number
  cwd?: string
  title?: string
  due?: string
  dueState?: DueState
}

export const SESSIONS_CAP = 30
export const SHORT_ID_LENGTH = 8
export const SESSION_TITLE_MAX = 80
export const WINDOW_KEY_PREFIX = 'window:'
// A conversation compacted into a new one opens with this text; it is not the person's prompt.
const COMPACTION_PREFACE = 'This session is being continued from a previous conversation'

// The stored list under one plugin store key, or null when the key or value is not a window list.
export const parseStoredEntry = (key: string, value: unknown, client: SessionClient = 'claude'): StoredSession | null => {
  if (!key.startsWith(WINDOW_KEY_PREFIX) || typeof value !== 'object' || value === null) return null
  const sessionId = key.slice(WINDOW_KEY_PREFIX.length)
  const candidate = value as { updatedAt?: unknown; list?: unknown }
  const list = parseStoredWindow(candidate.list)
  if (sessionId === '' || list === null || typeof candidate.updatedAt !== 'number') return null

  return { sessionId, client, updatedAt: candidate.updatedAt, list }
}

// One entry per session: where several stores hold the same session, the newer list wins (an
// earlier store wins a tie, so the caller lists the preferred store first).
export const mergeStored = (entries: readonly StoredSession[]): StoredSession[] => {
  const bySession = new Map<string, StoredSession>()
  for (const entry of entries) {
    const held = bySession.get(entry.sessionId)
    if (held === undefined || entry.updatedAt > held.updatedAt) bySession.set(entry.sessionId, entry)
  }

  return [...bySession.values()]
}

const isDueNow = (state: DueState | undefined): boolean => state === 'overdue' || state === 'today'

// Sessions with at least one open item: those with a day that has come first (earliest day
// first), then the rest by their last change, newest first.
export const buildSessionRows = (input: {
  stored: readonly StoredSession[]
  running: ReadonlyMap<string, RunningSession>
  details: ReadonlyMap<string, SessionDetail>
  today: string
  current?: string
}): SessionRow[] => {
  const rows = mergeStored(input.stored).flatMap((entry): SessionRow[] => {
    const open = openItems(entry.list).length
    if (open === 0) return []
    const live = input.running.get(entry.sessionId)
    const detail = input.details.get(entry.sessionId) ?? {}
    const due = nearestDue(entry.list)
    const cwd = detail.cwd ?? live?.cwd

    return [
      {
        sessionId: entry.sessionId,
        client: entry.client,
        isRunning: live !== undefined,
        isCurrent: entry.sessionId === input.current,
        ...(live?.tmux !== undefined ? { tmux: live.tmux } : {}),
        open,
        updatedAt: entry.updatedAt,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(detail.title !== undefined ? { title: detail.title } : {}),
        ...(due !== undefined ? { due, dueState: dueState(due, input.today) } : {}),
      },
    ]
  })

  return rows.sort((a, b) => {
    const aDue = isDueNow(a.dueState)
    const bDue = isDueNow(b.dueState)
    if (aDue !== bDue) return aDue ? -1 : 1
    if (aDue && bDue && a.due !== b.due) return (a.due ?? '') < (b.due ?? '') ? -1 : 1

    return b.updatedAt - a.updatedAt
  })
}

// What one transcript chunk says: the last custom and AI titles in it, the first prompt the person
// typed, and the first working folder named. `isCut` drops the first line, which a read from the
// middle of the file starts inside.
export type TranscriptFacts = { customTitle?: string; aiTitle?: string; prompt?: string; cwd?: string }

const promptText = (content: unknown): string | undefined => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const part = content.find(
    (entry): entry is { type: 'text'; text: string } =>
      typeof entry === 'object' && entry !== null && (entry as { type?: unknown }).type === 'text' && typeof (entry as { text?: unknown }).text === 'string',
  )

  return part?.text
}

export const scanTranscript = (text: string, isCut = false): TranscriptFacts => {
  const facts: TranscriptFacts = {}
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    if ((isCut && index === 0) || line.trim() === '') continue
    const isTitle = line.includes('"custom-title"') || line.includes('"ai-title"')
    const isUser = facts.prompt === undefined && line.includes('"user"')
    const hasCwd = facts.cwd === undefined && line.includes('"cwd"')
    if (!isTitle && !isUser && !hasCwd) continue
    let entry: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null) continue
      entry = parsed as Record<string, unknown>
    } catch {
      continue
    }
    if (facts.cwd === undefined && typeof entry.cwd === 'string' && entry.cwd !== '') facts.cwd = entry.cwd
    if (entry.type === 'custom-title' && typeof entry.customTitle === 'string' && clean(entry.customTitle) !== '') facts.customTitle = entry.customTitle
    if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && clean(entry.aiTitle) !== '') facts.aiTitle = entry.aiTitle
    if (facts.prompt === undefined && entry.type === 'user' && entry.isMeta !== true && entry.isSidechain !== true) {
      const message = entry.message as { content?: unknown } | undefined
      const typed = clean(promptText(message?.content) ?? '')
      if (typed !== '' && !typed.startsWith('<') && !typed.startsWith(COMPACTION_PREFACE)) facts.prompt = typed
    }
  }

  return facts
}

// The facts of a read from the end (`tail`) and one from the start (`head`) of the same file: the
// titles from the end, where the latest stand; the prompt and the folder from the start.
export const mergeFacts = (tail: TranscriptFacts, head: TranscriptFacts = {}): TranscriptFacts => {
  const merged: TranscriptFacts = {}
  const customTitle = tail.customTitle ?? head.customTitle
  const aiTitle = tail.aiTitle ?? head.aiTitle
  const prompt = head.prompt ?? tail.prompt
  const cwd = head.cwd ?? tail.cwd
  if (customTitle !== undefined) merged.customTitle = customTitle
  if (aiTitle !== undefined) merged.aiTitle = aiTitle
  if (prompt !== undefined) merged.prompt = prompt
  if (cwd !== undefined) merged.cwd = cwd

  return merged
}

export const hasTitle = (facts: TranscriptFacts): boolean => facts.customTitle !== undefined || facts.aiTitle !== undefined

const shorten = (text: string, max: number): string => (text.length <= max ? text : max <= 1 ? '…' : `${text.slice(0, max - 1)}…`)

// The title a session is known by: the one the person gave it, else the one Claude Code made up,
// else the first prompt; cleaned and cut to SESSION_TITLE_MAX.
export const pickTitle = (facts: TranscriptFacts): string | undefined => {
  const title = [facts.customTitle, facts.aiTitle, facts.prompt].map(text => clean(text ?? '')).find(text => text !== '')

  return title === undefined ? undefined : shorten(title, SESSION_TITLE_MAX)
}

// The detail a transcript gives a row.
export const detailOf = (facts: TranscriptFacts): SessionDetail => {
  const title = pickTitle(facts)

  return { ...(facts.cwd !== undefined ? { cwd: facts.cwd } : {}), ...(title !== undefined ? { title } : {}) }
}

// `ps -o pid=,lstart=` output as a map from pid to its start time, whitespace evened out.
export const parsePsStart = (stdout: string): Map<number, string> => {
  const started = new Map<number, string>()
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (match !== null) started.set(Number(match[1]), (match[2] ?? '').replace(/\s+/g, ' '))
  }

  return started
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// `Thu Nov 12 15:23:45 2026`, the `ps -o lstart=` form, as milliseconds read as if in UTC; null
// for another form.
export const lstartMs = (text: string): number | null => {
  const match = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(text)
  if (match === null) return null
  const month = MONTHS.indexOf((match[1] ?? '').toLowerCase())
  if (month < 0) return null

  return Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]))
}

// The widest gap between two time zones, and the step all their offsets are a whole number of.
const MAX_ZONE_GAP_MS = 14 * 60 * 60 * 1000
const ZONE_STEP_MS = 15 * 60 * 1000

// Whether the process a sessions file names runs now: its pid is alive and, when the file says
// when it started, it is the same process (a pid is reused once its process ends). Claude Code
// writes `procStart` in another time zone than `ps` may print (UTC against local time on this
// machine), so the two match when they differ by a whole zone offset to the second.
export const isSameProcess = (procStart: unknown, started: string | undefined): boolean => {
  if (started === undefined) return false
  if (typeof procStart !== 'string' || procStart.trim() === '') return true
  const [written, seen] = [lstartMs(procStart), lstartMs(started)]
  if (written === null || seen === null) return procStart.replace(/\s+/g, ' ').trim() === started
  const gap = Math.abs(written - seen)

  return gap <= MAX_ZONE_GAP_MS && gap % ZONE_STEP_MS === 0
}

// A sessions file's fields, or null when it is not one.
export const parseSessionFile = (value: unknown): (RunningSession & { procStart?: string }) | null => {
  if (typeof value !== 'object' || value === null) return null
  const entry = value as Record<string, unknown>
  if (!Number.isSafeInteger(entry.pid) || Number(entry.pid) <= 0 || typeof entry.sessionId !== 'string' || entry.sessionId === '') return null

  return {
    sessionId: entry.sessionId,
    pid: Number(entry.pid),
    ...(typeof entry.cwd === 'string' && entry.cwd !== '' ? { cwd: entry.cwd } : {}),
    ...(typeof entry.tmux === 'string' && entry.tmux !== '' ? { tmux: entry.tmux } : {}),
    ...(typeof entry.procStart === 'string' ? { procStart: entry.procStart } : {}),
  }
}

// The project folder name Claude Code files a session's transcript under: its working folder with
// every character other than a letter or a digit turned into `-`.
export const projectFolderName = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

// How long ago, in one short unit: `now`, `12m`, `3h`, `4d`, `5w`.
export const age = (ms: number, now: number): string => {
  const minutes = Math.max(0, Math.floor((now - ms) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  const days = Math.floor(hours / 24)

  return days < 14 ? `${days}d` : `${Math.floor(days / 7)}w`
}

// The folder with the home folder as `~`.
export const homeRelative = (cwd: string | undefined, home: string | undefined): string => {
  if (cwd === undefined) return '?'
  if (home !== undefined && home !== '' && (cwd === home || cwd.startsWith(`${home}/`))) return `~${cwd.slice(home.length)}`

  return cwd
}

// One row's columns as text, for both the plain list and the pane.
export type SessionCells = {
  mark: string
  id: string
  open: string
  due: string
  age: string
  folder: string
  title: string
  client: string
}

export const sessionCells = (row: SessionRow, now: number, today: string, home?: string): SessionCells => ({
  mark: row.isRunning ? '●' : '○',
  id: row.sessionId.slice(0, SHORT_ID_LENGTH),
  open: `${row.open} open`,
  due: row.due === undefined ? '' : `${isDueNow(row.dueState) ? '!' : ''}${shortDue(row.due, today)}`,
  age: age(row.updatedAt, now),
  folder: homeRelative(row.cwd, home),
  title: row.title ?? '(no title)',
  client: row.client === 'codex' ? 'codex' : '',
})

const quoteShell = (text: string): string => (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\"'\"'")}'`)

// The command that opens the session again where it ran.
export const resumeCommand = (row: SessionRow): string => {
  const resume = row.client === 'codex' ? `codex resume ${row.sessionId}` : `claude --resume ${row.sessionId}`

  return row.cwd === undefined ? resume : `cd ${quoteShell(row.cwd)} && ${resume}`
}

// The list as plain text, one session per line with the command that resumes it under it.
// `notes` say what could not be read.
export const sessionsText = (
  rows: readonly SessionRow[],
  options: { now: number; today: string; home?: string; cap?: number; notes?: readonly string[] },
): string => {
  const cap = options.cap ?? SESSIONS_CAP
  const notes = options.notes ?? []
  if (rows.length === 0) return ['No session has an open window item.', ...notes].join('\n')
  const shown = rows.slice(0, cap)
  const lines = [`Sessions with open window items: ${rows.length} (● running; days that have come are marked !).`]
  for (const row of shown) {
    const cells = sessionCells(row, options.now, options.today, options.home)
    const here = row.isCurrent ? ' (this session)' : ''
    const parts = [cells.mark, cells.id, cells.open, cells.due, cells.age, cells.client, cells.folder].filter(part => part !== '')
    lines.push(`${parts.join('  ')}  ${cells.title}${here}`)
    lines.push(row.isRunning ? `    running${row.tmux !== undefined ? `: tmux switch-client -t ${quoteShell(row.tmux)}` : ''}` : `    ${resumeCommand(row)}`)
  }
  if (rows.length > shown.length) lines.push(`+${rows.length - shown.length} more`)

  return [...lines, ...notes].join('\n')
}
