const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const child = require('node:child_process')

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

module.exports = { latest }
