import type { CommandRunInput, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

// The world beneath the mod for the window list: a clock, a store in memory, a session id the
// test can switch (as /resume does), and recorders for the log and the status line.
const setup = (
  on: On,
  entries: Record<string, unknown> = {},
  now = 0,
): { logs: string[]; statuses: Array<string | undefined>; session: { id: string } } => {
  const logs: string[] = []
  const statuses: Array<string | undefined> = []
  const session = { id: 's1' }
  mock.clock(on, { now })
  mock.store(on, entries)
  on('session.id', async () => ({ value: session.id }))
  on('ui.log', async (_$, e, next) => {
    logs.push(e.text)

    return next(e)
  })
  on('ui.status', async (_$, e, next) => {
    statuses.push(e.text)

    return next(e)
  })

  return { logs, statuses, session }
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
  expect(await run($, 'add f Upload bypasses the toggle')).toBe('Added F1 (finding).')
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
  expect(await run($, 'add F Next')).toBe('Added F4 (finding).')
  // A swept session resumes with an empty list; a fresh one keeps its counters.
  for (const [id, expected] of [['old', 'Added F1 (finding).'], ['fresh', 'Added F4 (finding).']] as const) {
    await resume($, session.id)
    session.id = id
    expect(await run($, 'add F Next')).toBe(expected)
  }
})

test('the pane keeps the plan alone while the window list is empty', async ($, on) => {
  setup(on)
  expect(await drawPane($)).not.toContain('Window')
})
