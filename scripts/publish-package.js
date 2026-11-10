const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { releaseVersion, command, manifestFiles, botConfig, checkManifests, verifiedRelease, buildRelease } = require('./recover-release.js')
const { entries } = require('./package.js')

// Installs clone this branch at a package tag: built runtime and metadata only, no sources.
const branch = 'release'

// Matches the catalogue's ref pattern and is never merged into master, so semantic-release ignores it.
function packageTag(tag) {
  releaseVersion(tag)
  return `${tag}-package`
}

function checkLayout(names) {
  const missing = entries.filter(entry => !names.includes(entry))
  const unexpected = names.filter(name => !entries.includes(name))
  if (missing.length || unexpected.length) {
    throw new Error(`The package must contain exactly ${entries.join(', ')} (missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}).`)
  }
}

function parseArguments(argv) {
  const push = !argv.includes('--no-push')
  const positional = argv.filter(arg => arg !== '--no-push')
  if (positional.length !== 1 || positional[0].startsWith('-')) throw new Error('Usage: node scripts/publish-package.js <vX.Y.Z> [--no-push]')
  return { tag: positional[0], push }
}

function treeNames(ref) {
  return command('git', ['ls-tree', '--name-only', `${ref}^{tree}`]).split('\n').filter(Boolean)
}

function verifyPackageRef(ref, version) {
  checkLayout(treeNames(ref))
  command('git', ['cat-file', '-e', `${ref}:dist/shared/plan.js`])
  checkManifests(manifestFiles.map(file => JSON.parse(command('git', ['show', `${ref}:${file}`]))), version)
}

// Builds and tests the tagged sources, then lets the tag's own package script assemble the install tree.
function buildPackage(tag, destination) {
  const version = releaseVersion(tag)
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'window-todo-publish-'))
  try {
    const source = buildRelease(tag, temporary)
    command('npm', ['run', 'test:package'], { cwd: source, stdio: 'inherit', timeout: 600000 })
    require(path.join(source, 'scripts/package.js')).assemble(destination)
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
  checkLayout(fs.readdirSync(destination))
  checkManifests(manifestFiles.map(file => JSON.parse(fs.readFileSync(path.join(destination, file), 'utf8'))), version)
  return destination
}

// Commits the directory as the next tip of the release branch through a throwaway index,
// leaving the checkout, its index and its branches untouched.
function commitPackage(directory, version) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'window-todo-index-'))
  try {
    const env = { ...process.env, GIT_DIR: command('git', ['rev-parse', '--absolute-git-dir']), GIT_WORK_TREE: directory, GIT_INDEX_FILE: path.join(temporary, 'index') }
    command('git', ['add', '--all', '--force', '.'], { cwd: directory, env })
    const tree = command('git', ['write-tree'], { cwd: directory, env })
    checkLayout(treeNames(tree))
    const parent = []
    if (command('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])) {
      command('git', ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
      parent.push('-p', command('git', ['rev-parse', `refs/remotes/origin/${branch}^{commit}`]))
    }
    return command('git', [...botConfig, '-c', 'commit.gpgSign=false', 'commit-tree', tree, ...parent, '-m', `chore(package): window-todo ${version}`])
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}

function publish(tag, { push = true } = {}) {
  const { version, commit } = verifiedRelease(tag)
  const name = packageTag(tag)
  if (command('git', ['ls-remote', '--tags', 'origin', `refs/tags/${name}`])) {
    command('git', ['fetch', '--no-tags', 'origin', `+refs/tags/${name}:refs/tags/${name}`])
    verifyPackageRef(name, version)
    console.log(`${name} is already published.`)
  } else {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'window-todo-package-'))
    try {
      const packageCommit = commitPackage(buildPackage(tag, path.join(temporary, 'package')), version)
      // Annotated: the package commit has no link to master, so the tag records its source.
      command('git', [...botConfig, '-c', 'tag.gpgSign=false', 'tag', '--annotate', '--message', `window-todo ${version} package built from ${tag} (${commit})`, name, packageCommit])
      verifyPackageRef(name, version)
      // Atomic: the branch tip and its tag land together or not at all.
      if (push) command('git', ['push', '--atomic', 'origin', `${packageCommit}:refs/heads/${branch}`, `refs/tags/${name}`], { timeout: 120000 })
      console.log(`${push ? 'Published' : 'Created locally'} ${name} at ${packageCommit} on ${branch}.`)
    } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
  }
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `package_tag=${name}\n`)
  return name
}

if (require.main === module) {
  try {
    const { tag, push } = parseArguments(process.argv.slice(2))
    publish(tag, { push })
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { packageTag, checkLayout, parseArguments, buildPackage, publish }
