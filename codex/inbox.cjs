const fs = require('node:fs')
const store = require('./state.cjs')
const { INBOX_MAX_ENTRIES, parseInbox, pendingEntries } = require('../shared/inbox.js')

// The pane's inbox for a client that owns its window list (Claude): `<sha>.inbox.json` next to the
// session's state file. The pane is its only writer; the client reports the last entry it applied
// as `inbox.applied` in the state file, and the pane then drops the applied entries.

function filename(sessionId, dir = store.directory()) {
  return store.filename(sessionId, dir).replace(/\.json$/, '.inbox.json')
}

// The applied number the state file reports; 0 when it reports none.
function appliedOf(state) {
  const value = state && state.inbox && state.inbox.applied
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

function read(sessionId, dir = store.directory()) {
  let value
  try { value = JSON.parse(fs.readFileSync(filename(sessionId, dir), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  return parseInbox(value, sessionId)
}

function save(sessionId, entries, dir) {
  const file = filename(sessionId, dir)
  if (entries.length === 0) fs.rmSync(file, { force: true })
  else store.writeAtomic(file, { version: 1, sessionId, entries })
}

// Queues one change; `due` is the day a `due` entry sets (none clears it). `applied` is what the
// state file reports, so the entry is numbered after everything the client has seen even when the
// inbox file is gone. Answers the entry.
async function append(sessionId, op, ids, applied, dir = store.directory(), due = null) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = filename(sessionId, dir)
  return store.locked(file, () => {
    const entries = pendingEntries(read(sessionId, dir), applied)
    if (entries.length >= INBOX_MAX_ENTRIES) throw new Error('Too many changes are waiting for Claude; try again after its next turn.')
    const seq = Math.max(applied, ...entries.map(entry => entry.seq)) + 1
    const entry = { seq, op, ids: [...ids], at: Date.now(), ...(op === 'due' && due ? { due } : {}) }
    save(sessionId, [...entries, entry], dir)
    return entry
  })
}

// Drops the entries the client has applied; removes the file once none is left. Answers the
// entries still pending.
async function acknowledge(sessionId, applied, dir = store.directory()) {
  const file = filename(sessionId, dir)
  if (!fs.existsSync(file)) return []
  return store.locked(file, () => {
    const entries = read(sessionId, dir)
    const pending = pendingEntries(entries, applied)
    if (pending.length !== entries.length) save(sessionId, pending, dir)
    return pending
  })
}

module.exports = { filename, appliedOf, read, append, acknowledge }
