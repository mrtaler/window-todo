import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  age,
  buildSessionRows,
  detailOf,
  isSameProcess,
  mergeFacts,
  mergeStored,
  parsePsStart,
  parseSessionFile,
  parseStoredEntry,
  pickTitle,
  projectFolderName,
  resumeCommand,
  scanTranscript,
  sessionsText,
} from './sessions'
import type { RunningSession, SessionDetail, StoredSession } from './sessions'
import type { WindowItem, WindowList } from './types'

const TODAY = '2026-11-12'
const NOW = Date.UTC(2026, 10, 12, 12)
const HOUR = 60 * 60 * 1000

const listOf = (...items: Array<Partial<WindowItem> & { id: string }>): WindowList => ({
  items: items.map(item => ({ kind: 'W', title: item.id, isDone: false, ...item }) as WindowItem),
  issued: { T: 9, F: 9, Q: 9, W: 9 },
})

const stored = (sessionId: string, hoursAgo: number, list: WindowList, client: 'claude' | 'codex' = 'claude'): StoredSession => ({
  sessionId,
  client,
  updatedAt: NOW - hoursAgo * HOUR,
  list,
})

const line = (value: unknown): string => JSON.stringify(value)

test('a store entry is a session list only under a window key with the list shape', () => {
  const list = listOf({ id: 'W1', due: '2026-11-15' })
  assert.deepEqual(parseStoredEntry('window:abc', { updatedAt: 5, list }), { sessionId: 'abc', client: 'claude', updatedAt: 5, list })
  assert.equal(parseStoredEntry('carry:window:x', { updatedAt: 5, list }), null)
  assert.equal(parseStoredEntry('window:', { updatedAt: 5, list }), null)
  assert.equal(parseStoredEntry('window:abc', { list }), null)
  assert.equal(parseStoredEntry('accentColor', 'claude'), null)
})

test('the newer list of a session wins across stores; a tie keeps the first store', () => {
  const old = stored('s1', 5, listOf({ id: 'W1' }))
  const fresh = stored('s1', 1, listOf({ id: 'W1', isDone: true }))
  assert.deepEqual(mergeStored([old, fresh]), [fresh])
  assert.deepEqual(mergeStored([fresh, old]), [fresh])
  const twin = { ...fresh, list: listOf({ id: 'W7' }) }
  assert.deepEqual(mergeStored([fresh, twin]), [fresh])
})

test('rows: only sessions with an open item; due ones first, the rest newest first', () => {
  const rows = buildSessionRows({
    stored: [
      stored('newest', 1, listOf({ id: 'T1', kind: 'T' })),
      stored('closed', 0, listOf({ id: 'T1', isDone: true })),
      stored('later', 2, listOf({ id: 'W1', due: '2026-11-30' })),
      stored('overdue', 9, listOf({ id: 'W1', due: '2026-11-01' }, { id: 'W2', due: '2026-11-20' })),
      stored('today', 3, listOf({ id: 'W1', due: TODAY })),
      stored('old', 50, listOf({ id: 'F1', kind: 'F' }), 'codex'),
    ],
    running: new Map<string, RunningSession>([['today', { sessionId: 'today', pid: 7, cwd: '/run', tmux: 'window-todo-1:@1.%2' }]]),
    details: new Map<string, SessionDetail>([['later', { cwd: '/work', title: 'Waiting on DBA' }]]),
    today: TODAY,
    current: 'newest',
  })
  assert.deepEqual(rows.map(row => row.sessionId), ['overdue', 'today', 'newest', 'later', 'old'])
  const [overdue, running, current, later, codex] = rows
  assert.deepEqual([overdue?.due, overdue?.dueState, overdue?.open], ['2026-11-01', 'overdue', 2])
  assert.deepEqual([running?.isRunning, running?.tmux, running?.cwd, running?.dueState], [true, 'window-todo-1:@1.%2', '/run', 'today'])
  assert.deepEqual([current?.isCurrent, current?.isRunning, current?.due], [true, false, undefined])
  assert.deepEqual([later?.title, later?.cwd, later?.dueState], ['Waiting on DBA', '/work', 'later'])
  assert.equal(codex?.client, 'codex')
})

