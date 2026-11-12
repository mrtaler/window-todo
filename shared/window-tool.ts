import { KIND_NAMES, parseKind, WINDOW_KINDS } from './window'
import type { WindowKind } from './window'
import { DUE_FORMS, parseDue } from './due'

// Client-independent window operations and their input schema.
export const WINDOW_TOOL_SHORT_NAME = 'window'

export const WINDOW_TOOL_DESCRIPTION = [
  "Keep this window's list of open items, shown under the plan in the user's pane.",
  `Kinds: ${WINDOW_KINDS.map(kind => `${kind} ${KIND_NAMES[kind]}`).join(', ')}.`,
  'op "add" with "kind" and a one-line "title" adds an item and answers its id; op "done" with "ids" closes items; op "skip" with "ids" moves items to the bottom with the same ids; op "prune" removes the done items (ids are still never reused). Every call answers the list as it is now.',
  `An item may carry "due", the day to come back on (${DUE_FORMS}), mostly for a W item: give it on op "add", or set it later with op "due" and "ids" ("due":"clear" removes it). Set a day only when the user names one.`,
  'Any question you end a reply on that waits for the user goes in as a Q item.',
].join(' ')

export const WINDOW_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['add', 'done', 'skip', 'prune', 'due'] },
    kind: { type: 'string', enum: [...WINDOW_KINDS] },
    title: { type: 'string' },
    ids: { type: 'array', items: { type: 'string' } },
    // The day as written (see parseDue); "clear" on op due removes it.
    due: { type: 'string' },
  },
  required: ['op'],
} as const

// `due` stays as written: reading a relative day needs today's date, which the caller has.
export type WindowInput =
  | { op: 'add'; kind: WindowKind; title: string; due?: string }
  | { op: 'done' | 'skip'; ids: string[] }
  | { op: 'due'; ids: string[]; due: string }
  | { op: 'prune' }

// Whether a written day asks to remove the day.
export const isClearDue = (raw: string): boolean => ['clear', 'none', '-', ''].includes(raw.trim().toLowerCase())

// The day a written `due` names on `today`, or null when it asks to remove the day.
export const readDue = (raw: string, today: string): { due: string | null } | { error: string } =>
  isClearDue(raw) ? { due: null } : parseDue(raw, today)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const parseWindowInput = (raw: unknown): WindowInput | { error: string } => {
  if (!isRecord(raw)) return { error: 'the window tool takes an object with an "op" field' }
  switch (raw.op) {
    case 'add': {
      const kind = typeof raw.kind === 'string' ? parseKind(raw.kind) : null
      if (kind === null) return { error: `op add needs "kind", one of ${WINDOW_KINDS.join(', ')}` }
      if (typeof raw.title !== 'string') return { error: 'op add needs a "title" string' }
      if (raw.due !== undefined && typeof raw.due !== 'string') return { error: '"due" is a string' }

      return { op: 'add', kind, title: raw.title, ...(typeof raw.due === 'string' && !isClearDue(raw.due) ? { due: raw.due } : {}) }
    }
    case 'done':
    case 'skip':
    case 'due': {
      const ids = raw.ids
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => typeof id === 'string')) {
        return { error: `op ${raw.op} needs "ids", a non-empty array of strings` }
      }
      if (raw.op !== 'due') return { op: raw.op, ids }
      if (typeof raw.due !== 'string') return { error: `op due needs "due": ${DUE_FORMS}, or "clear"` }

      return { op: 'due', ids, due: raw.due }
    }
    case 'prune':
      return { op: 'prune' }
    default:
      return { error: 'unknown or missing "op"; use add, done, skip, due or prune' }
  }
}
