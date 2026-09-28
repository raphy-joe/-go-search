'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadServer(overrides = {}) {
  const routes = new Map();
  const scheduled = [];
  const dependencies = [];
  const app = { set() {}, use() {}, listen() {},
    get(route, handler) { routes.set(route, handler); }, post(route, ...handlers) { routes.set(route, handlers.at(-1)); } };
  const express = Object.assign(() => app, { static: () => () => {}, json: () => () => {} });
  const indexed = [{ event_id: '42', title: 'Go test event', min_time: '2026-08-01',
    participant_id: '11', participant_name: 'Alpha', group_id: '12', group_name: 'A', win: 1, lose: 0 }];
  const db = {
    initPromise: new Promise(() => {}),
    getStats: async () => ({ lastUpdated: 1 }),
    getIndexCoverage: async () => ({ eventCount: 1, indexedEventCount: 1, unindexedEventCount: 0 }),
    queryParticipants: async () => indexed,
    getIdentityNotices: async () => new Map(),
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
    ...overrides,
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

test('ambiguous identity cannot reach strength or promotion aggregation; explicit choices are filtered', async () => {
  const row = (id,province) => ({event_id:id,group_id:id,participant_id:'1',participant_name:'Alpha',
    title:'围棋段位赛',group_name:'5段组',min_time:'2026-08-01',provincename:province,win:4,lose:3});
  const rows=[row('1','四川省'),row('2','浙江省')];
  const seen=[];
  const {routes}=loadServer({
    './db':{initPromise:new Promise(()=>{}),queryParticipants:async({name})=>name==='Alpha'?rows:[{...rows[0],participant_name:name}],
      getIdentityNotices:async()=>new Map(),queryHeadToHeadCandidates:async()=>[]},
    './strength':{estimatePlayerStrength:async options=>{seen.push(options);return {available:false};}},
    './promotions':{estimatePromotionHistory:async options=>{seen.push(options);return {items:[]};}},
  });
  for(const route of ['/api/strength','/api/promotions']) {
    const blocked=response();await routes.get(route)({query:{name:'Alpha'}},blocked);
    assert.equal(blocked.statusCode,409);assert.equal(blocked.body.code,'IDENTITY_REQUIRED');
    assert.equal(seen.length,0);
    const selected=response();await routes.get(route)({query:{name:'Alpha',identity:'2:2:1'}},selected);
    assert.equal(selected.statusCode,200);assert.equal(seen.length,1);
    assert.deepEqual(seen.pop().identityRows.map(r=>r.event_id),['2']);
  }
  const res=response();await routes.get('/api/head-to-head')({query:{playerA:'Alpha',playerB:'Beta'}},res);
  assert.equal(res.body.identity_required,true);assert.equal(res.body.identities.a.length,2);
});

test('administrator background tasks outlive the initiating request context', async () => {
  const {requestContext}=require('../api-security');const signals=[];
  const {routes}=loadServer({
    './indexer':{getState:()=>({running:false}),runIndex:async()=>signals.push(requestContext.getStore())},
  });
  const controller=new AbortController();
  requestContext.run(controller.signal,()=>routes.get('/api/index/start')({body:{}},response()));
  controller.abort();
  assert.deepEqual(signals,[undefined]);
});