test('the title is the custom one, else the AI one, else the first typed prompt', () => {
  const custom = line({ type: 'custom-title', customTitle: 'api_key_migration', sessionId: 's' })
  const ai = line({ type: 'ai-title', aiTitle: 'Empty bucket name', sessionId: 's' })
  const meta = line({ type: 'user', isMeta: true, message: { content: 'meta text' }, cwd: '/a' })
  const command = line({ type: 'user', message: { content: '<command-name>/clear</command-name>' }, cwd: '/a' })
  const preface = line({ type: 'user', message: { content: 'This session is being continued from a previous conversation that ran out of context.' } })
  const typed = line({ type: 'user', message: { content: [{ type: 'text', text: 'fix the   bucket\nname' }] }, cwd: '/a' })
  const later = line({ type: 'user', message: { content: 'second prompt' } })
  const all = [meta, command, preface, typed, later].join('\n')
  assert.equal(pickTitle(scanTranscript(all)), 'fix the bucket name')
  assert.equal(pickTitle(scanTranscript([all, ai].join('\n'))), 'Empty bucket name')
  // The last title of each kind counts; a custom title beats a later AI one.
  const renamed = [all, line({ type: 'ai-title', aiTitle: 'Old' }), custom, ai, line({ type: 'ai-title', aiTitle: 'Newest AI' })].join('\n')
  assert.deepEqual(scanTranscript(renamed), { cwd: '/a', prompt: 'fix the bucket name', customTitle: 'api_key_migration', aiTitle: 'Newest AI' })
  assert.equal(pickTitle(scanTranscript(renamed)), 'api_key_migration')
  assert.equal(pickTitle(scanTranscript([meta, command].join('\n'))), undefined)
  assert.equal(pickTitle({ prompt: 'x'.repeat(200) })?.length, 80)
})

test('a chunk read from the middle drops its cut first line; the end gives titles, the start the prompt', () => {
  const cut = `ype":"custom-title","customTitle":"broken"}\n${line({ type: 'ai-title', aiTitle: 'From the end' })}\n{"type":"user","mess`
  assert.deepEqual(scanTranscript(cut, true), { aiTitle: 'From the end' })
  const head = scanTranscript(line({ type: 'user', message: { content: 'first prompt' }, cwd: '/start' }))
  const merged = mergeFacts(scanTranscript(cut, true), head)
  assert.deepEqual(merged, { aiTitle: 'From the end', prompt: 'first prompt', cwd: '/start' })
  assert.deepEqual(detailOf(merged), { cwd: '/start', title: 'From the end' })
})

test('only a working folder filed under the transcript project folder counts, the start one first', () => {
  const folder = projectFolderName('/Users/me')
  const moved = line({ type: 'user', message: { content: 'later' }, cwd: '/Users/me/.claude/plugins/store' })
  const own = line({ type: 'assistant', cwd: '/Users/me' })
  const noCwd = line({ type: 'file-history-snapshot', snapshot: {} })
  // Without a project folder the first one named counts, as before.
  assert.equal(scanTranscript([moved, own].join('\n')).cwd, '/Users/me/.claude/plugins/store')
  assert.equal(scanTranscript([moved, own].join('\n'), false, folder).cwd, '/Users/me')
  // A start without one and an end that names another folder before its own: the own one.
  const tail = scanTranscript(['cut', moved, own].join('\n'), true, folder)
  assert.equal(mergeFacts(tail, scanTranscript(noCwd, false, folder)).cwd, '/Users/me')
  // The start one wins over the end one; `/Users_me` is filed under the same name.
  const head = scanTranscript([noCwd, own].join('\n'), false, folder)
  assert.equal(mergeFacts(scanTranscript(line({ cwd: '/Users_me' }), false, folder), head).cwd, '/Users/me')
  // Only other folders: none from the transcript, so a running session's own folder stands in.
  const other = mergeFacts(scanTranscript(moved, false, folder), scanTranscript(moved, false, folder))
  assert.equal(other.cwd, undefined)
  const rows = buildSessionRows({
    stored: [stored('live', 1, listOf({ id: 'T1', kind: 'T' })), stored('gone', 2, listOf({ id: 'T1', kind: 'T' }))],
    running: new Map<string, RunningSession>([['live', { sessionId: 'live', pid: 7, cwd: '/Users/me' }]]),
    details: new Map<string, SessionDetail>([['live', detailOf(other)], ['gone', detailOf(other)]]),
    today: TODAY,
  })
  assert.deepEqual(rows.map(row => [row.sessionId, row.cwd]), [['live', '/Users/me'], ['gone', undefined]])
})

