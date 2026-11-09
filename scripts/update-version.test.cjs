const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { updateVersion } = require('./update-version.js')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'window-todo-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const directory of ['.claude-plugin', '.codex-plugin']) {
    fs.mkdirSync(path.join(root, directory))
    fs.writeFileSync(path.join(root, directory, 'plugin.json'), JSON.stringify({ name: 'window-todo', version: '0.3.0', description: directory, hooks: { value: 1 } }))
  }
  return root
}

test('release prepare updates both manifests and preserves their client metadata', t => {
  const root = fixture(t)
  updateVersion('0.4.0-beta.1', root)
  for (const directory of ['.claude-plugin', '.codex-plugin']) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, directory, 'plugin.json'))), { name: 'window-todo', version: '0.4.0-beta.1', description: directory, hooks: { value: 1 } })
  }
})

test('invalid release input leaves both manifests untouched', t => {
  const root = fixture(t)
  const file = path.join(root, '.claude-plugin/plugin.json')
  const before = fs.readFileSync(file, 'utf8')
  for (const input of [undefined, 'not-a-version', '01.4.0', '0.4']) assert.throws(() => updateVersion(input, root))
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin/plugin.json'))).version, '0.3.0')
})

test('a malformed Codex manifest cannot partially bump the Claude version', t => {
  const root = fixture(t)
  const file = path.join(root, '.claude-plugin/plugin.json')
  const before = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(path.join(root, '.codex-plugin/plugin.json'), '{broken')
  assert.throws(() => updateVersion('0.4.0', root))
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})
