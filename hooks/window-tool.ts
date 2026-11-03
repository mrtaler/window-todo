import { KIND_NAMES, parseKind, WINDOW_KINDS } from './window'
import type { WindowKind } from './window'

// The window tool: Claude's own way to add, close and skip items of the window list,
// beside the observer and /todo. The Stop reminder sends Claude here when an answer ends on a
// question the list does not carry.
export const WINDOW_TOOL_SHORT_NAME = 'window'
export const WINDOW_TOOL_FULL_NAME = `mcp__window-todo__${WINDOW_TOOL_SHORT_NAME}`

export const WINDOW_TOOL_DESCRIPTION = [
  "Keep this window's list of open items, shown under the plan in the user's pane.",
  `Kinds: ${WINDOW_KINDS.map(kind => `${kind} ${KIND_NAMES[kind]}`).join(', ')}.`,
  'op "add" with "kind" and a one-line "title" adds an item and answers its id; op "done" with "ids" closes items; op "skip" with "ids" moves items to the bottom with the same ids. Every call answers the list as it is now.',
  'Any question you end a reply on that waits for the user goes in as a Q item.',
].join(' ')

export const WINDOW_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['add', 'done', 'skip'] },
    kind: { type: 'string', enum: [...WINDOW_KINDS] },
    title: { type: 'string' },
    ids: { type: 'array', items: { type: 'string' } },
  },
  required: ['op'],
} as const

export type WindowInput =
  | { op: 'add'; kind: WindowKind; title: string }
  | { op: 'done' | 'skip'; ids: string[] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const parseWindowInput = (raw: unknown): WindowInput | { error: string } => {
  if (!isRecord(raw)) return { error: 'the window tool takes an object with an "op" field' }
  switch (raw.op) {
    case 'add': {
      const kind = typeof raw.kind === 'string' ? parseKind(raw.kind) : null
      if (kind === null) return { error: `op add needs "kind", one of ${WINDOW_KINDS.join(', ')}` }
      if (typeof raw.title !== 'string') return { error: 'op add needs a "title" string' }

      return { op: 'add', kind, title: raw.title }
    }
    case 'done':
    case 'skip': {
      const ids = raw.ids
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => typeof id === 'string')) {
        return { error: `op ${raw.op} needs "ids", a non-empty array of strings` }
      }

      return { op: raw.op, ids }
    }
    default:
      return { error: 'unknown or missing "op"; use add, done or skip' }
  }
}
