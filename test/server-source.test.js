'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadServer(overrides = {}, { clock = Date } = {}) {
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
  const sandbox = { console, Buffer, URLSearchParams, Date:clock, Math, setTimeout, clearTimeout,
    __dirname: root, process: { env: { ROAD19_SYNC_ENABLED: '1' } },
    require(name) {
      dependencies.push(name);
      if (Object.hasOwn(mocks, name)) return mocks[name];
      return require(name.startsWith('.') ? path.join(root, name) : name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), sandbox);
  return { routes, scheduled, dependencies, doSearch:sandbox.doSearch };
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
  assert.deepEqual(scheduled, ['30 2 * * *', '15 * * * *']);
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

test('status coalesces coverage reads without scanning the participant storage table',async()=>{
  let calls=0;
  const {routes}=loadServer({'./db':{
    initPromise:new Promise(()=>{}),
    getStats:async()=>{throw new Error('Full storage statistics must not run on the status path');},
    getIndexCoverage:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,10));return {eventCount:10,indexedEventCount:9};},
  }});
  const results=[response(),response(),response()];
  await Promise.all(results.map(res=>routes.get('/api/system-status')({},res)));
  assert.equal(calls,1);
  for(const res of results) {assert.equal(res.statusCode,200);assert.equal(res.body.coverage,0.9);}
  const again=response();await routes.get('/api/system-status')({},again);
  assert.equal(calls,1);
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

test('event round confirmation applies to every group and overrides old direct prediction requests',async()=>{
  const calls=[];
  const {routes}=loadServer({
    './db':{initPromise:new Promise(()=>{}),getLivePairingOverrides:async()=>[]},
    'node-fetch':async url=>{
      const u=new URL(url);calls.push(u);
      const players=[{participantid:'1',participantname:'Alpha',vicsum:'3',faisum:'2',deusum:'0',integral:'6'},
        {participantid:'2',participantname:'Beta',vicsum:'2',faisum:'3',deusum:'0',integral:'4'},
        {participantid:'3',participantname:'Absent',vicsum:'0',faisum:'0',deusum:'0',integral:'0'}];
      let body;
      if(u.pathname.includes('/competition/')) body={error:0,datArr:[]};
      else if(u.pathname.endsWith('/Eventpart')) body={error:0,datArr:{rows:players}};
      else {
        const bout=Number(u.searchParams.get('bout'));
        const returnedBout=Math.min(bout,6);
        const result=returnedBout<=3?'1':returnedBout<=5?'2':'0';
        const rows=[{againstplanid:String(returnedBout),p1id:'1',p2id:'2',p1:'Alpha',p2:'Beta',
          p1_result:result,p2_result:result==='1'?'2':result==='2'?'1':'0',p1_score:result==='1'?2:0,p2_score:result==='2'?2:0}];
        if(bout===6) await new Promise(resolve=>setTimeout(resolve,10));
        if(bout===1) rows.push({againstplanid:'absence',p1id:'3',p2id:'0',p1:'Absent',p1_result:'4',p1_score:0,p2_score:0});
        body={error:0,datArr:{eventid:'70886',total_bout:'6',lastbout:'6',rows}};
      }
      return {ok:true,text:async()=>`cb(${JSON.stringify(body)});`};
    },
  });
  for(const group of ['349071','349072','349073','349074','349075','349076']) {
    const res=response();await routes.get('/api/live-group')({query:{group_id:group,total_rounds:'6'}},res);
    assert.equal(res.statusCode,200);
    assert.equal(res.body.total_rounds,7);
    assert.equal(res.body.total_rounds_source,'event-config');
    assert.equal(res.body.completed_rounds,5);
    assert.equal(res.body.known_pairing_rounds,6);
    assert.equal(res.body.prediction_available,true);
    assert.equal(res.body.players.find(p=>p.id==='3').score,0);
  }
  const prediction=response();await routes.get('/api/live-prediction')({query:{group_id:'349073',participant_id:'1',total_rounds:'6',simulations:'200'}},prediction);
  assert.equal(prediction.statusCode,200);
  assert.equal(prediction.body.total_rounds,7);
  assert.equal(prediction.body.completed_rounds,5);
  assert.equal(prediction.body.next_opponent.id,'2');
  assert.equal(prediction.body.next_opponent.bout,6);
  assert.equal(prediction.body.model.pairing_players,2);
  assert.ok(calls.some(u=>u.searchParams.get('bout')==='7'));
});

