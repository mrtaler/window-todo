import { addItem, closeItems, describeWindow, normaliseId, openItems, parseKind, skipItems, WINDOW_TITLE_MAX } from './window'
import type { WindowItem, WindowKind, WindowList } from './window'
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
- "add": new open items as {"kind", "title"} objects. A title is one short line, at most ${WINDOW_TITLE_MAX} characters, in the language of the agent's answers. Never add an item the list already holds, nor one that restates an open or done item in other words. A question the agent puts to the user in this turn is a new Q unless the list already holds that same question; asking about the subject of an open task or fix does not restate it. Do not add the step the agent says it takes next in the same work, such as reading a subagent's result, committing after a check or recording the outcome, and add no W for waiting on the agent's own subagent, background task or check.

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

// An add at or above this similarity to an item restates it and is dropped.
export const NEAR_DUPLICATE_MIN = 0.85

// Besides the open items and the ones the change closes, an add is compared with this many done
// items, the last ones in list order.
export const RECENT_DONE_COUNT = 10

// Letter-only words are compared by their first characters, so inflected forms meet.
const STEM_LENGTH = 5

const STOP_WORDS: ReadonlySet<string> = new Set([
  'для', 'что', 'это', 'или', 'как', 'если', 'после', 'перед', 'затем', 'потом', 'при', 'без', 'над', 'под',
  'про', 'его', 'она', 'они', 'там', 'тут', 'уже', 'еще', 'все', 'чтобы', 'нет',
  'the', 'and', 'for', 'with', 'from', 'into', 'after', 'before', 'then', 'that', 'this', 'not', 'but', 'are',
  'was', 'its',
])

const hasDigit = (word: string): boolean => /\p{N}/u.test(word)

// The words of a title: lower-cased, ё read as е, punctuation trimmed from both ends of each.
const titleWords = (title: string): string[] =>
  clean(title)
    .toLowerCase()
    .replaceAll('ё', 'е')
    .split(' ')
    .map(word => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(word => word !== '')

// The words two titles are compared by: every word with a digit as it is, and the other words of
// three or more characters that are not stop words, letter-only ones cut to their stem.
const comparedWords = (words: readonly string[]): Set<string> => {
  const compared = new Set<string>()
  for (const word of words) {
    if (hasDigit(word)) compared.add(word)
    else if (word.length >= 3 && !STOP_WORDS.has(word)) compared.add(/^\p{L}+$/u.test(word) ? word.slice(0, STEM_LENGTH) : word)
  }

  return compared
}

// Dice similarity of two titles, from 0 to 1. Titles that each carry a word with a digit the other
// lacks (another version, hash or number) name different things and score 0.
export const titleSimilarity = (left: string, right: string): number => {
  const leftWords = titleWords(left)
  const rightWords = titleWords(right)
  const leftIdentifiers = new Set(leftWords.filter(hasDigit))
  const rightIdentifiers = new Set(rightWords.filter(hasDigit))
  const leftHasOwn = [...leftIdentifiers].some(word => !rightIdentifiers.has(word))
  const rightHasOwn = [...rightIdentifiers].some(word => !leftIdentifiers.has(word))
  if (leftHasOwn && rightHasOwn) return 0
  const leftCompared = comparedWords(leftWords)
  const rightCompared = comparedWords(rightWords)
  if (leftCompared.size === 0 || rightCompared.size === 0) return 0
  const shared = [...leftCompared].filter(word => rightCompared.has(word)).length

  return (2 * shared) / (leftCompared.size + rightCompared.size)
}

// The items an add must not restate: the open ones, the ones closed by this change and the last
// RECENT_DONE_COUNT done ones.
const itemsToCompare = (list: WindowList, closedNow: ReadonlySet<string>): WindowItem[] => {
  const recentDone = new Set(list.items.filter(item => item.isDone).slice(-RECENT_DONE_COUNT).map(item => item.id))

  return list.items.filter(item => !item.isDone || recentDone.has(item.id) || closedNow.has(item.id))
}

// Applies a change: closes first, then moves the skipped items down, then adds. An add is dropped
// when an open item already carries its title, whitespace tidied, or when it restates an item
// itemsToCompare names; so is one the list refuses (empty, too long).
export const applyObserverChange = (list: WindowList, change: ObserverChange): WindowList => {
  const closed = closeItems(list, change.done)
  const closedNow = new Set(closed.changed)
  let next = skipItems(closed.list, change.skip).list
  for (const entry of change.add) {
    const title = clean(entry.title)
    if (openItems(next).some(item => item.title === title)) continue
    if (itemsToCompare(next, closedNow).some(item => titleSimilarity(item.title, title) >= NEAR_DUPLICATE_MIN)) continue
    const added = addItem(next, entry.kind, entry.title)
    if ('list' in added) next = added.list
  }

  return next
}
