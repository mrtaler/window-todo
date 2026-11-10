const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function releaseVersion(tag) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag || '')) throw new Error('Recovery requires an existing stable release tag, e.g. v0.5.0.')
  return tag.slice(1)
}

function notesFailureTag(log) {
  const text = log.replace(/\u001b\[[0-9;]*m/g, '')
  const failedPush = text.split('\n').find(line => /Command failed with exit code.*git push/.test(line) && /refs\/notes\/semantic-release-v/.test(line))
  if (!failedPush) throw new Error('This is not a Git notes push failure; the original release error must be investigated.')
  const match = failedPush.match(/refs\/notes\/semantic-release-(v\d+\.\d+\.\d+)/)
  if (!match) throw new Error('Cannot determine the failed release tag.')
  releaseVersion(match[1])
  return match[1]
}

function releaseNotes(changelog, version) {
  const escaped = version.replaceAll('.', '\\.')
  const header = new RegExp('^#{1,2}\\s+\\[?' + escaped + '(?:\\]|\\s|\\(|$)')
  const lines = changelog.split('\n')
  const start = lines.findIndex(line => header.test(line))
  if (start < 0) throw new Error('The tagged changelog has no matching release section.')
  const next = lines.findIndex((line, index) => index > start && /^#{1,2}\s/.test(line))
  return lines.slice(start, next < 0 ? undefined : next).join('\n').trim() + '\n'
}

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 120000, ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${binary} failed: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

async function recover(tag) {
  const version = releaseVersion(tag)
  const repo = process.env.GITHUB_REPOSITORY || 'mrtaler/window-todo'
  const commit = command('git', ['rev-parse', `${tag}^{commit}`])
  command('git', ['merge-base', '--is-ancestor', commit, 'origin/master'])
  for (const file of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
    const manifest = JSON.parse(command('git', ['show', `${tag}:${file}`]))
    if (manifest.name !== 'window-todo' || manifest.version !== version) throw new Error('The existing tag and plugin manifests do not match; no publication performed.')
  }
  command('git', ['cat-file', '-e', `${tag}:dist/shared/plan.js`])
  const notes = releaseNotes(command('git', ['show', `${tag}:CHANGELOG.md`]), version)
  const noteRef = `refs/notes/semantic-release-${tag}`
  const remoteNote = command('git', ['ls-remote', '--refs', 'origin', noteRef])
  if (remoteNote) command('git', ['fetch', 'origin', `${noteRef}:${noteRef}`])
  const currentNote = spawnSync('git', ['notes', '--ref', noteRef, 'show', tag], { encoding: 'utf8' })
  if (currentNote.status !== 0) {
    command('git', ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'notes', '--ref', noteRef, 'add', '-m', '{"channels":[null]}', tag])
  } else if (!JSON.parse(currentNote.stdout).channels?.includes(null)) {
    throw new Error('The Git note describes another release channel; recovery will not overwrite it.')
  }
  let pushed = false
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = spawnSync('git', ['push', 'origin', noteRef], { encoding: 'utf8', timeout: 30000 })
    if (result.status === 0) { pushed = true; break }
    if (attempt === 2) throw new Error(result.stderr || 'Git notes push failed after retries.')
    await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 2000))
  }
  if (!pushed) throw new Error('Git note was not published.')

  // Package the immutable release tree, never a newer working branch or a rebuilt version.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'window-todo-recover-'))
  try {
    const source = path.join(temporary, 'source')
    fs.mkdirSync(source)
    const gitArchive = path.join(temporary, 'tag.tar')
    command('git', ['archive', '--format=tar', '--output', gitArchive, tag])
    command('tar', ['-xf', gitArchive, '-C', source])
    command(process.execPath, [path.join(source, 'scripts/package.js')], { cwd: source })
    const archive = path.join(source, 'artifacts', `window-todo-${version}.tar.gz`)
    if (!fs.existsSync(archive)) throw new Error('The tagged package script did not create the expected release archive.')
    const notesFile = path.join(temporary, 'notes.md')
    fs.writeFileSync(notesFile, notes)
    const existing = spawnSync('gh', ['release', 'view', tag, '--repo', repo, '--json', 'isDraft,assets,url'], { encoding: 'utf8' })
    if (existing.status === 0) {
      const release = JSON.parse(existing.stdout)
      if (release.isDraft) throw new Error('An existing draft release needs review; recovery will not publish it automatically.')
      if (!release.assets.some(asset => asset.name === path.basename(archive))) command('gh', ['release', 'upload', tag, archive, '--repo', repo])
      console.log(release.url)
    } else if (/release not found/i.test(existing.stderr)) {
      console.log(command('gh', ['release', 'create', tag, `${archive}#Window Todo plugin package`, '--repo', repo, '--verify-tag', '--title', tag, '--notes-file', notesFile]))
    } else throw new Error(existing.stderr || 'Unable to inspect the GitHub release.')
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\nversion=${version}\n`)
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}

if (require.main === module) {
  let tag = process.env.RECOVER_TAG || process.argv[2]
  if (process.argv[2] === '--notes-failure-log') tag = notesFailureTag(fs.readFileSync(process.argv[3], 'utf8'))
  recover(tag).catch(error => { console.error(error.message); process.exitCode = 1 })
}
module.exports = { releaseVersion, notesFailureTag, releaseNotes }