test('published final results reconcile a stale live feed and disable further prediction scenarios',async()=>{
  const {publishedFixture,entry}=require('./helpers/published-results');
  const {parsePublishedResults}=require('../yunbisai-results');
  const report=parsePublishedResults(publishedFixture(),'8',entry);
  const {routes}=loadServer({
    './db':{initPromise:new Promise(()=>{}),getLivePairingOverrides:async()=>[]},
    'node-fetch':async url=>{
      const u=new URL(url);let body;
      if(u.pathname==='/api/competition/results/group/8') body={error:0,datArr:[entry]};
      else if(u.pathname==='/api/competition/group/results/99') body=publishedFixture();
      else if(u.pathname.endsWith('/Eventpart')) body={error:0,datArr:{rows:report.players.map(p=>{
        const games=report.rows.filter(row=>row.bout<=2&&(row.p1_id===p.id||row.p2_id===p.id));
        let win=0,lose=0;
        for(const row of games){const result=row.p1_id===p.id?row.p1_result:row.p2_result;if(result==='1')win++;if(result==='2')lose++;}
        return {participantid:p.id,participantname:p.name,short:p.short_no,vicsum:win,faisum:lose,deusum:0,integral:win*2,compositor:5};
      })}};
      else if(u.pathname.endsWith('/Againstplan')) {
        const bout=Math.min(Number(u.searchParams.get('bout')),3);
        const rows=report.rows.filter(row=>row.bout===bout).map(row=>({againstplanid:`${row.bout}:${row.seat}`,
          p1id:row.p1_id,p2id:row.p2_id==='__live_bye__'?'0':row.p2_id,p1:row.p1_name,p2:row.p2_name,
          p1_result:bout===3?'0':row.p1_result,p2_result:bout===3?'0':row.p2_result,
          p1_score:bout===3?0:row.p1_score,p2_score:bout===3?0:row.p2_score}));
        body={error:0,datArr:{eventid:'1',total_bout:'3',lastbout:3,rows}};
      } else throw new Error('Unexpected request '+u.pathname);
      return {ok:true,text:async()=>JSON.stringify(body)};
    },
  });
  const group=response();await routes.get('/api/live-group')({query:{group_id:'8',total_rounds:'6'}},group);
  assert.equal(group.statusCode,200);
  assert.equal(group.body.results_final,true);
  assert.equal(group.body.prediction_available,false);
  assert.equal(group.body.total_rounds,3);
  const alpha=group.body.players.find(p=>p.id==='1');
  assert.equal(alpha.score,4);
  assert.equal(alpha.display_rank,2);
  const result=response();await routes.get('/api/live-prediction')({query:{group_id:'8',participant_id:'1',total_rounds:'6',next_result:'loss'}},result);
  assert.equal(result.statusCode,200);
  assert.equal(result.body.results_final,true);
  assert.equal(result.body.next_opponent,null);
  assert.equal(result.body.current.rank,2);
  assert.equal(result.body.current.rank_max,2);
  assert.equal(result.body.probabilities[0].rank,2);
  assert.equal(result.body.total_rounds,3);
});

test('a failed legacy feed can fall back to an already verified post-event published table',async()=>{
  const {publishedFixture,entry}=require('./helpers/published-results');
  const {parsePublishedResults}=require('../yunbisai-results');
  const report={...parsePublishedResults(publishedFixture(),'8',entry),ended_at:'2026-10-07 19:30:00',verified_final:true};
  const {routes}=loadServer({
    './db':{initPromise:new Promise(()=>{}),getLivePairingOverrides:async()=>[],getPublishedGroupResult:async()=>report},
    'node-fetch':async()=>{throw new Error('legacy feed unavailable');},
  });
  const result=response();await routes.get('/api/live-group')({query:{group_id:'8'}},result);
  assert.equal(result.statusCode,200);
  assert.equal(result.body.results_final,true);
  assert.ok(result.body.data_warning);
  assert.equal(result.body.players.find(p=>p.id==='1').display_rank,2);
});

