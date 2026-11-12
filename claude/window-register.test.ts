import type { CommandRunInput, On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import { CARRY_MAX_AGE_MS } from './window-store'

// The world beneath the mod for the window list: a clock, a store in memory, a session id the
// test can switch (as /resume and /clear do), and recorders for the log, the status line and toasts.
const setup = (
  on: On,
  entries: Record<string, unknown> = {},
  now = 0,
): {
  logs: string[]
  statuses: Array<string | undefined>
  toasts: string[]
  session: { id: string }
  clock: MockClock
  stored: Map<string, unknown>
} => {
  const logs: string[] = []
  // The store in memory, kept here (not by mock.store) so a test can read what it holds.
  const stored = new Map<string, unknown>(Object.entries(entries))
  const statuses: Array<string | undefined> = []
  const toasts: string[] = []
  const session = { id: 's1' }
  const clock = mock.clock(on, { now })
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
  on('ui.toast', async (_$, e, next) => {
    toasts.push(e.text)

    return next(e)
  })
  on('session.id', async () => ({ value: session.id }))
  on('ui.log', async (_$, e, next) => {
    logs.push(e.text)

    return next(e)
  })
  on('ui.status', async (_$, e, next) => {
    statuses.push(e.text)

    return next(e)
  })

  return { logs, statuses, toasts, session, clock, stored }
}

const todo = (args: string): CommandRunInput => ({
  command: 'todo',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
})

// Ends the session as /resume does; the engine beneath answers with the event itself.
const resume = async ($: Engine, from: string): Promise<void> => {
  await $.session.end({ reason: 'resume', sessionId: from, resume: { id: from } } as Parameters<typeof $.session.end>[0])
}

// Ends the session as /clear does; the process goes on under `next`, and no session.start follows.
const clear = async ($: Engine, session: { id: string }, next: string): Promise<void> => {
  await $.session.end({ reason: 'clear', sessionId: session.id, resume: { id: session.id } } as Parameters<typeof $.session.end>[0])
  session.id = next
}

const run = async ($: Engine, args: string): Promise<string> => (await $.command.run(todo(args))).text ?? ''

const drawPane = async ($: Engine): Promise<string> =>
  JSON.stringify(
    await $.ui.render({
      surface: 'terminal',
      component: 'Pane',
      requestId: 'todo',
      viewport: { columns: 120, rows: 40 },
      props: {
        title: 'Plan',
        isFocused: false,
        bodyColumns: 60,
        placement: 'inline',
        scroll: { offset: 0, bodyRows: 20 },
        view: {},
      },
    }),
  )

test('/todo add hands out ids per kind and the status line counts open items', async ($, on) => {
  const { logs, statuses } = setup(on)
  expect(await run($, 'add T Write the store')).toBe('Added T1 (task).')
  expect(await run($, 'add f Upload bypasses the toggle')).toBe('Added F1 (fix).')
  expect(await run($, 'add T Wire the observer')).toBe('Added T2 (task).')
  expect(statuses.at(-1)).toBe('T2 F1')
  expect(logs).toEqual([])
})

test('/todo add refuses an unknown kind or an empty title', async ($, on) => {
  setup(on)
  expect(await run($, 'add X something')).toContain('Usage: /todo')
  expect(await run($, 'add Q')).toBe('The title is empty. Nothing was added.')
})

test('/todo done closes, /todo skip moves down with the same id, unknown ids are named', async ($, on) => {
  const { statuses } = setup(on)
  await run($, 'add F First')
  await run($, 'add T Task')
  await run($, 'add F Second')
  expect(await run($, 'skip f1')).toBe('Moved down: F1.')
  expect(await run($, 'done T1, T7')).toBe('Closed: T1. Not in the list: T7.')
  expect(statuses.at(-1)).toBe('F2')
  const pane = await drawPane($)
  expect(pane.indexOf('Second')).toBeLessThan(pane.indexOf('First'))
  expect(pane).toContain('Window')
})

test('/todo prune removes the closed items and a removed id is not reused', async ($, on) => {
  const { statuses } = setup(on)
  await run($, 'add W CI')
  await run($, 'add F Bug')
  await run($, 'done W1')
  expect(await run($, 'prune')).toBe('Removed: W1.')
  expect(statuses.at(-1)).toBe('F1')
  expect(await drawPane($)).not.toContain('CI')
  expect(await run($, 'add W Review')).toBe('Added W2 (wait).')
})

test('a closed id is not reused by a later add', async ($, on) => {
  setup(on)
  await run($, 'add W CI')
  await run($, 'done W1')
  expect(await run($, 'add W Review')).toBe('Added W2 (wait).')
})

test('the list is kept per session and comes back when that session is resumed', async ($, on) => {
  const { session } = setup(on)
  on('session.end', async (_$, e) => e)
  await run($, 'add Q Pane or section?')
  await resume($, 's1')
  session.id = 's2'
  // Before the new session's first use the pane shows no list rather than the one just left.
  expect(await drawPane($)).not.toContain('Pane or section?')
  expect(await run($, 'add T Other window')).toBe('Added T1 (task).')
  expect(await drawPane($)).not.toContain('Pane or section?')
  await resume($, 's2')
  session.id = 's1'
  expect(await run($, 'add Q Next question')).toBe('Added Q2 (question).')
  const pane = await drawPane($)
  expect(pane).toContain('Pane or section?')
  expect(pane).not.toContain('Other window')
})

test('session.start loads the stored list of the session and drops other stale ones', async ($, on) => {
  const day = 24 * 60 * 60 * 1000
  const list = { items: [{ id: 'F3', kind: 'F', title: 'Kept finding', isDone: false }], issued: { T: 0, F: 3, Q: 0, W: 0 } }
  const entries: Record<string, unknown> = {
    'window:s1': { updatedAt: 0, list },
    'window:old': { updatedAt: 0, list },
    'window:fresh': { updatedAt: 40 * day, list },
  }
  const { session } = setup(on, entries, 41 * day)
  on('session.end', async (_$, e) => e)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', isInteractive: false, surface: 'terminal' })
  expect(await drawPane($)).toContain('Kept finding')
  expect(await run($, 'add F Next')).toBe('Added F4 (fix).')
  // A swept session resumes with an empty list; a fresh one keeps its counters.
  for (const [id, expected] of [['old', 'Added F1 (fix).'], ['fresh', 'Added F4 (fix).']] as const) {
    await resume($, session.id)
    session.id = id
    expect(await run($, 'add F Next')).toBe(expected)
  }
})

test('the pane keeps the plan alone while the window list is empty', async ($, on) => {
  setup(on)
  expect(await drawPane($)).not.toContain('Window')
})

// Three open items and a closed one in s1, then a /clear to s2.
const clearWithItems = async ($: Engine, session: { id: string }): Promise<void> => {
  await run($, 'add T Kept task')
  await run($, 'add F Kept fix')
  await run($, 'add T Done task')
  await run($, 'add Q Kept question')
  await run($, 'done T2')
  await clear($, session, 's2')
}

test('/clear carries the open items to the new session with their ids; the closed ones stay behind', async ($, on) => {
  const { session, toasts, statuses, stored } = setup(on)
  on('session.end', async (_$, e) => e)
  await clearWithItems($, session)
  const before = stored.get('window:s1')
  // The ids and counters come over, so the next add continues the numbering.
  expect(await run($, 'add T Next task')).toBe('Added T3 (task).')
  expect(await run($, 'add F Next fix')).toBe('Added F2 (fix).')
  const pane = await drawPane($)
  for (const title of ['Kept task', 'Kept fix', 'Kept question', 'Next task']) expect(pane).toContain(title)
  expect(pane).not.toContain('Done task')
  expect(statuses.at(-1)).toBe('T2 F2 Q1')
  expect(toasts).toEqual(['Window list: 3 open items carried over from the cleared session.'])
  // The cleared session's own list is left as it was, its closed item included.
  expect(stored.get('window:s1')).toEqual(before)
  expect(JSON.stringify(before)).toContain('Done task')
  expect([...stored.keys()].filter(key => key.startsWith('carry:'))).toEqual([])
  // A /resume of the cleared session finds its list as it was.
  await resume($, 's2')
  session.id = 's1'
  expect(await run($, 'done T9')).toBe('Not in the list: T9.')
  const resumed = await drawPane($)
  expect(resumed).toContain('Done task')
  expect(resumed).not.toContain('Next task')
})

test('a carried list carries on through a second /clear', async ($, on) => {
  const { session } = setup(on)
  on('session.end', async (_$, e) => e)
  await clearWithItems($, session)
  await run($, 'done F1')
  await clear($, session, 's3')
  expect(await run($, 'add F Third fix')).toBe('Added F2 (fix).')
  const pane = await drawPane($)
  expect(pane).toContain('Kept task')
  expect(pane).not.toContain('Kept fix')
})

test('/clear with nothing open carries nothing', async ($, on) => {
  const { session, toasts } = setup(on)
  on('session.end', async (_$, e) => e)
  await run($, 'add T Only task')
  await run($, 'done T1')
  await clear($, session, 's2')
  expect(await run($, 'add T Fresh')).toBe('Added T1 (task).')
  expect(await drawPane($)).not.toContain('Only task')
  expect(toasts).toEqual([])
})

test('a /resume does not take the carry a /clear left', async ($, on) => {
  const { session, toasts } = setup(on)
  on('session.end', async (_$, e) => e)
  await clearWithItems($, session)
  // s2 is left by /resume before its first use, into a session with no list of its own.
  await resume($, 's2')
  session.id = 's9'
  expect(await run($, 'add T Other')).toBe('Added T1 (task).')
  expect(await drawPane($)).not.toContain('Kept task')
  expect(toasts).toEqual([])
})

test('a carry older than the limit is not taken', async ($, on) => {
  const { session, clock, toasts } = setup(on)
  on('session.end', async (_$, e) => e)
  await clearWithItems($, session)
  await clock.advance(CARRY_MAX_AGE_MS + 1)
  expect(await run($, 'add T Late')).toBe('Added T1 (task).')
  expect(await drawPane($)).not.toContain('Kept task')
  expect(toasts).toEqual([])
})

test('two first uses at once take the carry once', async ($, on) => {
  const { session, toasts } = setup(on)
  on('session.end', async (_$, e) => e)
  await clearWithItems($, session)
  const replies = await Promise.all([run($, 'add T One'), run($, 'add F Two'), run($, 'add W Three')])
  expect(replies).toEqual(['Added T3 (task).', 'Added F2 (fix).', 'Added W1 (wait).'])
  const pane = await drawPane($)
  for (const title of ['Kept task', 'One', 'Two', 'Three']) expect(pane).toContain(title)
  expect(toasts).toHaveLength(1)
})

test('a new session that already has a list keeps it', async ($, on) => {
  const own = { items: [{ id: 'W4', kind: 'W', title: 'Own wait', isDone: false }], issued: { T: 0, F: 0, Q: 0, W: 4 } }
  const { session, toasts } = setup(on, { 'window:s2': { updatedAt: 0, list: own } })
  on('session.end', async (_$, e) => e)
  await clearWithItems($, session)
  expect(await run($, 'add T Next')).toBe('Added T1 (task).')
  const pane = await drawPane($)
  expect(pane).toContain('Own wait')
  expect(pane).not.toContain('Kept task')
  expect(toasts).toEqual([])
})

test("another process's carry is never taken, and a stale one is swept at session start", async ($, on) => {
  const day = 24 * 60 * 60 * 1000
  const list = { items: [{ id: 'T5', kind: 'T', title: 'Foreign task', isDone: false }], issued: { T: 5, F: 0, Q: 0, W: 0 } }
  const entries: Record<string, unknown> = {
    'carry:window:other-fresh': { from: 'x1', at: 10 * day, list },
    'carry:window:other-stale': { from: 'x2', at: 0, list },
  }
  const { stored } = setup(on, entries, 10 * day)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', isInteractive: false, surface: 'terminal' })
  expect(await run($, 'add T Mine')).toBe('Added T1 (task).')
  expect(await drawPane($)).not.toContain('Foreign task')
  expect(stored.has('carry:window:other-fresh')).toBe(true)
  expect(stored.has('carry:window:other-stale')).toBe(false)
})

test('two first uses of a session at once load it once and keep both changes', async ($, on) => {
  setup(on)
  const replies = await Promise.all([run($, 'add T One'), run($, 'add F Two'), run($, 'add W Three')])
  expect(replies).toEqual(['Added T1 (task).', 'Added F1 (fix).', 'Added W1 (wait).'])
  const pane = await drawPane($)
  for (const title of ['One', 'Two', 'Three']) expect(pane).toContain(title)
})

