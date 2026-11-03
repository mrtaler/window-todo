import type { WindowItem, WindowKind, WindowList } from '../types'
import { clean } from './sanitize'
import type { Seg, TreeLine } from './tree'

export type { WindowItem, WindowKind, WindowList }

export const WINDOW_KINDS: readonly WindowKind[] = ['T', 'F', 'Q', 'W']
export const WINDOW_TITLE_MAX = 120
export const WINDOW_HEADER = 'Window'

// What each kind stands for, in the words the model and the person see.
export const KIND_NAMES: Readonly<Record<WindowKind, string>> = {
  T: 'task',
  F: 'finding',
  Q: 'question',
  W: 'wait',
}

export type WindowResult = { list: WindowList; changed: string[]; unknown: string[] }

export const emptyWindow = (): WindowList => ({ items: [], issued: { T: 0, F: 0, Q: 0, W: 0 } })

const isKind = (value: string): value is WindowKind => (WINDOW_KINDS as readonly string[]).includes(value)

// Accepts `f1`, `F1` and ` F1 `; anything else is not an id.
export const normaliseId = (raw: string): string | null => {
  const match = /^([tfqw])(\d+)$/i.exec(raw.trim())
  if (match === null) return null

  return `${(match[1] ?? '').toUpperCase()}${Number(match[2])}`
}

export const parseKind = (raw: string): WindowKind | null => {
  const upper = raw.trim().toUpperCase()

  return isKind(upper) ? upper : null
}

// Adds one open item at the end with the next number of its kind. The number comes from
// `issued`, never from the items present, so an id is never handed out twice.
export const addItem = (
  list: WindowList,
  kind: WindowKind,
  rawTitle: string,
): { list: WindowList; id: string } | { error: string } => {
  const title = clean(rawTitle)
  if (title === '') return { error: 'The title is empty.' }
  if (title.length > WINDOW_TITLE_MAX) return { error: `The title is longer than ${WINDOW_TITLE_MAX} characters.` }
  const number = list.issued[kind] + 1
  const id = `${kind}${number}`
  const item: WindowItem = { id, kind, title, isDone: false }

  return { list: { items: [...list.items, item], issued: { ...list.issued, [kind]: number } }, id }
}

// Splits the requested ids into those that name an item and those that do not.
const resolveIds = (list: WindowList, rawIds: readonly string[]): { known: Set<string>; unknown: string[] } => {
  const present = new Set(list.items.map(item => item.id))
  const known = new Set<string>()
  const unknown: string[] = []
  for (const raw of rawIds) {
    const id = normaliseId(raw)
    if (id !== null && present.has(id)) known.add(id)
    else unknown.push(raw.trim())
  }

  return { known, unknown }
}

// Marks items done. A done item stays in the list, drawn struck through, keeping its id.
export const closeItems = (list: WindowList, rawIds: readonly string[]): WindowResult => {
  const { known, unknown } = resolveIds(list, rawIds)
  const changed = list.items.filter(item => known.has(item.id) && !item.isDone).map(item => item.id)
  const items = list.items.map(item => (known.has(item.id) ? { ...item, isDone: true } : item))

  return { list: { ...list, items }, changed, unknown }
}

// «F1 can wait»: the item moves to the bottom of the list with the same id and stays open.
export const skipItems = (list: WindowList, rawIds: readonly string[]): WindowResult => {
  const { known, unknown } = resolveIds(list, rawIds)
  const moved = list.items.filter(item => known.has(item.id)).map(item => ({ ...item, isDone: false }))
  const rest = list.items.filter(item => !known.has(item.id))

  return { list: { ...list, items: [...rest, ...moved] }, changed: moved.map(item => item.id), unknown }
}

export const openItems = (list: WindowList): WindowItem[] => list.items.filter(item => !item.isDone)

export const hasOpenQuestion = (list: WindowList): boolean => openItems(list).some(item => item.kind === 'Q')

// Open items in list order, then the done ones, so a skipped item reads as the last open one.
export const displayOrder = (list: WindowList): WindowItem[] => [
  ...openItems(list),
  ...list.items.filter(item => item.isDone),
]

const seg = (text: string, over: Partial<Seg> = {}): Seg => ({ text, bold: false, dim: false, ...over })
const lineOf = (segments: Seg[]): TreeLine => ({ text: segments.map(s => s.text).join(''), segments })

const shorten = (text: string, max: number): string => {
  if (text.length <= max) return text

  return max <= 1 ? '…' : `${text.slice(0, max - 1)}…`
}

// The pane section: a header, then one row per item. Nothing at all for an empty list, so a
// window that never used the list keeps the pane as the plan alone.
export const windowLines = (list: WindowList, width: number, accent: string): TreeLine[] => {
  if (list.items.length === 0) return []
  const rows = displayOrder(list).map(item => {
    const mark = item.isDone ? '✓' : '○'
    const prefix = `${mark} ${item.id} `
    const title = shorten(item.title, Math.max(1, width - prefix.length))

    return item.isDone
      ? lineOf([seg(prefix, { dim: true }), seg(title, { dim: true, strikethrough: true })])
      : lineOf([seg(`${mark} `), seg(item.id, { color: accent, bold: true }), seg(` ${title}`)])
  })

  return [lineOf([seg(WINDOW_HEADER, { bold: true })]), ...rows]
}

// Rows the section takes in the pane: a blank separator, the header and one per item.
export const windowRowCount = (list: WindowList): number => (list.items.length === 0 ? 0 : list.items.length + 2)

// The status line part: open items per kind, for example `T2 F1 Q1`; undefined when none is open.
export const windowStatus = (list: WindowList): string | undefined => {
  const open = openItems(list)
  const parts = WINDOW_KINDS.flatMap(kind => {
    const count = open.filter(item => item.kind === kind).length

    return count === 0 ? [] : [`${kind}${count}`]
  })

  return parts.length === 0 ? undefined : parts.join(' ')
}

// The list as the model reads it: one line per item, open first.
export const describeWindow = (list: WindowList): string => {
  if (list.items.length === 0) return 'The window list is empty.'

  return displayOrder(list)
    .map(item => `${item.id} [${item.isDone ? 'done' : 'open'}] ${item.title}`)
    .join('\n')
}

// A stored value is used only when it has the list's shape; anything else counts as no list.
export const parseStoredWindow = (value: unknown): WindowList | null => {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as { items?: unknown; issued?: unknown }
  if (!Array.isArray(candidate.items) || typeof candidate.issued !== 'object' || candidate.issued === null) return null
  const issued = candidate.issued as Record<string, unknown>
  if (!WINDOW_KINDS.every(kind => Number.isInteger(issued[kind]) && Number(issued[kind]) >= 0)) return null
  const items: WindowItem[] = []
  for (const raw of candidate.items) {
    if (typeof raw !== 'object' || raw === null) return null
    const entry = raw as Record<string, unknown>
    const kind = typeof entry.kind === 'string' ? parseKind(entry.kind) : null
    const id = typeof entry.id === 'string' ? normaliseId(entry.id) : null
    if (kind === null || id === null || typeof entry.title !== 'string' || typeof entry.isDone !== 'boolean') return null
    items.push({ id, kind, title: entry.title, isDone: entry.isDone })
  }

  return {
    items,
    issued: { T: Number(issued.T), F: Number(issued.F), Q: Number(issued.Q), W: Number(issued.W) },
  }
}
