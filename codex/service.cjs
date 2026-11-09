const store = require('./state.cjs')
const { parsePlanInput, applyPlanOp, PLAN_INPUT_SCHEMA, PLAN_TOOL_DESCRIPTION } = require('./core/plan-tool')
const { parseWindowInput, WINDOW_INPUT_SCHEMA, WINDOW_TOOL_DESCRIPTION } = require('./core/window-tool')
const { addItem, closeItems, skipItems, pruneDone, describeWindow } = require('./core/window')

const sessionProperty = { type: 'string', description: 'Current Codex thread ID. Required unless the launcher supplies WINDOW_TODO_SESSION. Always use the same ID for this conversation.' }
const tools = [
  { name: 'plan', description: PLAN_TOOL_DESCRIPTION, inputSchema: { ...PLAN_INPUT_SCHEMA, properties: { ...PLAN_INPUT_SCHEMA.properties, sessionId: sessionProperty } } },
  { name: 'window', description: WINDOW_TOOL_DESCRIPTION.replace("the user's pane", "the user's companion pane") + ' Use op "show" to read the current list.', inputSchema: { ...WINDOW_INPUT_SCHEMA, properties: { ...WINDOW_INPUT_SCHEMA.properties, op: { type: 'string', enum: ['show', 'add', 'done', 'skip', 'prune'] }, sessionId: sessionProperty } } },
]

async function call(name, args, options = {}) {
  if (name !== 'plan' && name !== 'window') throw new Error(`Unknown tool: ${name}`)
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('Tool arguments must be an object.')
  const sessionId = store.sessionFrom(args, options.env)
  const dir = options.directory || store.directory(options.env)
  if (name === 'plan') {
    const parsed = parsePlanInput(args)
    if (parsed.error) throw new Error(parsed.error)
    if (parsed.parsed.op === 'show') return applyPlanOp(store.read(sessionId, dir).plan, parsed.parsed, Date.now()).text
    const out = await store.change(sessionId, state => {
      const applied = applyPlanOp(state.plan, parsed.parsed, Date.now())
      if (applied.error) throw new Error(applied.error)
      state.plan = applied.plan
      state.gateDenies = 0
      return applied.text
    }, dir)
    return out.result
  }
  if (args.op === 'show') return describeWindow(store.read(sessionId, dir).window)
  const parsed = parseWindowInput(args)
  if (parsed.error) throw new Error(parsed.error)
  const out = await store.change(sessionId, state => {
    let text
    if (parsed.op === 'add') {
      const added = addItem(state.window, parsed.kind, parsed.title)
      if (added.error) throw new Error(added.error)
      state.window = added.list
      text = `Added ${added.id}.`
    } else {
      const result = parsed.op === 'done' ? closeItems(state.window, parsed.ids) : parsed.op === 'skip' ? skipItems(state.window, parsed.ids) : pruneDone(state.window)
      state.window = result.list
      text = `Changed: ${result.changed.join(', ') || 'none'}.` + (result.unknown.length ? ` Unknown: ${result.unknown.join(', ')}.` : '')
    }
    return text
  }, dir)
  return `${out.result}\n${describeWindow(out.state.window)}`
}

module.exports = { tools, call }
