require('./runtime.cjs').ensureRuntime({ host: process, failOpen: true })
const store = require('./state.cjs')
const { reduceActivity } = require('../shared/activity.js')
const { hasUnfinished } = require('../shared/plan.js')
const { clean } = require('../shared/sanitize.js')

function instructions(sessionId) {
  return `window-todo sessionId: ${sessionId}. Use the window-todo plan and window MCP tools with this sessionId. Keep the task plan current and record open tasks T, fixes F, questions Q and external waits W. Close answered questions and completed items. When using the companion launcher, omit sessionId to use its session instead. Pure Q&A needs no plan.`
}

async function handle(event, env = process.env) {
  if (event.agent_id || event.agentId) return {}
  const eventName = event.hook_event_name || event.hookEventName || event.event_name || ''
  const kind = eventName.replaceAll('_', '').toLowerCase()
  const sessionId = store.sessionFrom({ sessionId: env.WINDOW_TODO_SESSION || event.session_id || event.thread_id || event.threadId }, env)
  const dir = store.directory(env)
  if (kind === 'sessionstart' || kind === 'userpromptsubmit') {
    await store.change(sessionId, state => {
      state.activity = reduceActivity(state.activity, { type: 'turnStart' }, Date.now())
      state.gateDenies = 0
    }, dir)
    return { hookSpecificOutput: { hookEventName: eventName, additionalContext: instructions(sessionId) } }
  }
  if (kind === 'pretooluse' || kind === 'posttooluse') {
    const tool = event.tool_name || event.toolName || 'tool'
    const state = store.read(sessionId, dir)
    // Enforcement is opt-in for this first Codex adapter; keep a failed hook fail-open.
    if (kind === 'pretooluse' && env.WINDOW_TODO_ENFORCE === 'true' && /^(?:Bash|apply_patch|exec_command)$/.test(tool) && !hasUnfinished(state.plan)) {
      const gated = await store.change(sessionId, current => {
        if (hasUnfinished(current.plan)) return false
        current.gateDenies = (current.gateDenies || 0) + 1
        return current.gateDenies <= 3
      }, dir)
      if (gated.result) return { hookSpecificOutput: { hookEventName: eventName, permissionDecision: 'deny', permissionDecisionReason: `Create a window-todo plan before changing state (sessionId ${sessionId}).` } }
    }
    await store.change(sessionId, current => {
      current.activity = reduceActivity(current.activity, { type: kind === 'pretooluse' ? 'toolStart' : 'toolEnd', tool: clean(tool), id: event.tool_use_id || event.call_id }, Date.now())
    }, dir)
    return {}
  }
  if (kind === 'stop' || kind === 'sessionend') {
    await store.change(sessionId, state => { state.activity = reduceActivity(state.activity, { type: 'turnComplete', reason: 'answer' }, Date.now()) }, dir)
  }
  return {}
}

if (require.main === module) {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { input += chunk })
  process.stdin.on('end', async () => {
    try { process.stdout.write(JSON.stringify(await handle(JSON.parse(input))) + '\n') }
    catch (error) {
      process.stderr.write(`window-todo hook: ${error.message}\n`)
      process.stdout.write('{}\n')
    }
  })
}
module.exports = { handle, instructions }
