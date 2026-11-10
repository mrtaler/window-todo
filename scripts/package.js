const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const entries = ['.claude-plugin', '.codex-plugin', 'dist', 'LICENSE', 'NOTICE', 'README.md']

function assemble(destination) {
  if (!fs.existsSync(path.join(root, 'dist/shared/plan.js'))) throw new Error('Build the plugin before packaging it.')
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of entries) fs.cpSync(path.join(root, entry), path.join(destination, entry), { recursive: true })
  return destination
}

function archive() {
  const version = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'))).version
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'window-todo-package-'))
  const directory = path.join(root, 'artifacts')
  const filename = path.join(directory, `window-todo-${version}.tar.gz`)
  try {
    assemble(temporary)
    fs.mkdirSync(directory, { recursive: true })
    const result = spawnSync('tar', ['-czf', filename, '-C', temporary, '.'], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error('Unable to create the plugin archive.')
    console.log(path.relative(root, filename))
    return filename
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}

if (require.main === module) archive()
module.exports = { assemble, archive }
