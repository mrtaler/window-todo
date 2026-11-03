import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__window-todo__window' as const

// The world beneath the mod for the window tool and the Stop reminder.
const setup = (on: On): { logs: string[] } => {
  const logs: string[] = []
  mock.clock(on)
  mock.store(on)
  on('session.id', async () => ({ value: 's1' }))
  on('classic.Stop', async () => ({}))
  on('ui.log', async (_$, e, next) => {
    logs.push(e.text)

    return next(e)
  })

  return { logs }
}

const callTool = async ($: Engine, input: Record<string, unknown>, agentId?: string): Promise<string> =>
  String(
    (
      await $.tool.call({ tool: TOOL, ...input, ...(agentId !== undefined ? { agentId } : {}) } as Parameters<
        typeof $.tool.call
      >[0])
    ).result,
  )

const stop = ($: Engine, message: string, active = false): ReturnType<Engine['classic']['Stop']> =>
  $.classic.Stop({ stop_hook_active: active, last_assistant_message: message } as Parameters<typeof $.classic.Stop>[0])

test('the window tool adds, skips and closes items with the same ids as /todo', async ($, on) => {
  const { logs } = setup(on)
  expect(await callTool($, { op: 'add', kind: 'F', title: 'Upload bypasses the toggle' })).toBe(
    'Added F1.\nF1 [open] Upload bypasses the toggle',
  )
  await callTool($, { op: 'add', kind: 'T', title: 'Wire the store' })
  expect(await callTool($, { op: 'skip', ids: ['F1'] })).toContain('Moved down: F1.\nT1 [open] Wire the store\nF1 [open]')
  expect(await callTool($, { op: 'done', ids: ['T1', 'X9'] })).toBe(
    'Closed: T1. Not in the list: X9.\nF1 [open] Upload bypasses the toggle\nT1 [done] Wire the store',
  )
  expect(logs).toEqual([])
})

test('a bad call and a subagent call change nothing', async ($, on) => {
  setup(on)
  expect(await callTool($, { op: 'add', kind: 'Z', title: 't' })).toContain('Error: op add needs "kind"')
  expect(await callTool($, { op: 'add', kind: 'Q', title: 'From a subagent' }, 'sub-1')).toContain('a subagent cannot change it')
  expect(await callTool($, { op: 'done', ids: ['Q1'] })).toBe('Not in the list: Q1.\nThe window list is empty.')
})

test('an answer ending on a question with no open Q item is sent back once', async ($, on) => {
  setup(on)
  const first = await stop($, 'Done.\n\nPane or section?')
  expect(first.block).toContain(`Call ${TOOL} with {"op":"add","kind":"Q"`)
  expect((await stop($, 'Done.\n\nPane or section?', true)).block).toBeUndefined()
})

test('an open Q item, or an answer that asks nothing, lets the turn end', async ($, on) => {
  setup(on)
  expect((await stop($, 'All done.')).block).toBeUndefined()
  await callTool($, { op: 'add', kind: 'Q', title: 'Pane or section?' })
  expect((await stop($, 'Pane or section?')).block).toBeUndefined()
  await callTool($, { op: 'done', ids: ['Q1'] })
  expect((await stop($, 'And now?')).block).toBeDefined()
})

test('tool.describe pins the window tool so it is offered on turn one', async ($, on) => {
  setup(on)
  on('tool.describe', async (_$, e) => ({ description: e.description, isDeferred: true as const }))
  const pinned = await $.tool.describe({ tool: TOOL, description: 'd', provider: { plugin: 'window-todo', tier: 'user' } })
  expect(pinned.isDeferred).toBe(false)
})
