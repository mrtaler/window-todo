require('./runtime.cjs').ensureRuntime({ host: process })
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { call } = require('./service.cjs')
const store = require('./state.cjs')
const { render } = require('./panel.cjs')

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-todo-demo-'))
  const options = { directory: dir, env: {} }
  try {
    await call('plan', { sessionId: 'demo', op: 'set', title: 'Example task', nodes: [{ title: 'Inspect the inputs' }, { title: 'Implement the change' }, { title: 'Verify the result' }] }, options)
    await call('plan', { sessionId: 'demo', op: 'update', updates: [{ id: '1', status: 'completed' }, { id: '2', status: 'in_progress' }] }, options)
    await call('window', { sessionId: 'demo', op: 'add', kind: 'Q', title: 'Choose the next step' }, options)
    await call('window', { sessionId: 'demo', op: 'add', kind: 'W', title: 'Wait for an external review' }, options)
    console.log(render(store.read('demo', dir)))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
