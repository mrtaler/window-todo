import { addItem, closeItems, describeWindow, normaliseId, openItems, parseKind, skipItems, WINDOW_TITLE_MAX } from './window'
import type { WindowKind, WindowList } from './window'
import { clean } from './sanitize'

// The observer: after each answered main-loop turn a small model reads the turn and the list
// and proposes the changes. Adapted from the incremental update of cldotdev/claude-todo-list.
// Each text sent to the observer is clipped to this many characters: the first quarter and the
// rest from the end, where an answer usually ends with the question it leaves open.
export const OBSERVER_TEXT_MAX = 100_000

export const OBSERVER_SYSTEM = `You keep the window list of a coding conversation between a user and an agent: the items still open in this window. Each item has a kind:
- T (task): work the user or the agent deferred or promised and has not done yet.
- F (fix): something found that has to be fixed.
- Q (question): a question or choice put to the user and not answered yet.
- W (wait): something the work waits on outside the conversation, such as a CI run, a review or a deploy.

Do not list the step being carried out right now, or anything raised and finished within the same turn.

For this turn, decide:
- "done": ids of current items the turn completes, answers, decides or makes moot, even when the turn does not name them. A user's reply to a question closes that question.
- "skip": ids the user's message of this turn puts off or skips (for example "F1 can wait", "skip T2", "T3 later"). Only ids the user names.
- "add": new open items as {"kind", "title"} objects. A title is one short line, at most ${WINDOW_TITLE_MAX} characters, in the language of the agent's answers. Never add an item the list already holds.

Reply with a JSON object and nothing else, no code fence: {"done":[],"skip":[],"add":[]}.`

export type ObserverTurn = { userText: string; answer: string; previousAnswer: string }

export type ObserverChange = {
  done: string[]
  skip: string[]
  add: Array<{ kind: WindowKind; title: string }>
}

const clip = (text: string): string =>
  text.length > OBSERVER_TEXT_MAX
    ? `${text.slice(0, OBSERVER_TEXT_MAX / 4)}\n[truncated]\n${text.slice(OBSERVER_TEXT_MAX / 4 - OBSERVER_TEXT_MAX)}`
    : text

export const observerPrompt = (list: WindowList, turn: ObserverTurn): string =>
  [
    `Current list:\n${describeWindow(list)}`,
    `Agent answer of the previous turn, which this turn's user message may reply to:\n${clip(turn.previousAnswer) || '(none)'}`,
    `User message of this turn:\n${clip(turn.userText) || '(none)'}`,
    `Agent answer of this turn:\n${clip(turn.answer) || '(none)'}`,
    'Return the changes.',
  ].join('\n\n')

const idList = (value: unknown): string[] | null => {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const ids = value.map(entry => (typeof entry === 'string' ? normaliseId(entry) : null))

  return ids.every((id): id is string => id !== null) ? ids : null
}

// The reply as a change, or null when it is not one: then the list is left as it was. A
// fenced reply is accepted, since small models add the fence despite the instruction.
export const parseObserverReply = (text: string): ObserverChange | null => {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const reply = parsed as { done?: unknown; skip?: unknown; add?: unknown }
  const done = idList(reply.done)
  const skip = idList(reply.skip)
  if (done === null || skip === null) return null
  if (reply.add !== undefined && !Array.isArray(reply.add)) return null
  const add: ObserverChange['add'] = []
  for (const entry of (reply.add ?? []) as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null
    const candidate = entry as { kind?: unknown; title?: unknown }
    const kind = typeof candidate.kind === 'string' ? parseKind(candidate.kind) : null
    if (kind === null || typeof candidate.title !== 'string') return null
    add.push({ kind, title: candidate.title })
  }

  return { done, skip, add }
}

// Applies a change: closes first, then moves the skipped items down, then adds. An add whose
// title, whitespace tidied, an open item already carries is dropped, as is one the list
// refuses (empty, too long).
export const applyObserverChange = (list: WindowList, change: ObserverChange): WindowList => {
  let next = skipItems(closeItems(list, change.done).list, change.skip).list
  for (const entry of change.add) {
    const title = clean(entry.title)
    if (openItems(next).some(item => item.title === title)) continue
    const added = addItem(next, entry.kind, entry.title)
    if ('list' in added) next = added.list
  }

  return next
}
