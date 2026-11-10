const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { assemble } = require('./package.js')

const root = path.resolve(__dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'window-todo-installed-'))
try {
  assemble(temporary)
  // The installable package has runtime JS, contracts and metadata, without development sources.
  for (const directory of ['shared', 'claude', 'codex', 'node_modules']) assert.ok(!fs.existsSync(path.join(temporary, directory)))
  assert.ok(fs.existsSync(path.join(temporary, 'dist/shared/plan.js')))
  const expectedVersion = JSON.parse(fs.readFileSync(path.join(temporary, '.claude-plugin/plugin.json'))).version
  assert.equal(JSON.parse(fs.readFileSync(path.join(temporary, '.codex-plugin/plugin.json'))).version, expectedVersion)
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'window', arguments: { sessionId: 'package-smoke', op: 'add', kind: 'T', title: 'Installed package works' } } },
  ]
  const mcp = spawnSync(process.execPath, [path.join(temporary, 'dist/codex/mcp.cjs')], {
    input: requests.map(request => JSON.stringify(request)).join('\n') + '\n', encoding: 'utf8',
    cwd: temporary, env: { ...process.env, WINDOW_TODO_STATE_DIR: path.join(temporary, '.state') },
  })
  assert.equal(mcp.status, 0, mcp.stderr)
  const replies = mcp.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(replies[0].result.serverInfo.version, expectedVersion)
  assert.equal(replies[1].result.isError, false)
  assert.match(replies[1].result.content[0].text, /Added T1/)
  const validate = spawnSync('claude', ['plugin', 'validate', temporary], { encoding: 'utf8' })
  assert.equal(validate.status, 0, validate.stdout + validate.stderr)
  // Run existing adapter tests against the installed JS, not against its TypeScript source.
  for (const name of fs.readdirSync(path.join(root, 'claude')).filter(name => name.endsWith('.test.ts'))) {
    fs.copyFileSync(path.join(root, 'claude', name), path.join(temporary, 'dist/claude', name))
  }
  const tests = spawnSync('claude', ['plugin', 'test', temporary], { encoding: 'utf8' })
  if (tests.status !== 0) process.stderr.write(tests.stdout + tests.stderr)
  assert.equal(tests.status, 0, 'Installed Claude adapter tests failed.')
  console.log('Installed package: matching versions, shared JS, Codex MCP and all Claude adapter tests passed.')
} finally { fs.rmSync(temporary, { recursive: true, force: true }) }
