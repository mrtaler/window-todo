import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import { emptyWindow, parseStoredWindow } from './window'
import type { WindowList } from './window'

// The list lives in an atom for drawing and in the plugin store, one key per session, so a
// /resume of that session finds it again. `windowSession` names the session the atom holds.
export const windowList = atom({ plugin: 'window-todo', key: 'window' } as const, emptyWindow())
export const windowSession = atom({ plugin: 'window-todo', key: 'windowSession' } as const, '' as string)

export const WINDOW_STORE_PREFIX = 'window:'
// Lists of sessions untouched this long are deleted at session start.
export const WINDOW_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

type StoredWindow = { updatedAt: number; list: WindowList }

const storeKey = (sessionId: string): string => `${WINDOW_STORE_PREFIX}${sessionId}`

const parseStored = (value: unknown): StoredWindow | null => {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as { updatedAt?: unknown; list?: unknown }
  const list = parseStoredWindow(candidate.list)
  if (list === null || typeof candidate.updatedAt !== 'number') return null

  return { updatedAt: candidate.updatedAt, list }
}

// The list of the session the process runs under now. When that session differs from the one
// the atom holds (first use, /clear, /resume), the stored list of the new session is loaded, or
// an empty one when it has none. Top-level function declaration because `$` is passed to it.
export async function currentWindow($: EngineInterface): Promise<WindowList> {
  const sessionId = await $.session.id()
  if ((await read($, windowSession)) === sessionId) return read($, windowList)
  const stored = parseStored(await $.store.get(storeKey(sessionId)))
  const list = stored?.list ?? emptyWindow()
  await update($, windowList, () => list)
  await update($, windowSession, () => sessionId)

  return list
}

// Applies `change` to the current list and saves the result under the current session.
// Answers the list as saved.
export async function changeWindow(
  $: EngineInterface,
  change: (list: WindowList) => WindowList,
): Promise<WindowList> {
  await currentWindow($)
  await update($, windowList, change)
  const [list, sessionId, now] = await Promise.all([read($, windowList), read($, windowSession), $.clock.now()])
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
  await update($, windowList, () => emptyWindow())
  await update($, windowSession, () => '')
}

// Deletes the stored lists of other sessions not changed for WINDOW_MAX_AGE_MS. An entry
// that is not a list is left alone: it is not this layer's to judge.
export async function sweepWindows($: EngineInterface): Promise<void> {
  const [sessionId, now, keys] = await Promise.all([$.session.id(), $.clock.now(), $.store.keys()])
  for (const key of keys) {
    if (!key.startsWith(WINDOW_STORE_PREFIX) || key === storeKey(sessionId)) continue
    const stored = parseStored(await $.store.get(key))
    if (stored !== null && now - stored.updatedAt > WINDOW_MAX_AGE_MS) await $.store.delete(key)
  }
}
