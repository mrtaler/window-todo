import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { ActivityState, Plan } from '../shared/types'
import { changeWindow, currentWindow } from './window-store'
import { applyInboxEntries, parseInbox, pendingEntries } from '../shared/inbox'

// The file mirror for the terminal pane (dist/codex/panel.cjs). Under the tmux launcher
// (claude/launch.cjs, which sets WINDOW_TODO_PANE=1) the mod writes the session's plan, window list
// and activity to the state file the Codex adapter uses, `<dir>/<sha256(sessionId)>.json`, and
// applies the changes the pane leaves in `<dir>/<sha256(sessionId)>.inbox.json`. Without the
// variable nothing here touches the file system.

// The shortest gap between two writes; a burst of activity events inside it is written once, at its end.
export const MIRROR_INTERVAL_MS = 200
// How often the inbox is read between turns.
export const INBOX_POLL_MS = 2000

// `applied` is the last inbox entry applied to `sessionId`'s list; `writtenAt` the time of the last
// write (null before the first); `dueAt` the time a deferred write is due (0 when none is);
// `bound` the session the pane binding names.
export type MirrorState = { sessionId: string; applied: number; writtenAt: number | null; dueAt: number; bound: string }

const EMPTY_MIRROR: MirrorState = { sessionId: '', applied: 0, writtenAt: null, dueAt: 0, bound: '' }
export const mirrorState = atom({ plugin: 'window-todo', key: 'mirror' } as const, EMPTY_MIRROR)

type MirrorTarget = { dir: string; binding: string | null }

// Reads the plan and the activity when a write runs. Their atoms live in register.tsx, the one
// file that may read them.
export type MirrorSnapshot = { plan: Plan; activity: ActivityState }
type Snapshot = () => Promise<MirrorSnapshot>

const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path)

// SHA-256 of the text as lowercase hex, the name codex/state.cjs gives a session's files.
export const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))

  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export const stateFile = async (dir: string, sessionId: string): Promise<string> => `${dir}/${await sha256Hex(sessionId)}.json`
export const inboxFile = async (dir: string, sessionId: string): Promise<string> =>
  `${dir}/${await sha256Hex(sessionId)}.inbox.json`
const bindingFile = async (dir: string, token: string): Promise<string> => `${dir}/binding-${await sha256Hex(token)}.json`

// The directory codex/state.cjs uses: WINDOW_TODO_STATE_DIR, else $XDG_STATE_HOME/window-todo, else
// $HOME/.local/state/window-todo. Null when none can be named.
async function stateDirectory($: EngineInterface): Promise<string | null> {
  const explicit = await $.env.get('WINDOW_TODO_STATE_DIR')
  if (explicit !== undefined && explicit !== '') return trimSlash(explicit)
  const xdg = await $.env.get('XDG_STATE_HOME')
  if (xdg !== undefined && xdg !== '') return `${trimSlash(xdg)}/window-todo`
  const home = await $.env.get('HOME')
  if (home !== undefined && home !== '') return `${trimSlash(home)}/.local/state/window-todo`

  return null
}

// Where the mirror goes, or null when the pane is not on (or the environment cannot be read).
export async function mirrorTarget($: EngineInterface): Promise<MirrorTarget | null> {
  try {
    if ((await $.env.get('WINDOW_TODO_PANE')) !== '1') return null
    const dir = await stateDirectory($)
    if (dir === null) return null
    const binding = await $.env.get('WINDOW_TODO_PANEL_BINDING')

    return { dir, binding: binding === undefined || binding === '' ? null : binding }
  } catch {
    return null
  }
}

function mirrorLog($: EngineInterface, text: string): void {
  try {
    $.ui.log(`window-todo: ${text}`.slice(0, 4000), { to: 'debug' })
  } catch {
    // Logging must never throw out of a hook.
  }
}

// The mirror record for `sessionId`. On the first use for a session the applied number is read back
// from the session's state file, so a restarted or resumed process does not apply an entry twice.
async function sessionMirror($: EngineInterface, target: MirrorTarget, sessionId: string): Promise<MirrorState> {
  const cur = await read($, mirrorState)
  if (cur.sessionId === sessionId) return cur
  let applied = 0
  try {
    const file = await stateFile(target.dir, sessionId)
    if (await $.fs.exists(file)) {
      const stored = JSON.parse(await $.fs.read(file)) as { sessionId?: unknown; inbox?: { applied?: unknown } }
      const value = stored.inbox?.applied
      if (stored.sessionId === sessionId && Number.isSafeInteger(value) && Number(value) > 0) applied = Number(value)
    }
  } catch {
    // An unreadable earlier file counts as none: its entries were applied or are lost with it.
  }
  await update($, mirrorState, m => (m.sessionId === sessionId ? m : { ...m, sessionId, applied }))

  return read($, mirrorState)
}