test('live refresh reuses history, rejects an incomplete resolved sheet, and expires stale fallback', async () => {
  const {publishedFixture,entry}=require('./helpers/published-results');
  const {parsePublishedResults}=require('../yunbisai-results');
  const {createLiveRoundCache}=require('../live-round-cache');
  const report=parsePublishedResults(publishedFixture(),'8',entry);
  let now=100000, broken=false; const rounds=[];
  class Clock extends Date { static now() { return now; } }
  const {routes}=loadServer({
    './db':{initPromise:new Promise(()=>{}),getLivePairingOverrides:async()=>[]},
    './live-round-cache':{createLiveRoundCache:options=>createLiveRoundCache({...options,now:()=>now})},
    'node-fetch':async url=>{
      const u=new URL(url); let body;
      if(u.pathname.includes('/competition/')) body={error:0,datArr:[]};
      else if(u.pathname.endsWith('/Eventpart')) body={error:0,datArr:{rows:report.players.map(player=>({
        participantid:player.id,participantname:player.name,vicsum:player.win,faisum:player.lose,deusum:player.draw,
        integral:player.score,compositor:player.cloud_rank,short:player.short_no }))}};
      else if(u.pathname.endsWith('/Againstplan')) {
        const bout=Number(u.searchParams.get('bout'));rounds.push(bout);
        const rows=broken && bout===3?[]:report.rows.filter(row=>row.bout===bout).map(row=>({
          againstplanid:`${bout}:${row.seat}`,p1id:row.p1_id,p2id:row.p2_id==='__live_bye__'?'0':row.p2_id,
          p1:row.p1_name,p2:row.p2_name,p1_result:row.p1_result,p2_result:row.p2_result,
          p1_score:row.p1_score,p2_score:row.p2_score }));
        body={error:0,datArr:{eventid:'1',total_bout:4,rows}};
      } else throw new Error('Unexpected URL '+url);
      return {ok:true,text:async()=>JSON.stringify(body)};
    },
  },{clock:Clock});
  const read=async()=>{const res=response();await routes.get('/api/live-group')({query:{group_id:'8'}},res);return res;};
  const first=await read();assert.equal(first.statusCode,200);assert.equal(first.body.prediction_available,true);
  assert.equal(first.body.freshness.results_changed_at,null);
  rounds.length=0; now+=10001;
  const fresh=await read();assert.equal(fresh.statusCode,200);
  assert.equal(rounds.includes(2),false);assert.equal(rounds.includes(3),true);
  assert.equal(fresh.body.freshness.history_checked_at,100000);
  now+=10001; broken=true;
  const stale=await read();assert.equal(stale.statusCode,200);assert.equal(stale.body.freshness.stale,true);
  assert.equal(stale.body.snapshot_at,fresh.body.snapshot_at);
  assert.match(stale.body.data_warning,/上次校验/);
  now+=120001;
  const expired=await read();assert.equal(expired.statusCode,502);
});

test('an unindexed search hit uses verified published scores instead of an older SearchInfo snapshot',async()=>{
  const {publishedFixture,entry}=require('./helpers/published-results');
  const {doSearch}=loadServer({'node-fetch':async url=>{
    const u=new URL(url);let body;
    if(u.pathname.endsWith('/SearchInfo')) body={error:0,datArr:[{participantid:'1',participantname:'Alpha',
      groupid:'8',groupname:'3 dan',eventid:'1',vicsum:1,faisum:1,deusum:0,integral:2}]};
    else if(u.pathname==='/api/competition/results/group/8') body={error:0,datArr:[entry]};
    else if(u.pathname==='/api/competition/group/results/99') body=publishedFixture();
    else throw new Error('Unexpected URL '+url);
    return {ok:true,text:async()=>JSON.stringify(body)};
  }});
  const hits=[];
  const result=await doSearch({event_id:'1',title:'Go',min_time:'2026-10-01'},'Alpha',hit=>hits.push(hit));
  assert.equal(result.ok,true);
  assert.equal(hits.length,1);
  assert.equal(hits[0].player.score,4);
  assert.equal(hits[0].player.win,2);
  assert.equal(hits[0].player.rank,'2');
});
