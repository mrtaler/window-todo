const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
// The Codex package: its manifest, the built runtime and the notices. Claude installs the tag from sources.
const entries = ['.codex-plugin', 'dist/codex', 'dist/shared', 'dist/package.json', 'LICENSE', 'NOTICE', 'README.md']

function codexManifest() {
  return JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin/plugin.json'), 'utf8'))
}

// Assembles the package root that npm-format installs extract from the archive's package/ folder.
function assemble(destination) {
  if (!fs.existsSync(path.join(root, 'dist/shared/plan.js'))) throw new Error('Build the plugin before packaging it.')
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of entries) fs.cpSync(path.join(root, entry), path.join(destination, entry), { recursive: true })
  const { version, description } = codexManifest()
  const manifest = { name: 'window-todo', version, description, license: 'MIT' }
  fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  return destination
}

function archive(directory = path.join(root, 'artifacts')) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'window-todo-package-'))
  const filename = path.join(directory, `window-todo-${codexManifest().version}.tgz`)
  try {
    assemble(path.join(temporary, 'package'))
    fs.mkdirSync(directory, { recursive: true })
    // COPYFILE_DISABLE keeps macOS tar from adding AppleDouble ._ entries.
    const result = spawnSync('tar', ['-czf', filename, '-C', temporary, 'package'], { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } })
    if (result.status !== 0) throw new Error('Unable to create the plugin archive.')
    return filename
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}

// Prints the archive path relative to the repository; recover-release.js reads it.
if (require.main === module) console.log(path.relative(root, archive()))
module.exports = { entries, assemble, archive }
