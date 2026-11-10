require('./runtime.cjs').ensureRuntime({ host: process })
const readline = require('node:readline')
const { tools, call } = require('./service.cjs')
const { version } = require('../../.codex-plugin/plugin.json')

const supportedVersions = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']
function send(value) { process.stdout.write(JSON.stringify(value) + '\n') }

async function request(input) {
  if (typeof input !== 'object' || input === null || input.jsonrpc !== '2.0' || typeof input.method !== 'string') return send({ jsonrpc: '2.0', id: input?.id ?? null, error: { code: -32600, message: 'Invalid JSON-RPC request' } })
  if (!Object.hasOwn(input, 'id')) return
  const reply = result => send({ jsonrpc: '2.0', id: input.id, result })
  if (input.method === 'initialize') return reply({ protocolVersion: supportedVersions.includes(input.params?.protocolVersion) ? input.params.protocolVersion : supportedVersions.at(-1), capabilities: { tools: {} }, serverInfo: { name: 'window-todo', version }, instructions: 'Keep the plan and open T/F/Q/W items for this conversation. Supply the current thread ID as sessionId unless WINDOW_TODO_SESSION is set by the companion launcher.' })
  if (input.method === 'ping') return reply({})
  if (input.method === 'tools/list') return reply({ tools })
  if (input.method === 'tools/call') {
    try { return reply({ content: [{ type: 'text', text: await call(input.params?.name, input.params?.arguments ?? {}) }], isError: false }) }
    catch (error) { return reply({ content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true }) }
  }
  send({ jsonrpc: '2.0', id: input.id, error: { code: -32601, message: `Unknown method: ${input.method}` } })
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let queue = Promise.resolve()
lines.on('line', line => {
  if (!line.trim()) return
  queue = queue.then(async () => {
    let input
    try { input = JSON.parse(line) }
    catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }) }
    await request(input)
  }).catch(error => process.stderr.write(`window-todo MCP: ${error.message}\n`))
})
lines.on('close', () => { queue.then(() => { process.exitCode = 0 }) })
