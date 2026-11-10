import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import { INBOX_POLL_MS, MIRROR_INTERVAL_MS, sha256Hex } from './mirror'

const WINDOW = 'mcp__window-todo__window' as const
const PLAN = 'mcp__window-todo__plan' as const
const DIR = '/state/window-todo'
const PANE_ENV = { WINDOW_TODO_PANE: '1', WINDOW_TODO_STATE_DIR: `${DIR}/`, WINDOW_TODO_PANEL_BINDING: 'token' }

type Files = Map<string, string>

// The world beneath the mod for the file mirror: a clock, a store, the environment the launcher
// sets, a session id, and a file system in memory that records every write.
const setup = (
  on: On,
  env: Record<string, string> = PANE_ENV,
  files: Files = new Map(),
): { clock: MockClock; files: Files; writes: string[]; logs: string[]; session: { id: string } } => {
  const session = { id: 's1' }
  const writes: string[] = []
  const logs: string[] = []
  const clock = mock.clock(on, { now: 1000 })
  mock.store(on)
  mock.env(on, env)
  on('session.id', async () => ({ value: session.id }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('command.register', async () => ({ value: { command: 'todo' } }))
  on('ui.status', async () => ({ value: undefined }))
  on('prompt.submit', async (_$, e) => ({ text: e.text, context: e.context }))
  on('ui.log', async (_$, e, next) => {
    logs.push(e.text)

    return next(e)
  })
  on('fs.write', async (_$, e) => {
    files.set(e.path, e.text)
    writes.push(e.path)

    return { value: undefined }
  })
  on('fs.exists', async (_$, e) => ({ value: files.has(e.path) }))
  on('fs.read', async (_$, e) => {
    const text = files.get(e.path)

    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })

  return { clock, files, writes, logs, session }
}

const stateOf = async (files: Files, sessionId = 's1'): Promise<Record<string, any>> => {
  const text = files.get(`${DIR}/${await sha256Hex(sessionId)}.json`)
  if (text === undefined) throw new Error('no state file')

  return JSON.parse(text) as Record<string, any>
}

const putInbox = async (files: Files, entries: unknown[], sessionId = 's1'): Promise<void> => {
  files.set(`${DIR}/${await sha256Hex(sessionId)}.inbox.json`, JSON.stringify({ version: 1, sessionId, entries }))
}

const call = async ($: Engine, tool: typeof WINDOW | typeof PLAN, input: Record<string, unknown>): Promise<string> =>
  String((await $.tool.call({ tool, ...input } as Parameters<typeof $.tool.call>[0])).result)

const turnStart = ($: Engine, turnId: string): ReturnType<Engine['turn']['start']> => $.turn.start({ text: 'go', turnId })

// The end of a turn, which writes the state file at once.
const turnComplete = async ($: Engine, turnId: string): Promise<void> => {
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId, reason: 'answer' } as Parameters<
    typeof $.turn.complete
  >[0])
}

// The window list in the state file, as `<id>:<open|done>` in list order.
const listed = async (files: Files, sessionId = 's1'): Promise<string[]> =>
  (await stateOf(files, sessionId)).window.items.map((item: { id: string; isDone: boolean }) => `${item.id}:${item.isDone ? 'done' : 'open'}`)

