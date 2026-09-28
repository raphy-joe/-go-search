'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {open,all,run,close} = require('./sqlite-tools');
const versions = require('../model-versions');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function inspect(file) {
  const db = await open(file);
  try {
    const integrity = await all(db,'PRAGMA integrity_check');
    if(integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new Error('SQLite integrity check failed');
    const schema = await all(db,"SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name");
    const counts = {};
    for(const table of ['events','event_groups','participant_index','group_match_cache','event_notice_cache','live_pairing_overrides']) {
      counts[table] = (await all(db,`SELECT COUNT(*) AS n FROM ${table}`))[0].n;
    }
    return {schema_sha256:crypto.createHash('sha256').update(JSON.stringify(schema)).digest('hex'),counts};
  } finally {await close(db);}
}
function newDestination(directory) {
  const dest = path.resolve(directory);
  fs.mkdirSync(dest); // Exclusive: an existing directory, including a live DATA_DIR, is never reused.
  return dest;
}
async function backup(source,directory) {
  source=path.resolve(source);
  const db=await open(source);
  let dest;
  try {
    dest=newDestination(directory);
    await run(db,'VACUUM INTO ?',[path.join(dest,'yunbisai.db')]);
  } finally {await close(db);}
  const file=path.join(dest,'yunbisai.db');
  const manifest={format:1,created_at:new Date().toISOString(),models:versions,sha256:hash(file),...await inspect(file)};
  fs.writeFileSync(path.join(dest,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
  return manifest;
}
async function verify(directory) {
  const file=path.join(path.resolve(directory),'yunbisai.db');
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  if(manifest.format!==1 || hash(file)!==manifest.sha256) throw new Error('Backup checksum mismatch');
  const actual=await inspect(file);
  if(actual.schema_sha256!==manifest.schema_sha256 || JSON.stringify(actual.counts)!==JSON.stringify(manifest.counts)) {
    throw new Error('Backup schema or record counts mismatch');
  }
  return manifest;
}
async function restore(directory,destination) {
  const manifest=await verify(directory);
  const dest=newDestination(destination);
  const file=path.join(dest,'yunbisai.db');
  fs.copyFileSync(path.join(directory,'yunbisai.db'),file,fs.constants.COPYFILE_EXCL);
  if(hash(file)!==manifest.sha256) throw new Error('Restored database checksum mismatch');
  const actual=await inspect(file);
  if(actual.schema_sha256!==manifest.schema_sha256 || JSON.stringify(actual.counts)!==JSON.stringify(manifest.counts)) throw new Error('Restore verification failed');
  return {restored_to:dest,...actual};
}
if(require.main===module) {
  const [command,source,destination]=process.argv.slice(2);
  const task=command==='backup' && source && destination ? backup(source,destination)
    : command==='verify' && source && !destination ? verify(source)
    : command==='restore' && source && destination ? restore(source,destination)
    : Promise.reject(new Error('Usage: node scripts/backup.js backup DB NEW_DIR | verify BACKUP_DIR | restore BACKUP_DIR NEW_DIR'));
  task.then(result=>console.log(JSON.stringify(result,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
module.exports={backup,verify,restore};
