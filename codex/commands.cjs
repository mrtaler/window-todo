const store = require('./state.cjs')
const inbox = require('./inbox.cjs')
const { closeItems, pruneDone, skipItems } = require('../shared/window.js')
const { toCounters } = require('../shared/plan.js')

const usage = '/todo show | /todo done <ids> | /todo skip <ids> | /todo prune | /todo clear | /todo help'

// Whether the session's list belongs to Claude: its mod writes the state file and overwrites any
// change made to it here, so changes go through the inbox instead.
const ownedByClaude = state => state.client === 'claude'

// Marks items done or skipped (moved down), or prunes the done ones. A Codex list changes in the
// state file at once; a Claude list through the inbox, applied by the mod. Answers the notice.
async function change(sessionId, op, ids = [], env = process.env) {
  sessionId = store.sessionFrom({ sessionId }, env)
  const dir = store.directory(env)
  const state = store.read(sessionId, dir)
  if (ownedByClaude(state)) {
    await inbox.append(sessionId, op, ids, inbox.appliedOf(state), dir)
    const what = op === 'prune' ? 'Prune' : `${op === 'done' ? 'Done' : 'Skip'}: ${ids.join(', ')}`
    return `${what}. Claude applies it within a few seconds.`
  }
  const out = await store.change(sessionId, current => {
    const result = op === 'done' ? closeItems(current.window, ids) : op === 'skip' ? skipItems(current.window, ids) : pruneDone(current.window)
    current.window = result.list
    return result
  }, dir)
  const { changed, unknown } = out.result
  const label = op === 'done' ? 'Closed' : op === 'skip' ? 'Moved down' : 'Removed'
  const parts = []
  if (changed.length > 0) parts.push(op === 'prune' ? `Removed ${changed.length} completed items.` : `${label}: ${changed.join(', ')}.`)
  if (unknown.length > 0) parts.push(`Not in the list: ${unknown.join(', ')}.`)
  return parts.length === 0 ? (op === 'prune' ? 'Removed 0 completed items.' : 'Nothing was changed.') : parts.join(' ')
}

async function execute(text, sessionId, env = process.env) {
  const [word = '', ...rest] = String(text).trim().replace(/^\/todo(?:\s+|$)/i, '').split(/[\s,]+/).filter(Boolean)
  const action = word.toLowerCase() || 'help'
  if (action === 'help') return usage
  const takesIds = action === 'done' || action === 'skip'
  if (!['show', 'prune', 'clear', 'done', 'skip'].includes(action) || (takesIds ? rest.length === 0 : rest.length > 0)) throw new Error(usage)
  if (!sessionId) throw new Error('No conversation bound yet.')
  sessionId = store.sessionFrom({ sessionId }, env)
  const dir = store.directory(env)
  if (action === 'show') {
    const state = store.read(sessionId, dir)
    const open = state.window.items.filter(item => !item.isDone).length
    const waiting = ownedByClaude(state) ? inbox.read(sessionId, dir).filter(entry => entry.seq > inbox.appliedOf(state)).length : 0
    return `${state.plan.nodes.length} plan nodes; ${open} open; ${state.window.items.length - open} completed.` + (waiting ? ` ${waiting} waiting for Claude.` : '')
  }
  if (action !== 'clear') return change(sessionId, action, rest, env)
  if (ownedByClaude(store.read(sessionId, dir))) throw new Error('The plan belongs to Claude: run /todo clear in the Claude pane.')
  const out = await store.change(sessionId, state => {
    const last = toCounters(state.plan).get('') || 0
    state.plan = { title: '', nodes: [], issued: last ? [{ parent: '', last }] : [] }
    state.window = { ...state.window, items: [] }
    state.gateDenies = 0
    return 'Plan and window list cleared.'
  }, dir)
  return out.result
}

module.exports = { execute, change, usage }