test('the session hash matches the name codex/state.cjs gives the file', async () => {
  // node -e "console.log(require('crypto').createHash('sha256').update('s1').digest('hex'))"
  expect(await sha256Hex('s1')).toBe('e8bc163c82eee18733288c7d4ac636db3a6deb013ef2d37b68322be20edc45cc')
  expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('with the pane on, the plan and the window list land in the Codex-format state file', async ($, on) => {
  const { files, logs } = setup(on)
  await call($, PLAN, { op: 'set', title: 'Ship it', nodes: [{ title: 'Build' }] })
  await call($, WINDOW, { op: 'add', kind: 'Q', title: 'Which colour?' })
  await turnComplete($, 't1')
  const state = await stateOf(files)
  expect(state).toMatchObject({ version: 1, sessionId: 's1', client: 'claude', inbox: { applied: 0 } })
  expect(state.plan.title).toBe('Ship it')
  expect(state.plan.nodes.map((node: { title: string }) => node.title)).toEqual(['Build'])
  expect(state.window.items).toEqual([{ id: 'Q1', kind: 'Q', title: 'Which colour?', isDone: false }])
  expect(typeof state.updatedAt).toBe('number')
  // The pane binding names the session, so a pane started on the launcher's token follows it.
  expect(JSON.parse(files.get(`${DIR}/binding-${await sha256Hex('token')}.json`) ?? '{}')).toEqual({ sessionId: 's1', closed: false })
  expect(logs).toEqual([])
})

test('a burst of changes inside the interval is written once at its end', async ($, on) => {
  const { clock, files, writes } = setup(on)
  const stateFile = `${DIR}/${await sha256Hex('s1')}.json`
  await call($, WINDOW, { op: 'add', kind: 'T', title: 'One' })
  await call($, WINDOW, { op: 'add', kind: 'T', title: 'Two' })
  await call($, WINDOW, { op: 'add', kind: 'T', title: 'Three' })
  // The first call's start wrote at once (the list still empty); the adds after it wait.
  expect(writes.filter(written => written === stateFile).length).toBe(1)
  expect(await listed(files)).toEqual([])
  await clock.advance(MIRROR_INTERVAL_MS)
  expect(writes.filter(written => written === stateFile).length).toBe(2)
  expect(await listed(files)).toEqual(['T1:open', 'T2:open', 'T3:open'])
})

test('without WINDOW_TODO_PANE nothing is written', async ($, on) => {
  const { writes } = setup(on, { WINDOW_TODO_STATE_DIR: DIR })
  await call($, WINDOW, { op: 'add', kind: 'T', title: 'One' })
  await turnStart($, 't1')
  expect(writes).toEqual([])
})

test('a turn start applies the inbox once and reports the applied number', async ($, on) => {
  const { files } = setup(on)
  await call($, WINDOW, { op: 'add', kind: 'T', title: 'One' })
  await call($, WINDOW, { op: 'add', kind: 'T', title: 'Two' })
  await putInbox(files, [
    { seq: 1, op: 'done', ids: ['T1'], at: 1 },
    { seq: 2, op: 'skip', ids: ['T2'], at: 2 },
  ])
  await turnStart($, 't1')
  await turnComplete($, 't1')
  expect(await listed(files)).toEqual(['T1:done', 'T2:open'])
  expect((await stateOf(files)).inbox).toEqual({ applied: 2 })
  // The same entries are not applied again: T3 added afterwards stays below T2.
  await call($, WINDOW, { op: 'add', kind: 'T', title: 'Three' })
  await turnStart($, 't2')
  await turnComplete($, 't2')
  expect(await listed(files)).toEqual(['T1:done', 'T2:open', 'T3:open'])
})

test('the applied number is read back from the state file, so a restart does not apply twice', async ($, on) => {
  const files: Files = new Map()
  files.set(
    `${DIR}/${await sha256Hex('s1')}.json`,
    JSON.stringify({ version: 1, sessionId: 's1', client: 'claude', plan: {}, window: {}, activity: {}, inbox: { applied: 1 } }),
  )
  setup(on, PANE_ENV, files)
  await call($, WINDOW, { op: 'add', kind: 'T', title: 'One' })
  await call($, WINDOW, { op: 'add', kind: 'T', title: 'Two' })
  await putInbox(files, [
    { seq: 1, op: 'skip', ids: ['T1'], at: 1 },
    { seq: 2, op: 'done', ids: ['T2'], at: 2 },
  ])
  await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
  await turnComplete($, 't1')
  expect(await listed(files)).toEqual(['T1:open', 'T2:done'])
  expect((await stateOf(files)).inbox).toEqual({ applied: 2 })
})

test('between turns the inbox is polled, and the pane inside Claude does not open unasked', async ($, on) => {
  const { clock, files } = setup(on)
  const opened: string[] = []
  on('ui.open', async (_$, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true as const } }
  })
  await $.session.start({ cwd: '/tmp', isInteractive: true, surface: 'terminal' })
  expect(opened).toEqual([])
  await call($, WINDOW, { op: 'add', kind: 'F', title: 'Fix it' })
  await putInbox(files, [{ seq: 1, op: 'done', ids: ['F1'], at: 1 }])
  await clock.advance(INBOX_POLL_MS)
  await clock.advance(MIRROR_INTERVAL_MS)
  const state = await stateOf(files)
  expect(state.window.items).toEqual([{ id: 'F1', kind: 'F', title: 'Fix it', isDone: true }])
  expect(state.inbox).toEqual({ applied: 1 })
})

test('after a /clear the poll moves the state file and the pane binding to the new session', async ($, on) => {
  const { clock, files, session, logs } = setup(on)
  on('session.end', async (_$, e) => e)
  await $.session.start({ cwd: '/tmp', isInteractive: false, surface: 'terminal' })
  await call($, WINDOW, { op: 'add', kind: 'T', title: 'Before clear' })
  // Past the interval, so the clear's own redraw writes at once, still under the old session.
  await clock.advance(MIRROR_INTERVAL_MS * 3)
  await $.session.end({ reason: 'clear', sessionId: 's1' } as Parameters<typeof $.session.end>[0])
  session.id = 's2'
  await clock.advance(INBOX_POLL_MS)
  await clock.advance(MIRROR_INTERVAL_MS)
  expect(JSON.parse(files.get(`${DIR}/binding-${await sha256Hex('token')}.json`) ?? '{}')).toEqual({ sessionId: 's2', closed: false })
  expect(await listed(files, 's2')).toEqual([])
  expect(await listed(files, 's1')).toEqual(['T1:open'])
  expect(logs.filter(text => text.includes('mirror'))).toEqual([])
})

