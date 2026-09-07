'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('storage statistics coalesce concurrent reads and expire after 30 seconds', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  const start = source.indexOf('let statsSnapshot = null;');
  const end = source.indexOf('module.exports =', start);
  assert(start > 0 && end > start);
  const queries = [];
  let now = 100;
  const sandbox = { initPromise: Promise.resolve(), Date: { now: () => now },
    get: async sql => { queries.push(sql); return { c: 2, t: 100 }; } };
  vm.runInNewContext(source.slice(start, end) + '\nthis.readStats = getStats;', sandbox);
  const [a, b] = await Promise.all([sandbox.readStats(), sandbox.readStats()]);
  assert.equal(a.participantCount, 2);
  assert.equal(b.participantCount, 2);
  assert.equal(queries.length, 5);
  a.participantCount = 999;
  assert.equal((await sandbox.readStats()).participantCount, 2);
  assert.equal(queries.length, 5);
  assert(queries.every(sql => !sql.includes('go_participant_index')));
  now += 30001;
  await sandbox.readStats();
  assert.equal(queries.length, 10);
});
