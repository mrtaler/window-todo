import type { WindowList } from './types'
import { closeItems, pruneDone, setDue, skipItems } from './window'
import { isIsoDay } from './due'

// The inbox: changes to the window list asked for outside the client that owns the list (the
// terminal pane), waiting for that client to apply them. The pane is the only writer of the inbox
// file; the client only reads it and reports the last sequence number it applied in the state
// file, after which the pane drops the applied entries. No side ever has to delete what the other
// may be writing.
// A `due` entry carries the day it sets, resolved by the pane; without one it clears the day.
export type InboxOp = 'done' | 'skip' | 'prune' | 'due'
export type InboxEntry = { seq: number; op: InboxOp; ids: string[]; at: number; due?: string }

export const INBOX_OPS: readonly InboxOp[] = ['done', 'skip', 'prune', 'due']
// Bounds what one inbox can ask for, so a runaway pane cannot grow the file without limit.
export const INBOX_MAX_ENTRIES = 200
const INBOX_MAX_IDS = 50

const isOp = (value: unknown): value is InboxOp => typeof value === 'string' && (INBOX_OPS as readonly string[]).includes(value)

// The entries of an inbox file's parsed JSON, in sequence order. A file for another session, or not
// in the inbox shape, has none; a malformed entry is dropped and the rest are kept.
export const parseInbox = (value: unknown, sessionId: string): InboxEntry[] => {
  if (typeof value !== 'object' || value === null) return []
  const candidate = value as { version?: unknown; sessionId?: unknown; entries?: unknown }
  if (candidate.version !== 1 || candidate.sessionId !== sessionId || !Array.isArray(candidate.entries)) return []
  const entries: InboxEntry[] = []
  for (const raw of candidate.entries.slice(0, INBOX_MAX_ENTRIES)) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as Record<string, unknown>
    if (!Number.isSafeInteger(entry.seq) || Number(entry.seq) <= 0 || !isOp(entry.op)) continue
    const ids = Array.isArray(entry.ids) ? entry.ids.filter((id): id is string => typeof id === 'string').slice(0, INBOX_MAX_IDS) : []
    if (entry.op !== 'prune' && ids.length === 0) continue
    const due = entry.op === 'due' && isIsoDay(entry.due) ? { due: entry.due } : {}
    entries.push({ seq: Number(entry.seq), op: entry.op, ids, at: typeof entry.at === 'number' ? entry.at : 0, ...due })
  }

  return entries.sort((a, b) => a.seq - b.seq)
}

// The entries not yet applied: those numbered after `applied`.
export const pendingEntries = (entries: readonly InboxEntry[], applied: number): InboxEntry[] =>
  entries.filter(entry => entry.seq > applied)

// Applies the entries in order. Answers the list and the highest sequence number seen, which is
// the new `applied` (an entry that names no known item still counts as applied).
export const applyInboxEntries = (
  list: WindowList,
  entries: readonly InboxEntry[],
): { list: WindowList; applied: number; changed: string[] } => {
  let current = list
  let applied = 0
  const changed: string[] = []
  for (const entry of entries) {
    const result =
      entry.op === 'done'
        ? closeItems(current, entry.ids)
        : entry.op === 'skip'
          ? skipItems(current, entry.ids)
          : entry.op === 'due'
            ? setDue(current, entry.ids, entry.due ?? null)
            : pruneDone(current)
    current = result.list
    changed.push(...result.changed)
    applied = Math.max(applied, entry.seq)
  }

  return { list: current, applied, changed }
}
