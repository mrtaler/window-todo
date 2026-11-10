const store = require('./state.cjs')
const { pruneDone } = require('../shared/window.js')
const { toCounters } = require('../shared/plan.js')

const usage = '/todo show | /todo prune | /todo clear | /todo help'

async function execute(text, sessionId, env = process.env) {
  const action = String(text).trim().replace(/^\/todo(?:\s+|$)/i, '').toLowerCase() || 'help'
  if (action === 'help') return usage
  if (!['show', 'prune', 'clear'].includes(action)) throw new Error(usage)
  if (!sessionId) throw new Error('No conversation bound yet.')
  sessionId = store.sessionFrom({ sessionId }, env)
  const dir = store.directory(env)
  if (action === 'show') {
    const state = store.read(sessionId, dir)
    const open = state.window.items.filter(item => !item.isDone).length
    return `${state.plan.nodes.length} plan nodes; ${open} open; ${state.window.items.length - open} completed.`
  }
  const out = await store.change(sessionId, state => {
    if (action === 'prune') {
      const result = pruneDone(state.window)
      state.window = result.list
      return `Removed ${result.changed.length} completed items.`
    }
    const last = toCounters(state.plan).get('') || 0
    state.plan = { title: '', nodes: [], issued: last ? [{ parent: '', last }] : [] }
    state.window = { ...state.window, items: [] }
    state.gateDenies = 0
    return 'Plan and window list cleared.'
  }, dir)
  return out.result
}

module.exports = { execute, usage }
