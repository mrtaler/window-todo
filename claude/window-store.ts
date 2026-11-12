import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import { emptyWindow, openItems, parseStoredWindow, pruneDone } from '../shared/window'
import type { WindowList } from '../shared/window'

// The list lives in an atom for drawing and in the plugin store, one key per session, so a
// /resume of that session finds it again. `windowSession` names the session the atom holds.
export const windowList = atom({ plugin: 'window-todo', key: 'window' } as const, emptyWindow())
export const windowSession = atom({ plugin: 'window-todo', key: 'windowSession' } as const, '' as string)

export const WINDOW_STORE_PREFIX = 'window:'
// Lists of sessions untouched this long are deleted at session start.
export const WINDOW_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

// A /clear hands the open items of the cleared session to the next one: the host resets the
// atoms after session.end and no session.start follows, so the store holds them until the new
// session's first load takes them. The store is one file shared by every running Claude Code, so
// the key names this loaded module and only the process that cleared takes its carry; a hot
// reload gets a new name and leaves the carry to the sweep.
export const CARRY_STORE_PREFIX = 'carry:window:'
const CARRY_KEY = `${CARRY_STORE_PREFIX}${crypto.randomUUID()}`
// The first load after a /clear is the next prompt (or the tmux pane's poll), which may come
// after a long pause; since no other window can take the carry, the limit only retires one left
// behind by a process that ended.
export const CARRY_MAX_AGE_MS = 24 * 60 * 60 * 1000

type StoredWindow = { updatedAt: number; list: WindowList }
type StoredCarry = { from: string; at: number; list: WindowList }

const storeKey = (sessionId: string): string => `${WINDOW_STORE_PREFIX}${sessionId}`

const parseStored = (value: unknown): StoredWindow | null => {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as { updatedAt?: unknown; list?: unknown }
  const list = parseStoredWindow(candidate.list)
  if (list === null || typeof candidate.updatedAt !== 'number') return null

  return { updatedAt: candidate.updatedAt, list }
}

const parseCarry = (value: unknown): StoredCarry | null => {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as { from?: unknown; at?: unknown; list?: unknown }
  const list = parseStoredWindow(candidate.list)
  if (list === null || typeof candidate.from !== 'string' || typeof candidate.at !== 'number') return null

  return { from: candidate.from, at: candidate.at, list }
}

// The one load of a session's list in flight or done since the last forget, kept in the module:
// reads of an atom within one dispatch see one moment, so two concurrent first uses would both
// see the atom unloaded and both load (and both take the carry). Checked and set with no await
// between, so the second use waits on the first one's load.
let loading: { sessionId: string; list: Promise<WindowList> } | null = null

// The list of the session the process runs under now. When that session differs from the one
// the atom holds (first use, /clear, /resume), the stored list of the new session is loaded; a
// session with none takes the carry a /clear left, or starts empty. Top-level function
// declaration because `$` is passed to it.
export async function currentWindow($: EngineInterface): Promise<WindowList> {
  const sessionId = await $.session.id()
  if ((await read($, windowSession)) === sessionId) return read($, windowList)
  if (loading?.sessionId !== sessionId) {
    const entry = { sessionId, list: loadWindow($, sessionId) }
    loading = entry
    // A failed load is not kept, so the next use tries again.
    entry.list.catch(() => {
      if (loading === entry) loading = null
    })
  }

  return loading.list
}

async function loadWindow($: EngineInterface, sessionId: string): Promise<WindowList> {
  const stored = parseStored(await $.store.get(storeKey(sessionId)))
  const list = stored?.list ?? (await takeCarry($, sessionId)) ?? emptyWindow()
  await update($, windowList, () => list)
  await update($, windowSession, () => sessionId)

  return list
}

