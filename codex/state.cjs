const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { emptyPlan } = require('./core/plan')
const { emptyWindow } = require('./core/window')
const { emptyActivity } = require('./core/activity')

function directory(env = process.env) {
  return env.WINDOW_TODO_STATE_DIR || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'window-todo')
}

function validateSession(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256) throw new Error('A sessionId is required. Use the current Codex thread ID, or launch through codex/launch.cjs.')
  return value
}

function sessionFrom(input = {}, env = process.env) {
  return validateSession(input.sessionId || env.WINDOW_TODO_SESSION || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID)
}

function filename(sessionId, dir = directory()) {
  return path.join(dir, crypto.createHash('sha256').update(validateSession(sessionId)).digest('hex') + '.json')
}

function emptyState(sessionId) {
  return { version: 1, sessionId, plan: emptyPlan(), window: emptyWindow(), activity: emptyActivity(Date.now()), updatedAt: Date.now() }
}

function read(sessionId, dir = directory()) {
  const file = filename(sessionId, dir)
  let value
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return emptyState(sessionId); throw error }
  if (value.version !== 1 || value.sessionId !== sessionId || !Array.isArray(value.plan?.nodes) || !Array.isArray(value.window?.items)) throw new Error('Invalid window-todo state; the existing file was left untouched.')
  return value
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function change(sessionId, update, dir = directory()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = filename(sessionId, dir)
  const lock = file + '.lock'
  const deadline = Date.now() + 5000
  while (true) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 })
      fs.writeFileSync(path.join(lock, 'owner'), String(process.pid), { mode: 0o600 })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      // Only reclaim an old lock whose owner is gone. A busy live process is never interrupted.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30000) {
          const owner = Number(fs.readFileSync(path.join(lock, 'owner'), 'utf8'))
          if (Number.isInteger(owner) && owner > 0) {
            try { process.kill(owner, 0) }
            catch (probe) { if (probe.code === 'ESRCH') fs.rmSync(lock, { recursive: true }) }
          }
        }
      } catch (probe) { if (probe.code !== 'ENOENT') throw probe }
      if (Date.now() > deadline) throw new Error('State is busy; retry the operation.')
      await sleep(15)
    }
  }
  let temporary
  try {
    const current = read(sessionId, dir)
    const result = update(current)
    current.updatedAt = Date.now()
    temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(current) + '\n', { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, file)
    temporary = undefined
    return { state: current, result }
  } finally {
    if (temporary) fs.rmSync(temporary, { force: true })
    fs.rmSync(lock, { recursive: true, force: true })
  }
}

module.exports = { directory, sessionFrom, filename, emptyState, read, change }
