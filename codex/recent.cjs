const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const child = require('node:child_process')
const { clean } = require('../shared/sanitize.js')

function latest(cwd, all, includeNonInteractive, env = process.env) {
  const home = env.CODEX_HOME || path.join(os.homedir(), '.codex')
  let files
  try { files = fs.readdirSync(home).filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0])) }
  catch { return null }
  if (!files.length) return null
  const reader = `
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(process.argv[1],{readOnly:true});
    try {
      const columns=new Set(db.prepare('PRAGMA table_info(threads)').all().map(row=>row.name));
      const conditions=['archived = 0'];
      const values=[];
      if(process.argv[3] !== 'true'){conditions.push('cwd = ?');values.push(process.argv[2])}
      if(process.argv[4] !== 'true')conditions.push("source IN ('cli','vscode','appServer','desktop')");
      const order=columns.has('updated_at_ms')?'COALESCE(updated_at_ms,updated_at*1000)':'updated_at';
      const row=db.prepare('SELECT id FROM threads WHERE '+conditions.join(' AND ')+' ORDER BY '+order+' DESC, created_at DESC LIMIT 1').get(...values);
      if(row)process.stdout.write(row.id);
    } finally {db.close()}
  `
  const result = child.spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', reader, path.join(home, files[0]), cwd, String(all), String(includeNonInteractive)], { encoding: 'utf8', timeout: 2000, env })
  const id = result.stdout?.trim()
  return result.status === 0 && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id || '') ? id : null
}

// The working folder and title of each Codex thread named, from the newest state database, as a
// map from thread id to { cwd, title }; empty when the database cannot be read.
function threads(ids, env = process.env) {
  const home = env.CODEX_HOME || path.join(os.homedir(), '.codex')
  let files
  try { files = fs.readdirSync(home).filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0])) }
  catch { return new Map() }
  if (!files.length || !ids.length) return new Map()
  const reader = `
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(process.argv[1],{readOnly:true});
    try {
      const columns=new Set(db.prepare('PRAGMA table_info(threads)').all().map(row=>row.name));
      const title=['name','title','first_user_message'].filter(column=>columns.has(column)).map(column=>"NULLIF("+column+",'')");
      const ids=JSON.parse(process.argv[2]);
      const rows=db.prepare('SELECT id, cwd, '+(title.length?'COALESCE('+title.join(',')+')':'NULL')+' AS title FROM threads WHERE id IN ('+ids.map(()=>'?').join(',')+')').all(...ids);
      process.stdout.write(JSON.stringify(rows));
    } finally {db.close()}
  `
  const result = child.spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', reader, path.join(home, files[0]), JSON.stringify(ids)], { encoding: 'utf8', timeout: 2000, env })
  const found = new Map()
  if (result.status !== 0) return found
  try {
    for (const row of JSON.parse(result.stdout)) {
      const detail = {}
      if (typeof row.cwd === 'string' && row.cwd) detail.cwd = row.cwd
      if (typeof row.title === 'string' && row.title.trim()) detail.title = clean(row.title).slice(0, 80)
      found.set(row.id, detail)
    }
  } catch { /* An unreadable answer counts as no details. */ }
  return found
}

module.exports = { latest, threads }
