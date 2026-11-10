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
  const codexManifest = JSON.parse(fs.readFileSync(path.join(temporary, '.codex-plugin/plugin.json')))
  assert.equal(codexManifest.version, expectedVersion)
  function packagePath(relative) {
    assert.equal(typeof relative, 'string')
    const resolved = path.resolve(temporary, relative.replaceAll('${PLUGIN_ROOT}', temporary))
    assert.ok(resolved === temporary || resolved.startsWith(temporary + path.sep), `Path escapes plugin root: ${relative}`)
    assert.ok(fs.existsSync(resolved), `Missing plugin path: ${relative}`)
    return resolved
  }
  const skills = packagePath(codexManifest.skills)
  assert.ok(fs.statSync(skills).isDirectory())
  assert.ok(fs.readdirSync(skills).some(name => fs.existsSync(path.join(skills, name, 'SKILL.md'))))
  const mcpConfig = JSON.parse(fs.readFileSync(packagePath(codexManifest.mcpServers)))
  const server = mcpConfig.mcpServers['window-todo']
  const workingDirectory = packagePath(server.cwd || '.')
  const args = server.args.map(arg => arg.replaceAll('${PLUGIN_ROOT}', temporary))
  for (const arg of args.filter(arg => arg.startsWith('./') || arg.startsWith('../'))) packagePath(path.relative(temporary, path.resolve(workingDirectory, arg)))
  for (const groups of Object.values(codexManifest.hooks.hooks)) {
    for (const group of groups) for (const hook of group.hooks) {
      const referenced = [...hook.command.matchAll(/\$\{PLUGIN_ROOT\}(\/[^"'\s]+)/g)]
      assert.ok(referenced.length > 0, 'Hook command must reference an installed plugin script.')
      for (const reference of referenced) packagePath('.' + reference[1])
    }
  }
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'window', arguments: { sessionId: 'package-smoke', op: 'add', kind: 'T', title: 'Installed package works' } } },
  ]
  const mcp = spawnSync(server.command, args, {
    input: requests.map(request => JSON.stringify(request)).join('\n') + '\n', encoding: 'utf8',
    cwd: workingDirectory, env: { ...process.env, WINDOW_TODO_STATE_DIR: path.join(temporary, '.state') },
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
