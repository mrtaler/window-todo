const assert = require('node:assert/strict')
const { test } = require('node:test')
const { packageTag, checkLayout, parseArguments } = require('./publish-package.js')
const { checkManifests } = require('./recover-release.js')

// The catalogue accepts only refs of this shape (agent-plugins scripts/validate-catalogs.cjs).
const catalogueRef = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

test('the package tag is derived from a stable release tag and passes the catalogue ref check', () => {
  assert.equal(packageTag('v0.7.0'), 'v0.7.0-package')
  assert.match(packageTag('v1.12.3'), catalogueRef)
  for (const value of ['', 'master', 'v0.7.0-package', 'v0.7.0-beta.1', 'v07.0.0', 'v0.7.0;echo bad']) assert.throws(() => packageTag(value))
})

test('the package tree must hold exactly the installable entries', () => {
  checkLayout(['.claude-plugin', '.codex-plugin', 'dist', 'LICENSE', 'NOTICE', 'README.md'])
  checkLayout(['README.md', 'NOTICE', 'LICENSE', 'dist', '.codex-plugin', '.claude-plugin'])
  assert.throws(() => checkLayout(['.claude-plugin', '.codex-plugin', 'LICENSE', 'NOTICE', 'README.md']), /missing: dist/)
  assert.throws(() => checkLayout(['.claude-plugin', '.codex-plugin', 'dist', 'LICENSE', 'NOTICE', 'README.md', 'package.json']), /unexpected: package\.json/)
  for (const source of ['shared', 'claude', 'codex', 'scripts', 'node_modules']) {
    assert.throws(() => checkLayout(['.claude-plugin', '.codex-plugin', 'dist', 'LICENSE', 'NOTICE', 'README.md', source]))
  }
})

test('both manifests must name window-todo at the released version', () => {
  const manifest = { name: 'window-todo', version: '0.7.0' }
  checkManifests([manifest, manifest], '0.7.0')
  assert.throws(() => checkManifests([manifest], '0.7.0'))
  assert.throws(() => checkManifests([manifest, { ...manifest, version: '0.6.0' }], '0.7.0'))
  assert.throws(() => checkManifests([manifest, { ...manifest, name: 'other' }], '0.7.0'))
  assert.throws(() => checkManifests([manifest, null], '0.7.0'))
})

test('the command line takes one release tag and an optional local-only flag', () => {
  assert.deepEqual(parseArguments(['v0.7.0']), { tag: 'v0.7.0', push: true })
  assert.deepEqual(parseArguments(['v0.7.0', '--no-push']), { tag: 'v0.7.0', push: false })
  assert.deepEqual(parseArguments(['--no-push', 'v0.7.0']), { tag: 'v0.7.0', push: false })
  for (const argv of [[], ['v0.7.0', 'v0.6.0'], ['--force']]) assert.throws(() => parseArguments(argv))
})
