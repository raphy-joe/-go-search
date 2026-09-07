'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadServer() {
  const routes = new Map();
  const scheduled = [];
  const dependencies = [];
  const app = { set() {}, use() {}, listen() {},
    get(route, handler) { routes.set(route, handler); }, post() {} };
  const express = Object.assign(() => app, { static: () => () => {}, json: () => () => {} });
  const indexed = [{ event_id: '42', title: 'Go test event', min_time: '2026-08-01',
    participant_id: '11', participant_name: 'Alpha', group_id: '12', group_name: 'A', win: 1, lose: 0 }];
  const db = {
    initPromise: new Promise(() => {}),
    getStats: async () => ({ lastUpdated: 1 }),
    getIndexCoverage: async () => ({ eventCount: 1, indexedEventCount: 1, unindexedEventCount: 0 }),
    queryParticipants: async () => indexed,
    queryUnindexedEvents: async () => [],
    queryHeadToHeadCandidates: async () => [],
  };
  const mocks = {
    express,
    'node-fetch': () => { throw new Error('Unexpected upstream request'); },
    'node-cron': { schedule: expression => scheduled.push(expression) },
    './db': db,
    './crawler': { getState: () => ({ running: false }) },
    './indexer': { getState: () => ({ running: false }) },
    './strength': {}, './promotions': {},
  };
  const root = path.resolve(__dirname, '..');
  const sandbox = { console, Buffer, URLSearchParams, Date, Math, setTimeout, clearTimeout,
    __dirname: root, process: { env: { ROAD19_SYNC_ENABLED: '1' } },
    require(name) {
      dependencies.push(name);
      if (Object.hasOwn(mocks, name)) return mocks[name];
      return require(name.startsWith('.') ? path.join(root, name) : name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), sandbox);
  return { routes, scheduled, dependencies };
}

function response() {
  return { statusCode: 200, body: null, chunks: [], setHeader() {}, on() {}, end() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    write(chunk) { this.chunks.push(chunk); },
  };
}

test('server starts without source integration even with its former environment flag', () => {
  const { scheduled, dependencies } = loadServer();
  assert.deepEqual(scheduled, ['30 2 * * *']);
  assert.equal(dependencies.some(name => /road19|source-records/.test(name)), false);
});

test('search only emits Yunbisai index hits and no merged-source status', async () => {
  const { routes } = loadServer();
  const res = response();
  await routes.get('/api/search')({ query: { name: 'Alpha', province: '__ALL__', yearFrom: '2026', yearTo: '2026' } }, res);
  const records = res.chunks.map(chunk => JSON.parse(chunk.slice(6).trim()));
  const hits = records.filter(record => record.type === 'hit');
  assert.equal(hits.length, 1);
  assert.equal(String(hits[0].event.event_id), '42');
  assert.equal(records.at(-1).type, 'done');
  assert.equal(records.some(record => record.type === 'source-status'), false);
});

test('retired source identifiers cannot reach upstream match requests', async () => {
  const { routes } = loadServer();
  const res = response();
  await routes.get('/api/matches')({ query: { group_id: '19road:event:group', player_id: '19road:player', rounds: '9' } }, res);
  assert.equal(res.statusCode, 400);
});

test('status and head-to-head responses contain no merged-source metadata', async () => {
  const { routes } = loadServer();
  const status = response();
  await routes.get('/api/system-status')({}, status);
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.indexed_events, 1);
  assert.equal(Object.hasOwn(status.body, 'sources'), false);
  const h2h = response();
  await routes.get('/api/head-to-head')({ query: { playerA: 'Alpha', playerB: 'Beta' } }, h2h);
  assert.equal(h2h.statusCode, 200);
  assert.equal(h2h.body.summary.games, 0);
  assert.equal(Object.hasOwn(h2h.body, 'source_coverage'), false);
});
