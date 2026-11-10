const assert = require('node:assert/strict')
const { test } = require('node:test')
const { releaseVersion, notesFailureTag, releaseNotes } = require('./recover-release.js')

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
