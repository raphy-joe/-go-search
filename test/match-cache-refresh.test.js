'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { assessYunMatches } = require('../result-quality');

const match = bout => ({ group_id: '8', bout, p1_id: '1', p2_id: '2', p1_name: 'A', p2_name: 'B', p1_result: '1', p2_result: '2', p1_score: 2, p2_score: 0 });
const upstream = bout => ({ p1id: '1', p2id: '2', p1: 'A', p2: 'B', p1_result: '1', p2_result: '2', p1_score: 2, p2_score: 0 });
const oldCache = (rows = [match(1), match(2), match(3)], updated_at = Date.now() - 8 * 86400000) => ({ rows, status: { rounds: 3, updated_at, last_error: '' } });

function load({ cache = { rows: [], status: null }, response, storeResult = true, persisted } = {}) {
  const calls = [], writes = [], qualityChecks = [];
  let current = cache;
  const app = { set() {}, use() {}, listen() {}, get() {}, post() {} };
  const express = Object.assign(() => app, { static: () => () => {}, json: () => () => {} });
  const db = {
    initPromise: new Promise(() => {}),
    getGroupMatchCache: async () => current,
    replaceGroupMatchCache: async input => {
      writes.push(input);
      current = storeResult ? { rows: input.rows, status: { rounds: input.rounds, updated_at: Date.now(), last_error: '' } } : persisted;
      return storeResult;
    },
    updateGroupResultQuality: async (_group, rows) => {
      const result = assessYunMatches(rows);
      qualityChecks.push(result);
      return result;
    },
  };
  const mocks = { express, './db': db, './crawler': {}, './indexer': {}, './strength': {}, './promotions': {},
    'node-cron': { schedule() {} },
    'node-fetch': async url => {
      const bout = Number(new URL(url).searchParams.get('bout'));
      calls.push(bout);
      const data = response ? await response(bout, calls) : { error: 0, datArr: { rows: [upstream(bout)] } };
      return { ok: true, text: async () => `cb(${JSON.stringify(data)})` };
    },
  };
  const root = path.resolve(__dirname, '..');
  const sandbox = { Buffer, URLSearchParams, Date, Math, console: { log() {}, warn() {}, error() {} },
    setTimeout: callback => setTimeout(callback, 0), clearTimeout,
    __dirname: root, process: { env: {} },
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name.startsWith('.') ? path.join(root, name) : name),
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), sandbox);
  return { run: rounds => sandbox.getOrFetchGroupMatches('8', rounds), calls, writes, qualityChecks };
}

test('business errors are retried before a complete cache is saved', async () => {
  let attempts = 0;
  const fixture = load({ response: bout => bout === 2 && ++attempts === 1
    ? { error: 1, msg: 'wait' } : { error: 0, datArr: { rows: [upstream(bout)] } } });
  const rows = await fixture.run(3);
  assert.equal(rows.length, 3);
  assert.equal(fixture.calls.filter(n => n === 2).length, 2);
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.writes[0].preserveCoverage, true);
});

test('persistent empty rounds cannot overwrite or quarantine a complete stale cache', async () => {
  const fixture = load({ cache: oldCache(), response: bout => ({ error: 0, datArr: { rows: bout === 2 ? [] : [upstream(bout)] } }) });
  assert.equal((await fixture.run(3)).length, 3);
  assert.equal(fixture.calls.filter(n => n === 2).length, 3);
  assert.equal(fixture.writes.length, 0);
  assert.ok(fixture.qualityChecks.every(q => q.eligible));
});

test('a cold partial download fails without persisting data or exclusions', async () => {
  const fixture = load({ response: bout => ({ error: 0, datArr: { rows: bout === 2 ? [] : [upstream(bout)] } }) });
  await assert.rejects(fixture.run(3), /INCOMPLETE_MATCH_ROUND/);
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.qualityChecks.length, 0);
});

test('a fresh cache with an interior hole is refetched before quality assessment', async () => {
  const fixture = load({ cache: oldCache([match(1), match(3)], Date.now()) });
  assert.equal((await fixture.run(3)).length, 3);
  assert.equal(fixture.writes.length, 1);
  assert.ok(fixture.qualityChecks.every(q => q.eligible));
});

test('smaller requests retain and refresh all previously cached rounds', async () => {
  const fixture = load({ cache: oldCache() });
  assert.equal((await fixture.run(1)).length, 3);
  assert.deepEqual(fixture.calls, [1, 2, 3]);
  assert.equal(fixture.writes[0].rounds, 3);
});

test('fresh complete caches avoid unnecessary upstream requests', async () => {
  const fixture = load({ cache: oldCache(undefined, Date.now()) });
  assert.equal((await fixture.run(1)).length, 3);
  assert.equal(fixture.calls.length, 0);
});

test('atomic storage rejection returns the newer fuller cache', async () => {
  const fixture = load({ storeResult: false, persisted: oldCache(undefined, Date.now()) });
  assert.equal((await fixture.run(1)).length, 3);
  assert.equal(fixture.writes.length, 1);
});

test('repeated callers share a single in-flight group refresh', async () => {
  const fixture = load();
  await Promise.all([fixture.run(3), fixture.run(3)]);
  assert.equal(fixture.writes.length, 1);
  assert.deepEqual(fixture.calls, [1, 2, 3]);
});
