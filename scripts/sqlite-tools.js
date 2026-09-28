'use strict';
const sqlite = require('sqlite3');
function open(filename) {
  return new Promise((resolve,reject) => {
    const db = new sqlite.Database(filename, sqlite.OPEN_READONLY, error => error ? reject(error) : resolve(db));
    db.configure('busyTimeout',10000);
  });
}
const all = (db,sql,args=[]) => new Promise((resolve,reject) => db.all(sql,args,(e,rows) => e ? reject(e) : resolve(rows)));
const run = (db,sql,args=[]) => new Promise((resolve,reject) => db.run(sql,args,e => e ? reject(e) : resolve()));
const close = db => new Promise((resolve,reject) => db.close(e => e ? reject(e) : resolve()));
module.exports = {open,all,run,close};
