function runtimeError(version) {
  const [major, minor] = String(version).split('.').map(Number)
  if (major > 22 || (major === 22 && minor >= 12)) return null
  return `window-todo requires Node.js 22.12 or later; current version is ${version}. Update Node before starting the Codex adapter.`
}

function ensureRuntime({ host = process, failOpen = false } = {}) {
  const error = runtimeError(host.versions.node)
  if (!error) return
  host.stderr.write(error + '\n')
  if (failOpen) host.stdout.write('{}\n')
  host.exit(failOpen ? 0 : 1)
}

module.exports = { runtimeError, ensureRuntime }
