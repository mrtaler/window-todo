import type { CommandRunInput, ModelCompleteResult, On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

// Days to come back on: the window list's `due`, set by /todo and the window tool, drawn in the
// pane and counted on the status line, kept by the sweep, the carry and the observer.
const DAY = 24 * 60 * 60 * 1000
// Noon UTC, so the local day is 2026-11-12 in every zone the tests may run in.
const NOON = Date.UTC(2026, 10, 12, 12)
const WINDOW = 'mcp__window-todo__window' as const
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const setup = (
  on: On,
  entries: Record<string, unknown> = {},
  replies: string[] = [],
): { statuses: Array<string | undefined>; stored: Map<string, unknown>; session: { id: string }; clock: MockClock } => {
  const stored = new Map<string, unknown>(Object.entries(entries))
  const statuses: Array<string | undefined> = []
  const session = { id: 's1' }
  const clock = mock.clock(on, { now: NOON })
  on('store.get', async (_$, e) => ({ value: stored.get(e.key) }))
  on('store.keys', async () => ({ value: [...stored.keys()] }))
  on('store.set', async (_$, e) => {
    stored.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })
  on('store.delete', async (_$, e) => {
    stored.delete(e.key)

    return { value: undefined }
  })
  on('session.id', async () => ({ value: session.id }))
  on('session.end', async (_$, e) => e)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('ui.status', async (_$, e, next) => {
    statuses.push(e.text)

    return next(e)
  })
  on('model.complete', async () => {
    const text = replies.shift()
    const value: ModelCompleteResult =
      text === undefined ? { isAnswered: false, reason: 'empty-reply', usage: USAGE } : { isAnswered: true, text, usage: USAGE }

    return { value }
  })

  return { statuses, stored, session, clock }
}

const todo = (args: string): CommandRunInput => ({
  command: 'todo',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
})

const run = async ($: Engine, args: string): Promise<string> => (await $.command.run(todo(args))).text ?? ''

const call = async ($: Engine, input: Record<string, unknown>): Promise<string> =>
  String((await $.tool.call({ tool: WINDOW, ...input } as Parameters<typeof $.tool.call>[0])).result)

const drawPane = async ($: Engine): Promise<string> =>
  JSON.stringify(
    await $.ui.render({
      surface: 'terminal',
      component: 'Pane',
      requestId: 'todo',
      viewport: { columns: 120, rows: 40 },
      props: { title: 'Plan', isFocused: false, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    }),
  )

const itemsOf = (stored: Map<string, unknown>, key = 'window:s1'): Array<Record<string, unknown>> =>
  ((stored.get(key) as { list: { items: Array<Record<string, unknown>> } } | undefined)?.list.items ?? [])

test('/todo add --on sets the day, the pane shows it and the status line counts the days that have come', async ($, on) => {
  const { statuses, stored } = setup(on)
  expect(await run($, 'add W Answer from DBA --on 11-15')).toBe('Added W1 (wait), come back on 2026-11-15.')
  expect(statuses.at(-1)).toBe('W1')
  expect(await run($, 'add W --on=today Deploy window')).toBe('Added W2 (wait), come back on 2026-11-12.')
  expect(await run($, 'add T Plain task')).toBe('Added T1 (task).')
  expect(statuses.at(-1)).toBe('T1 W2 (1 due)')
  expect(itemsOf(stored).map(item => item.due)).toEqual(['2026-11-15', '2026-11-12', undefined])
  const pane = await drawPane($)
  expect(pane).toContain('Answer from DBA')
  expect(pane).toContain('11-15')
  // The day that has come is drawn yellow; one still ahead is dim.
  expect(pane).toContain('"props":{"color":"yellow","bold":true,"dimColor":false},"children":["11-12"]')
  expect(pane).toContain('"props":{"bold":false,"dimColor":true},"children":["11-15"]')
})

test('/todo add refuses a day it cannot read, and --on without a day', async ($, on) => {
  const { stored } = setup(on)
  expect(await run($, 'add W Answer --on someday')).toContain('is not a date; use YYYY-MM-DD, MM-DD, today, tomorrow or +Nd. Nothing was added.')
  expect(await run($, 'add W Answer --on')).toContain('Usage: /todo')
  expect(stored.has('window:s1')).toBe(false)
})

test('/todo due sets, moves and clears the day of items, and names unknown ids', async ($, on) => {
  const { statuses, stored } = setup(on)
  await run($, 'add W Answer from DBA')
  await run($, 'add Q Which pane?')
  expect(await run($, 'due W1 Q1 tomorrow')).toBe('Come back on 2026-11-13: W1, Q1.')
  expect(await run($, 'due W1, W7 2026-11-01')).toBe('Come back on 2026-11-01: W1. Not in the list: W7.')
  expect(statuses.at(-1)).toBe('Q1 W1 (1 due)')
  expect(await run($, 'due W1 clear')).toBe('Day cleared: W1.')
  expect(itemsOf(stored).map(item => item.due)).toEqual([undefined, '2026-11-13'])
  expect(await run($, 'due W1 never')).toContain('is not a date')
  expect(await run($, 'due W1')).toContain('Usage: /todo')
})

test('the window tool takes a day on add and on op due', async ($, on) => {
  const { stored } = setup(on)
  expect(await call($, { op: 'add', kind: 'W', title: 'CI run', due: 'tomorrow' })).toBe('Added W1.\nW1 [open] CI run (come back on 2026-11-13)')
  expect(await call($, { op: 'due', ids: ['W1'], due: '+3d' })).toBe('Come back on 2026-11-15: W1.\nW1 [open] CI run (come back on 2026-11-15)')
  expect(await call($, { op: 'due', ids: ['W1'], due: 'clear' })).toBe('Day cleared: W1.\nW1 [open] CI run')
  expect(await call($, { op: 'due', ids: ['W1'], due: 'later' })).toMatch(/^Error: "later" is not a date/)
  expect(await call($, { op: 'due', ids: ['W1'] })).toMatch(/^Error: op due needs "due"/)
  expect(itemsOf(stored)[0]?.due).toBe(undefined)
})

test('the sweep keeps an old list while an open item has a day, passed or not', async ($, on) => {
  const old = NOON - 40 * DAY
  const open = (due?: string) => ({ items: [{ id: 'W1', kind: 'W', title: 'Wait', isDone: false, ...(due ? { due } : {}) }], issued: { T: 0, F: 0, Q: 0, W: 1 } })
  const closedWithDay = { items: [{ id: 'W1', kind: 'W', title: 'Wait', isDone: true, due: '2026-12-01' }], issued: { T: 0, F: 0, Q: 0, W: 1 } }
  const { stored } = setup(on, {
    'window:future': { updatedAt: old, list: open('2026-12-01') },
    'window:overdue': { updatedAt: old, list: open('2026-10-01') },
    'window:plain': { updatedAt: old, list: open() },
    'window:closed': { updatedAt: old, list: closedWithDay },
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', isInteractive: false, surface: 'terminal' })
  expect([...stored.keys()].filter(key => key.startsWith('window:') && key !== 'window:s1').sort()).toEqual(['window:future', 'window:overdue'])
})

test('a /clear carries the days along with the open items', async ($, on) => {
  const { session, stored } = setup(on)
  await run($, 'add W Answer from DBA --on 11-20')
  await run($, 'add T Done task')
  await run($, 'done T1')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as Parameters<typeof $.session.end>[0])
  session.id = 's2'
  expect(await run($, 'add T Next')).toBe('Added T2 (task).')
  expect(itemsOf(stored, 'window:s2').map(item => [item.id, item.due])).toEqual([['W1', '2026-11-20'], ['T2', undefined]])
  expect(await drawPane($)).toContain('11-20')
})

test('the observer keeps the days of the items it does not touch and sets none', async ($, on) => {
  const { stored, clock } = setup(on, {}, ['{"done":["T1"],"skip":[],"add":[{"kind":"W","title":"Deploy","due":"2026-11-30"}]}'])
  await run($, 'add W Answer from DBA --on 11-20')
  await run($, 'add T Task')
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ answer: 'done the task', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as Parameters<
    typeof $.turn.complete
  >[0])
  await clock.settle()
  expect(itemsOf(stored).map(item => [item.id, item.isDone, item.due])).toEqual([
    ['W1', false, '2026-11-20'],
    ['T1', true, undefined],
    ['W2', false, undefined],
  ])
})