test('a running process is the same one when ps agrees on its start, in whatever time zone', () => {
  const started = parsePsStart('58506 Tue Nov 10 23:06:52 2026    \n 4705 Thu Nov  5 16:23:45 2026\n')
  assert.equal(started.get(58506), 'Tue Nov 10 23:06:52 2026')
  assert.equal(started.get(4705), 'Thu Nov 5 16:23:45 2026')
  // procStart as Claude Code writes it (UTC on this machine) against ps in local time.
  assert.equal(isSameProcess('Thu Nov 5 15:23:45 2026', started.get(4705)), true)
  assert.equal(isSameProcess('Thu Nov  5 16:23:45 2026', started.get(4705)), true)
  assert.equal(isSameProcess('Thu Nov 5 15:23:46 2026', started.get(4705)), false)
  assert.equal(isSameProcess('Wed Nov 4 16:23:45 2026', started.get(4705)), false)
  assert.equal(isSameProcess(undefined, started.get(4705)), true)
  assert.equal(isSameProcess('Thu Nov 5 16:23:45 2026', undefined), false)
})

test('a sessions file gives pid, session, folder and tmux pane; anything else is not one', () => {
  assert.deepEqual(parseSessionFile({ pid: 7, sessionId: 's', cwd: '/x', tmux: 'w:@1.%2', procStart: 'p', kind: 'interactive' }), {
    pid: 7,
    sessionId: 's',
    cwd: '/x',
    tmux: 'w:@1.%2',
    procStart: 'p',
  })
  assert.equal(parseSessionFile({ pid: '7', sessionId: 's' }), null)
  assert.equal(parseSessionFile({ pid: 7 }), null)
  assert.equal(projectFolderName('/Users/Siarhei_Linkevich/.claude/plugins'), '-Users-Siarhei-Linkevich--claude-plugins')
})

test('the plain list shows each session with its resume command, capped with +N more', () => {
  const rows = buildSessionRows({
    stored: [
      stored('11111111-aaaa', 0.5, listOf({ id: 'W1', due: TODAY })),
      stored('22222222-bbbb', 30, listOf({ id: 'T1', kind: 'T' }, { id: 'T2', kind: 'T' })),
      stored('33333333-cccc', 400, listOf({ id: 'Q1', kind: 'Q' }), 'codex'),
    ],
    running: new Map([['11111111-aaaa', { sessionId: '11111111-aaaa', pid: 1, tmux: 'window-todo-1:@1.%2' }]]),
    details: new Map<string, SessionDetail>([
      ['22222222-bbbb', { cwd: '/Users/me/My Repo', title: 'Fix the bucket' }],
      ['33333333-cccc', { cwd: '/Users/me', title: 'Codex work' }],
    ]),
    today: TODAY,
    current: '11111111-aaaa',
  })
  const text = sessionsText(rows, { now: NOW, today: TODAY, home: '/Users/me', notes: ['A note.'] })
  assert.equal(
    text,
    [
      'Sessions with open window items: 3 (● running; days that have come are marked !).',
      '●  11111111  1 open  !11-12  30m  ?  (no title) (this session)',
      '    running: tmux switch-client -t window-todo-1:@1.%2',
      '○  22222222  2 open  30h  ~/My Repo  Fix the bucket',
      "    cd '/Users/me/My Repo' && claude --resume 22222222-bbbb",
      '○  33333333  1 open  2w  codex  ~  Codex work',
      '    cd /Users/me && codex resume 33333333-cccc',
      'A note.',
    ].join('\n'),
  )
  assert.doesNotMatch(text, /\x1b/)
  const capped = sessionsText(rows, { now: NOW, today: TODAY, cap: 1 })
  assert.match(capped, /\n\+2 more$/)
  assert.equal(sessionsText([], { now: NOW, today: TODAY }), 'No session has an open window item.')
  assert.equal(resumeCommand({ ...rows[1]!, cwd: undefined } as (typeof rows)[number]), 'claude --resume 22222222-bbbb')
})

test('ages are given in one short unit', () => {
  assert.deepEqual([0, 0.5, 5, 47, 72, 24 * 20].map(hours => age(NOW - hours * HOUR, NOW)), ['now', '30m', '5h', '47h', '3d', '2w'])
})
