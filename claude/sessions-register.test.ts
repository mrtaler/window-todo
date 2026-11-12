import type { CommandRunInput, FsEntry, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

// `/todo sessions`: the lists come from the store; the running check, the folders and the titles
// from Claude Code's files under $HOME/.claude, here a file system in memory, and from ps, tail and
// head, here a process runner that answers from the same files.
const NOON = Date.UTC(2026, 10, 12, 12)
const HOUR = 60 * 60 * 1000
const CLAUDE = '/home/me/.claude'
const MiB = 1024 * 1024

const open = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: id[0], title: `${id} title`, isDone: false, ...extra })
const list = (...items: Array<Record<string, unknown>>) => ({ items, issued: { T: 9, F: 9, Q: 9, W: 9 } })
const line = (value: unknown): string => `${JSON.stringify(value)}\n`

const STORE = {
  'window:s1-current': { updatedAt: NOON - 1 * HOUR, list: list(open('T1')) },
  'window:aaaaaaaa-run': { updatedAt: NOON - 2 * HOUR, list: list(open('W1', { due: '2026-11-12' }), open('T2')) },
  'window:bbbbbbbb-old': { updatedAt: NOON - 30 * HOUR, list: list(open('Q1')) },
  'window:cccccccc-big': { updatedAt: NOON - 3 * HOUR, list: list(open('F1')) },
  'window:dddddddd-done': { updatedAt: NOON, list: list(open('T1', { isDone: true })) },
  'carry:window:x': { from: 'z', at: NOON, list: list(open('T1')) },
  accentColor: 'claude',
}

// A transcript file over the 4 MiB a $.fs read takes: only tail and head reach it.
const BIG = `${CLAUDE}/projects/-home-me-big/cccccccc-big.jsonl`
const BIG_HEAD = line({ type: 'user', message: { content: 'first prompt of the big one' }, cwd: '/home/me/big' })
const BIG_TAIL = `cut line"}\n${line({ type: 'ai-title', aiTitle: 'Big session AI title' })}`

type World = { files: Map<string, string>; reads: string[]; runs: string[][] }

