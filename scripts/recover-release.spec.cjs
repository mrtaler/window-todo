const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const { releaseVersion, notesFailureTag, releaseNotes, packagedArchive } = require('./recover-release.js')

test('recovery accepts a stable tag and rejects arbitrary refs or shell input', () => {
  assert.equal(releaseVersion('v0.5.0'), '0.5.0')
  for (const value of ['', 'master', 'v0.5.0-beta.1', 'v01.5.0', 'v0.5.0;echo bad']) assert.throws(() => releaseVersion(value))
})

test('only the specific post-tag Git notes push error enables automatic recovery', () => {
  assert.equal(notesFailureTag("ExecaError: Command failed with exit code 1: git push -- 'https://github.com/example/repo' refs/notes/semantic-release-v0.5.0"), 'v0.5.0')
  assert.throws(() => notesFailureTag('Command failed with exit code 1: npm run build'))
  assert.throws(() => notesFailureTag('Command failed with exit code 1: git push origin master'))
})

test('recovery publishes the selected changelog section without older release notes', () => {
  const changelog = '## [0.5.0](compare-url)\n\n### Features\n\n* New package\n\n## [0.4.0](old-url)\n\n* Old package\n'
  const result = releaseNotes(changelog, '0.5.0')
  assert.match(result, /New package/)
  assert.ok(!result.includes('Old package'))
  assert.throws(() => releaseNotes(changelog, '0.6.0'))
})

test('recovery takes the archive the tagged package script reports, old or npm format', () => {
  const source = path.resolve('/tmp/source')
  assert.equal(packagedArchive('artifacts/window-todo-0.8.0.tgz\n', source, '0.8.0'), path.join(source, 'artifacts/window-todo-0.8.0.tgz'))
  assert.equal(packagedArchive('noise\nartifacts/window-todo-0.7.0.tar.gz', source, '0.7.0'), path.join(source, 'artifacts/window-todo-0.7.0.tar.gz'))
  for (const output of ['artifacts/window-todo-0.7.0.tgz', '../artifacts/window-todo-0.8.0.tgz', 'artifacts/other-0.8.0.tgz', '']) assert.throws(() => packagedArchive(output, source, '0.8.0'))
})