// Writes the state file, and the pane binding when the session it names has changed.
async function writeMirror($: EngineInterface, target: MirrorTarget, snapshot: Snapshot): Promise<void> {
  const sessionId = await $.session.id()
  const [{ plan: p, activity: a }, w] = await Promise.all([snapshot(), currentWindow($)])
  const m = await sessionMirror($, target, sessionId)
  const now = await $.clock.now()
  const record = {
    version: 1,
    sessionId,
    client: 'claude',
    plan: p,
    window: w,
    activity: a,
    inbox: { applied: m.applied },
    updatedAt: now,
  }
  // $.fs.write has no rename, so the pane may read a file being written; it keeps its last frame
  // until the next read parses.
  await $.fs.write(await stateFile(target.dir, sessionId), `${JSON.stringify(record)}\n`)
  if (target.binding !== null && m.bound !== sessionId) {
    await $.fs.write(await bindingFile(target.dir, target.binding), `${JSON.stringify({ sessionId, closed: false })}\n`)
    await update($, mirrorState, cur => ({ ...cur, bound: sessionId }))
  }
}

// Writes run one at a time, each reading the state as it is when its turn comes, so the last
// write on disk is never older than an earlier one.
let writeChain: Promise<void> = Promise.resolve()

function queueWrite($: EngineInterface, target: MirrorTarget, snapshot: Snapshot): Promise<void> {
  const run = writeChain.then(async () => {
    try {
      await writeMirror($, target, snapshot)
    } catch (error) {
      mirrorLog($, `pane mirror write failed ${String(error)}`)
    }
  })
  writeChain = run

  return run
}

// The deferred write at the end of a burst.
async function writeDeferred($: EngineInterface, snapshot: Snapshot): Promise<void> {
  const target = await mirrorTarget($)
  if (target === null) return
  const now = await $.clock.now()
  await update($, mirrorState, m => ({ ...m, writtenAt: now, dueAt: 0 }))
  await queueWrite($, target, snapshot)
}

// Mirrors the current plan, list and activity to the pane's state file. At most one write per
// MIRROR_INTERVAL_MS: a change inside the interval schedules one write at its end. `force` writes
// now, for the points after which no further change may come (a turn's end, the session's end).
// Never throws.
export async function publishMirror($: EngineInterface, snapshot: Snapshot, force = false): Promise<void> {
  try {
    const target = await mirrorTarget($)
    if (target === null) return
    const now = await $.clock.now()
    const cur = await read($, mirrorState)
    if (!force && cur.writtenAt !== null && now - cur.writtenAt < MIRROR_INTERVAL_MS) {
      if (cur.dueAt > now) return
      const due = cur.writtenAt + MIRROR_INTERVAL_MS
      await update($, mirrorState, m => ({ ...m, dueAt: due }))
      $.clock.after(due - now, () => {
        void writeDeferred($, snapshot).catch(error => mirrorLog($, `pane mirror deferred write failed ${String(error)}`))
      })

      return
    }
    await update($, mirrorState, m => ({ ...m, writtenAt: now }))
    await queueWrite($, target, snapshot)
  } catch (error) {
    mirrorLog($, `pane mirror failed ${String(error)}`)
  }
}

async function drainOnce($: EngineInterface): Promise<boolean> {
  const target = await mirrorTarget($)
  if (target === null) return false
  const sessionId = await $.session.id()
  const file = await inboxFile(target.dir, sessionId)
  if (!(await $.fs.exists(file))) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(await $.fs.read(file))
  } catch {
    // The pane writes the inbox by rename, so a file that does not parse is not one being written;
    // it is read again next time.
    return false
  }
  const m = await sessionMirror($, target, sessionId)
  const pending = pendingEntries(parseInbox(parsed, sessionId), m.applied)
  if (pending.length === 0) return false
  let applied = m.applied
  await changeWindow($, list => {
    const out = applyInboxEntries(list, pending)
    applied = Math.max(m.applied, out.applied)

    return out.list
  })
  await update($, mirrorState, cur => (cur.sessionId === sessionId ? { ...cur, applied: Math.max(cur.applied, applied) } : cur))

  return true
}

// Drains run one at a time, so a poll and a turn start never apply the same entry twice.
let drainChain: Promise<unknown> = Promise.resolve()

// Applies the pane's pending inbox entries to the window list through changeWindow. Answers whether
// any was applied (the caller redraws and so mirrors the result, which tells the pane to drop them).
export function drainInbox($: EngineInterface): Promise<boolean> {
  const run = drainChain.then(() => drainOnce($))
  drainChain = run.catch(() => undefined)

  return run
}

// Whether the state file was last written for another session than the one running now: after a
// /clear (no session.start follows it) nothing else redraws until the next prompt.
export async function mirrorBehind($: EngineInterface): Promise<boolean> {
  if ((await mirrorTarget($)) === null) return false
  const [cur, sessionId] = await Promise.all([read($, mirrorState), $.session.id()])

  return cur.sessionId !== sessionId
}