const setup = (on: On, options: { listDenied?: boolean; noProcess?: boolean } = {}): World => {
  const stored = new Map<string, unknown>(Object.entries(STORE))
  const files = new Map<string, string>([
    [`${CLAUDE}/sessions/101.json`, JSON.stringify({ pid: 101, sessionId: 'aaaaaaaa-run', cwd: '/home/me/run', tmux: 'window-todo-1:@3.%4', procStart: 'Thu Nov 12 10:00:00 2026' })],
    [`${CLAUDE}/sessions/102.json`, JSON.stringify({ pid: 102, sessionId: 'bbbbbbbb-old', cwd: '/home/me/old', procStart: 'Thu Nov 12 09:00:00 2026' })],
    [`${CLAUDE}/sessions/101.0123abcd.key`, 'secret'],
    [`${CLAUDE}/projects/-home-me-run/aaaaaaaa-run.jsonl`, line({ type: 'user', message: { content: 'run prompt' }, cwd: '/home/me/run' }) + line({ type: 'custom-title', customTitle: 'Named by me' }) + line({ type: 'ai-title', aiTitle: 'AI name' })],
    [`${CLAUDE}/projects/-home-me-other/bbbbbbbb-old.jsonl`, line({ type: 'user', message: { content: '<command-name>/clear</command-name>' }, cwd: '/home/me/old' }) + line({ type: 'user', message: { content: 'old typed prompt' } })],
  ])
  const reads: string[] = []
  const runs: string[][] = []
  mock.clock(on, { now: NOON })
  mock.env(on, { HOME: '/home/me' })
  on('session.id', async () => ({ value: 's1-current' }))
  on('ui.status', async () => ({ value: undefined }))
  on('store.get', async (_$, e) => ({ value: stored.get(e.key) }))
  on('store.keys', async () => ({ value: [...stored.keys()] }))
  const entry = (name: string, kind: FsEntry['kind']): FsEntry => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })
  on('fs.list', async (_$, e) => {
    if (options.listDenied) return { deny: `EACCES: ${e.path}` }
    if (e.path === `${CLAUDE}/sessions`) return { value: ['101.json', '102.json', '101.0123abcd.key'].map(name => entry(name, 'file')) }
    if (e.path === `${CLAUDE}/projects`) return { value: ['-home-me-run', '-home-me-other', '-home-me-big'].map(name => entry(name, 'dir')) }

    return { deny: `ENOENT: ${e.path}` }
  })
  on('fs.exists', async (_$, e) => ({ value: files.has(e.path) || e.path === BIG }))
  on('fs.stat', async (_$, e) => {
    const size = e.path === BIG ? 300 * MiB : files.get(e.path)?.length
    if (size === undefined) return { deny: `ENOENT: ${e.path}` }

    return { value: { kind: 'file' as const, size, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', async (_$, e) => {
    reads.push(e.path)
    const text = files.get(e.path)

    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('process.run', async (_$, e) => {
    runs.push([...e.argv])
    if (options.noProcess) return { deny: 'process is not available' }
    const [tool] = e.argv
    const stdout =
      tool === 'ps' ? '101 Thu Nov 12 11:00:00 2026\n  102 Thu Nov 12 11:31:17 2026\n' : tool === 'tail' ? BIG_TAIL : tool === 'head' ? BIG_HEAD : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return { files, reads, runs }
}

const todo = (args: string): CommandRunInput => ({
  command: 'todo',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
})

const sessions = async ($: Engine): Promise<string> => (await $.command.run(todo('sessions'))).text ?? ''

test('/todo sessions lists the sessions with open items, due first, with folders, titles and how to go back', async ($, on) => {
  const { reads, runs } = setup(on)
  expect(await sessions($)).toBe(
    [
      'Sessions with open window items: 4 (● running; days that have come are marked !).',
      '●  aaaaaaaa  2 open  !11-12  2h  ~/run  Named by me',
      '    running: tmux switch-client -t window-todo-1:@3.%4',
      '●  s1-curre  1 open  1h  ?  (no title) (this session)',
      '    running',
      '○  cccccccc  1 open  3h  ~/big  Big session AI title',
      '    cd /home/me/big && claude --resume cccccccc-big',
      '○  bbbbbbbb  1 open  30h  ~/old  old typed prompt',
      '    cd /home/me/old && claude --resume bbbbbbbb-old',
    ].join('\n'),
  )
  // pid 102 runs under a later start time: another process reuses the pid.
  expect(runs[0]).toEqual(['ps', '-o', 'pid=,lstart=', '-p', '101,102'])
  // The big transcript is read in parts by tail and head, never whole; the key file never.
  expect(runs.slice(1)).toEqual([
    ['tail', '-c', String(512 * 1024), BIG],
    ['head', '-c', String(64 * 1024), BIG],
  ])
  expect(reads).not.toContain(BIG)
  expect(reads.some(path => path.endsWith('.key'))).toBe(false)
})

test('/todo sessions shows what the store holds when the folders cannot be read, and says so', async ($, on) => {
  setup(on, { listDenied: true })
  const text = await sessions($)
  expect(text).toContain('Sessions with open window items: 4')
  expect(text).toContain('○  bbbbbbbb  1 open  30h  ?  (no title)')
  expect(text).toContain('    claude --resume bbbbbbbb-old')
  expect(text).toContain(`Running sessions not checked: ${CLAUDE}/sessions could not be listed`)
  expect(text).toContain(`Folders and titles not read: ${CLAUDE}/projects could not be listed`)
})

test('/todo sessions without ps, tail and head still lists the sessions and names what it could not read', async ($, on) => {
  setup(on, { noProcess: true })
  const text = await sessions($)
  expect(text).toContain('Running sessions not checked: ps could not be run')
  expect(text).toContain('Transcripts not read: cccccccc')
  // The small transcripts are read through $.fs alone.
  expect(text).toContain('~/old  old typed prompt')
  expect(text).toContain('●  s1-curre')
})
