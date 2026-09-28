'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sqlite3 = require('sqlite3');

async function databaseFixture(t, setup) {
  const connection = new sqlite3.Database(':memory:');
  const run = (sql, params = []) => new Promise((resolve,reject) => connection.run(sql,params,e => e ? reject(e) : resolve()));
  const all = (sql, params = []) => new Promise((resolve,reject) => connection.all(sql,params,(e,rows) => e ? reject(e) : resolve(rows)));
  if (setup) await setup(run);
  const root = path.resolve(__dirname, '../..');
  const sqlite = { Database:function() { return connection; } };
  sqlite.verbose = () => sqlite;
  const context = { process:{env:{}}, __dirname:root, module:{exports:{}}, console,
    require:name => name === 'sqlite3' ? sqlite : name === 'fs' ? { existsSync:()=>true }
      : require(name.startsWith('.') ? path.join(root,name) : name) };
  vm.runInNewContext(fs.readFileSync(path.join(root,'db.js'),'utf8'),context);
  await context.module.exports.initPromise;
  t.after(() => new Promise((resolve,reject) => connection.close(e => e ? reject(e) : resolve())));
  return { ...context.module.exports, run, all, one:async (sql,params) => (await all(sql,params))[0] };
}
module.exports = { databaseFixture };
