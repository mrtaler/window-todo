const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { assemble, archive } = require('./package.js')

// Tests the Codex package only: Claude installs the tag from sources, covered by validate and test:claude.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'window-todo-installed-'))
try {
  assemble(temporary)
  // The installable package has runtime JS and metadata, without development sources or the Claude adapter.
  for (const entry of ['shared', 'claude', 'codex', 'node_modules', 'dist/claude', '.claude-plugin']) assert.ok(!fs.existsSync(path.join(temporary, entry)), `Unexpected package entry: ${entry}`)
  assert.ok(fs.existsSync(path.join(temporary, 'dist/shared/plan.js')))
  const codexManifest = JSON.parse(fs.readFileSync(path.join(temporary, '.codex-plugin/plugin.json')))
  const expectedVersion = codexManifest.version
  // One tag carries both clients, so the Claude manifest in the tree must carry the same version.
  assert.equal(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../.claude-plugin/plugin.json'))).version, expectedVersion)
  const packageManifest = JSON.parse(fs.readFileSync(path.join(temporary, 'package.json')))
  assert.equal(packageManifest.name, 'window-todo')
  assert.equal(packageManifest.version, expectedVersion)
  assert.equal(codexManifest.name, packageManifest.name)
  assert.ok(!packageManifest.scripts && !packageManifest.dependencies, 'The package must not run scripts or install dependencies.')
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
  // npm-format archive: every entry under package/, with the package.json npm resolves by name.
  const artifacts = path.join(temporary, '.artifacts')
  const listing = spawnSync('tar', ['-tzf', archive(artifacts)], { encoding: 'utf8' })
  assert.equal(listing.status, 0, listing.stderr)
  const archived = listing.stdout.split('\n').filter(Boolean)
  for (const entry of archived) assert.ok(entry.startsWith('package/'), `Archive entry outside package/: ${entry}`)
  for (const entry of ['package/package.json', 'package/.codex-plugin/plugin.json', 'package/dist/codex/mcp.cjs']) assert.ok(archived.includes(entry), `Archive lacks ${entry}`)
  console.log('Codex package: matching versions, npm layout, manifest paths and the MCP smoke test passed.')
} finally { fs.rmSync(temporary, { recursive: true, force: true }) }