// The carry this process left at a /clear, saved as the list of `sessionId` and removed from the
// store; null when there is none, it is stale, or `sessionId` is the cleared session itself.
// Says once how many items came over.
async function takeCarry($: EngineInterface, sessionId: string): Promise<WindowList | null> {
  const carry = parseCarry(await $.store.get(CARRY_KEY))
  if (carry === null || carry.from === sessionId) return null
  const now = await $.clock.now()
  await $.store.delete(CARRY_KEY)
  if (now - carry.at > CARRY_MAX_AGE_MS) return null
  const stored: StoredWindow = { updatedAt: now, list: carry.list }
  await $.store.set(storeKey(sessionId), stored)
  const count = carry.list.items.length
  try {
    $.ui.toast(`Window list: ${count} open ${count === 1 ? 'item' : 'items'} carried over from the cleared session.`)
  } catch {
    // The toast is a note; the carry has landed without it.
  }

  return carry.list
}

// At a /clear: leaves the open items of the ending session `from` for the session that follows,
// with the same ids and counters. Closed items stay in `from`'s own stored list. A session with
// nothing open takes back an earlier carry, so it is not handed on.
export async function stashCarry($: EngineInterface, from: string): Promise<void> {
  const held = (await read($, windowSession)) === from ? await read($, windowList) : null
  const list = held ?? parseStored(await $.store.get(storeKey(from)))?.list ?? emptyWindow()
  if (openItems(list).length === 0) return dropCarry($)
  const carry: StoredCarry = { from, at: await $.clock.now(), list: pruneDone(list).list }
  await $.store.set(CARRY_KEY, carry)
}

// Removes this process's carry, at a /resume: the resumed session keeps its own list, and a
// session with none must not take a carry meant for the session after a /clear.
export async function dropCarry($: EngineInterface): Promise<void> {
  if ((await $.store.get(CARRY_KEY)) !== undefined) await $.store.delete(CARRY_KEY)
}

// Applies `change` to the current list and saves the result under the current session.
// Answers the list as saved.
export async function changeWindow(
  $: EngineInterface,
  change: (list: WindowList) => WindowList,
): Promise<WindowList> {
  await currentWindow($)
  // The list as this update wrote it: a read after it may see the dispatch's earlier moment.
  const list = await update($, windowList, change)
  const [sessionId, now] = await Promise.all([read($, windowSession), $.clock.now()])
  const stored: StoredWindow = { updatedAt: now, list }
  await $.store.set(storeKey(sessionId), stored)

  return list
}

// The list as the pane and the status line draw it, without a store read.
export async function readWindow($: EngineInterface): Promise<WindowList> {
  return read($, windowList)
}

// Forgets the atom's session, so the next use loads the list of whichever session follows.
export async function forgetWindow($: EngineInterface): Promise<void> {
  loading = null
  await update($, windowList, () => emptyWindow())
  await update($, windowSession, () => '')
}

// Deletes the stored lists of other sessions not changed for WINDOW_MAX_AGE_MS, and the carries
// older than CARRY_MAX_AGE_MS (left by a process that ended before it took its own). A list with an
// open item that has a day to come back on is kept however old, whether the day has passed or not:
// its session waits on something. An entry that is not a list or a carry is left alone: it is not
// this layer's to judge.
export async function sweepWindows($: EngineInterface): Promise<void> {
  const [sessionId, now, keys] = await Promise.all([$.session.id(), $.clock.now(), $.store.keys()])
  for (const key of keys) {
    if (key.startsWith(CARRY_STORE_PREFIX)) {
      const carry = parseCarry(await $.store.get(key))
      if (carry !== null && now - carry.at > CARRY_MAX_AGE_MS) await $.store.delete(key)
      continue
    }
    if (!key.startsWith(WINDOW_STORE_PREFIX) || key === storeKey(sessionId)) continue
    const stored = parseStored(await $.store.get(key))
    if (stored === null || now - stored.updatedAt <= WINDOW_MAX_AGE_MS) continue
    if (openItems(stored.list).some(item => item.due !== undefined)) continue
    await $.store.delete(key)
  }
}
