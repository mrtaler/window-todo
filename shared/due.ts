// The date a window item is to be come back on: an ISO calendar day, `YYYY-MM-DD`. Days are
// counted on the calendar alone (UTC arithmetic on the day itself), so no time zone shifts them;
// only `localDay` reads the clock's local date.
export type DueState = 'overdue' | 'today' | 'later'

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH_DAY = /^(\d{1,2})-(\d{1,2})$/
const RELATIVE = /^\+(\d{1,4})d$/i
// The furthest a relative date may reach, about ten years.
const MAX_DAYS_AHEAD = 3660

export const DUE_FORMS = 'YYYY-MM-DD, MM-DD, today, tomorrow or +Nd'

const pad = (value: number, size = 2): string => String(value).padStart(size, '0')

const fromParts = (year: number, month: number, day: number): string => `${pad(year, 4)}-${pad(month)}-${pad(day)}`

// Whether `text` is a real calendar day in ISO form (2026-02-30 is not).
export const isIsoDay = (text: unknown): text is string => {
  if (typeof text !== 'string') return false
  const match = ISO_DAY.exec(text)
  if (match === null) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))

  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

// The local calendar day of a clock reading.
export const localDay = (ms: number): string => {
  const date = new Date(ms)

  return fromParts(date.getFullYear(), date.getMonth() + 1, date.getDate())
}

// `day` moved by `days` calendar days.
export const addDays = (day: string, days: number): string => {
  const match = ISO_DAY.exec(day)
  if (match === null) return day
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days))

  return fromParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

// Reads a date as the person or the model writes it: `YYYY-MM-DD`; `MM-DD` (this year, or next
// year when that day has passed); `today`; `tomorrow`; `+Nd` (N days from today). `today` is the
// local day the reading is made on.
export const parseDue = (raw: string, today: string): { due: string } | { error: string } => {
  const text = raw.trim().toLowerCase()
  const refused = { error: `"${raw.trim()}" is not a date; use ${DUE_FORMS}.` }
  if (text === 'today') return { due: today }
  if (text === 'tomorrow') return { due: addDays(today, 1) }
  const relative = RELATIVE.exec(text)
  if (relative !== null) {
    const days = Number(relative[1])

    return days > MAX_DAYS_AHEAD ? refused : { due: addDays(today, days) }
  }
  if (isIsoDay(text)) return { due: text }
  const monthDay = MONTH_DAY.exec(text)
  if (monthDay === null) return refused
  const year = Number(today.slice(0, 4))
  const [month, day] = [Number(monthDay[1]), Number(monthDay[2])]
  // The first such day from today on; 02-29 waits for the next leap year.
  for (let next = year; next <= year + 8; next++) {
    const candidate = fromParts(next, month, day)
    if (isIsoDay(candidate) && candidate >= today) return { due: candidate }
  }

  return refused
}

// Where a due day stands against today.
export const dueState = (due: string, today: string): DueState => (due < today ? 'overdue' : due === today ? 'today' : 'later')

// The colour a due day is drawn in: red when passed, yellow on the day, none before.
export const dueColor = (state: DueState): string | undefined =>
  state === 'overdue' ? 'red' : state === 'today' ? 'yellow' : undefined

// The day as a row shows it: `MM-DD` within today's year, the whole date otherwise.
export const shortDue = (due: string, today: string): string => (due.slice(0, 4) === today.slice(0, 4) ? due.slice(5) : due)

// The earliest of the days given, or undefined for none.
export const earliestDue = (days: ReadonlyArray<string | undefined>): string | undefined =>
  days.reduce<string | undefined>((best, day) => (day !== undefined && (best === undefined || day < best) ? day : best), undefined)
