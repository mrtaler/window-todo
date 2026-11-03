import type { CommandRunInput, ModelCompleteResult, On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

type Completion = { model: string; system?: string; prompt: string; effort?: string; maxTokens?: number }

// The world beneath the mod for the observer: a clock to settle the scheduled run, a store, a
// session id, a log recorder and a model that answers with whatever the test queues.
const setup = (
  on: On,
  replies: string[],
): { clock: MockClock; logs: string[]; calls: Completion[]; session: { id: string } } => {
  const logs: string[] = []
  const calls: Completion[] = []
  const session = { id: 's1' }
  const clock = mock.clock(on)
  mock.store(on)
  on('session.id', async () => ({ value: session.id }))
  on('session.end', async (_$, e) => e)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('ui.log', async (_$, e, next) => {
    logs.push(e.text)

    return next(e)
  })
  on('model.complete', async (_$, e) => {
    calls.push({ model: e.model, system: e.system, prompt: e.prompt, effort: e.effort, maxTokens: e.maxTokens })
    const text = replies.shift()

    const value: ModelCompleteResult =
      text === undefined ? { isAnswered: false, reason: 'empty-reply', usage: USAGE } : { isAnswered: true, text, usage: USAGE }

    return { value }
  })

  return { clock, logs, calls, session }
}

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const todo = (args: string): CommandRunInput => ({
  command: 'todo',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
})

const run = async ($: Engine, args: string): Promise<string> => (await $.command.run(todo(args))).text ?? ''

// One answered main-loop turn, then the scheduled observer run.
const turn = async ($: Engine, clock: MockClock, turnId: string, text: string, answer: string): Promise<void> => {
  await $.turn.start({ text, turnId })
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId, reason: 'answer' } as Parameters<
    typeof $.turn.complete
  >[0])
  await clock.settle()
}

// The pane as JSON, to read the order of the window rows.
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

test('after an answered turn haiku reads the turn and its additions land with new ids', async ($, on) => {
  const { clock, calls, logs } = setup(on, ['{"done":[],"skip":[],"add":[{"kind":"F","title":"Upload bypasses the toggle"}]}'])
  await turn($, clock, 't1', 'look at the upload', 'Found: the upload bypasses the toggle.')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.model).toBe('haiku')
  expect(calls[0]?.effort).toBe('medium')
  expect(calls[0]?.maxTokens).toBe(8192)
  expect(calls[0]?.prompt).toContain('User message of this turn:\nlook at the upload')
  expect(await run($, 'done F1')).toBe('Closed: F1.')
  expect(logs).toEqual([])
})

test('«F1 can wait» in the next turn moves F1 down with the same id', async ($, on) => {
  const { clock } = setup(on, ['{"skip":["F1"]}'])
  await run($, 'add F First')
  await run($, 'add T Task')
  await turn($, clock, 't1', 'F1 can wait', 'OK, F1 is skipped.')
  const pane = await drawPane($)
  expect(pane.indexOf('Task')).toBeLessThan(pane.indexOf('First'))
  expect(pane).toContain('F1')
})

test('the observer sees the previous answer, so a reply to a question can close it', async ($, on) => {
  const { clock, calls } = setup(on, ['{}', '{"done":["Q1"]}'])
  await run($, 'add Q Pane or section?')
  await turn($, clock, 't1', 'go', 'Pane or section?')
  await turn($, clock, 't2', 'section', 'Done.')
  expect(calls[1]?.prompt).toContain('previous turn, which this turn\'s user message may reply to:\nPane or section?')
  expect(await run($, 'done Q1')).toBe('Nothing was changed.')
})

test('a failed or malformed reply leaves the list as it was', async ($, on) => {
  const { clock, logs } = setup(on, ['not json'])
  await run($, 'add T Keep me')
  await turn($, clock, 't1', 'go', 'answer')
  await turn($, clock, 't2', 'go', 'answer')
  expect(await run($, 'done T1')).toBe('Closed: T1.')
  expect(logs.some(line => line.includes('observer'))).toBe(true)
})

test('subagent turns and turns that did not end in an answer are not observed', async ($, on) => {
  const { clock, calls } = setup(on, [])
  await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 'a', reason: 'answer', agentId: 'sub' } as Parameters<
    typeof $.turn.complete
  >[0])
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 'b', reason: 'aborted' } as Parameters<
    typeof $.turn.complete
  >[0])
  await clock.settle()
  expect(calls).toEqual([])
})

test('a reply that arrives after /resume is dropped instead of landing in the new session', async ($, on) => {
  const { clock, session } = setup(on, ['{"add":[{"kind":"W","title":"Late"}]}'])
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ answer: 'a', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as Parameters<
    typeof $.turn.complete
  >[0])
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } } as Parameters<typeof $.session.end>[0])
  session.id = 's2'
  await clock.settle()
  expect(await run($, 'add W Next')).toBe('Added W1 (wait).')
})
