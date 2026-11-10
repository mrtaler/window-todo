const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const store = require('./state.cjs')

function filename(token, env = process.env) {
  store.sessionFrom({ sessionId: token }, env)
  return path.join(store.directory(env), `binding-${crypto.createHash('sha256').update(token).digest('hex')}.json`)
}

function read(token, env = process.env) {
  try { return JSON.parse(fs.readFileSync(filename(token, env), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

function write(token, value, env) {
  const file = filename(token, env)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally { fs.rmSync(temporary, { force: true }) }
}

function initialize(token, env = process.env, sessionId = null) {
  if (!read(token, env)) write(token, { sessionId: sessionId ? store.sessionFrom({ sessionId }, env) : null, closed: false }, env)
}

function bind(token, sessionId, env = process.env) {
  const current = read(token, env)
  if (!current || current.closed) return
  write(token, { sessionId: store.sessionFrom({ sessionId }, env), closed: false }, env)
}

function close(token, env = process.env) {
  const current = read(token, env)
  if (current) write(token, { ...current, closed: true }, env)
}

function remove(token, env = process.env) {
  fs.rmSync(filename(token, env), { force: true })
}

module.exports = { filename, read, initialize, bind, close, remove }
