'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sqlite3 = require('sqlite3');
const { isPlayedMatch } = require('../match-results');

const row = bout => ({ bout, p1_id: '1', p2_id: '2', p1_result: '1', p2_result: '2', p1_score: 2, p2_score: 0 });
async function fixture(t) {
  const db = new sqlite3.Database(':memory:');
  t.after(() => new Promise(resolve => db.close(resolve)));
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, e => e ? reject(e) : resolve()));
  const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (e, rows) => e ? reject(e) : resolve(rows)));
  const get = async (sql, params) => (await all(sql, params))[0];
  await run(`CREATE TABLE group_match_cache (group_id TEXT,bout INTEGER,p1_id TEXT,p2_id TEXT,
    p1_name TEXT,p2_name TEXT,p1_org TEXT,p2_org TEXT,p1_result TEXT,p2_result TEXT,
    p1_score REAL,p2_score REAL,updated_at INTEGER,PRIMARY KEY(group_id,bout,p1_id,p2_id))`);
  await run('CREATE TABLE group_match_cache_status (group_id TEXT PRIMARY KEY,rounds INTEGER,updated_at INTEGER,last_error TEXT)');
  let lock = Promise.resolve();
  const withWriteLock = fn => { const next = lock.then(fn, fn); lock = next.catch(() => {}); return next; };
  const source = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');
  const code = source.slice(source.indexOf('async function replaceGroupMatchCache('), source.indexOf('async function upsertIndexedEvent('));
  const context = { run, all, get, withWriteLock, initPromise: Promise.resolve(), isPlayedMatch, Date, Map };
  vm.runInNewContext(code, context);
  return { write: input => context.replaceGroupMatchCache({ group_id: '8', preserveCoverage: true, ...input }),
    rows: () => all('SELECT * FROM group_match_cache ORDER BY bout'), status: () => get('SELECT * FROM group_match_cache_status') };
}

test('shorter writes cannot reduce stored round coverage or change freshness', async t => {
  const f = await fixture(t);
  await f.write({ rounds: 3, rows: [row(1), row(2), row(3)], updated_at: 10 });
  assert.equal(await f.write({ rounds: 1, rows: [row(1)], updated_at: 20 }), false);
  assert.equal((await f.rows()).length, 3);
  assert.equal((await f.status()).updated_at, 10);
});

test('missing rows within an existing round are rejected atomically', async t => {
  const f = await fixture(t);
  await f.write({ rounds: 1, rows: [row(1), { ...row(1), p1_id: '3', p2_id: '4' }] });
  assert.equal(await f.write({ rounds: 1, rows: [row(1)] }), false);
  assert.equal((await f.rows()).length, 2);
});

test('concurrent longer and shorter writes retain the longer cache', async t => {
  const f = await fixture(t);
  const result = await Promise.all([
    f.write({ rounds: 3, rows: [row(1), row(2), row(3)] }),
    f.write({ rounds: 1, rows: [row(1)] }),
  ]);
  assert.deepEqual(result, [true, false]);
  assert.equal((await f.rows()).length, 3);
});

test('unknown outcomes cannot erase previously known results', async t => {
  const f = await fixture(t);
  await f.write({ rounds: 1, rows: [row(1)] });
  assert.equal(await f.write({ rounds: 1, rows: [{ ...row(1), p1_result: '0', p2_result: '0', p1_score: 0, p2_score: 0 }] }), false);
  assert.equal((await f.rows())[0].p1_result, '1');
});

test('complete known outcome corrections and additional rounds can be stored', async t => {
  const f = await fixture(t);
  await f.write({ rounds: 1, rows: [row(1)] });
  assert.equal(await f.write({ rounds: 2, rows: [{ ...row(1), p1_result: '2', p2_result: '1' }, row(2)] }), true);
  assert.equal((await f.rows())[0].p1_result, '2');
  assert.equal((await f.rows()).length, 2);
});
