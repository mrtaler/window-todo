const fs = require('node:fs')
const path = require('node:path')

function updateVersion(version, root = path.resolve(__dirname, '..')) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw new Error('Expected the semantic-release version as the first argument.')
  }
  // Parse both manifests before writing either: a bad second file must not update the first.
  const updates = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json'].map(relative => {
    const filename = path.join(root, relative)
    const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'))
    if (manifest.name !== 'window-todo' || typeof manifest.version !== 'string') throw new Error(`Invalid plugin manifest: ${relative}`)
    manifest.version = version
    return { filename, content: JSON.stringify(manifest, null, 2) + '\n' }
  })
  for (const update of updates) fs.writeFileSync(update.filename, update.content)
}

if (require.main === module) {
  try { updateVersion(process.argv[2]) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { updateVersion }
