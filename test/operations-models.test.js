'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const sqlite=require('sqlite3');
const {run,close}=require('../scripts/sqlite-tools');
const {backup,verify,restore}=require('../scripts/backup');
const {holdOutFinalRound}=require('../scripts/backtest');
const {predictPlayerRank}=require('../prediction-engine');
const {rankingRule}=require('../prediction-rules');
const {createTelemetry,healthAlerts}=require('../operations');
const {genericAssociationRule,decidePromotion}=require('../promotions');
const {check}=require('../scripts/ops-check');
const {databaseFixture}=require('./helpers/database');
const game=(bout,a,b)=>({bout,p1_id:a,p2_id:b,p1_result:'1',p2_result:'2',p1_score:2,p2_score:0});
const rows=[game(1,'1','4'),game(1,'2','3'),game(2,'1','3'),game(2,'2','4'),game(3,'1','2'),game(3,'3','4')];
const players=[3,2,1,0].map((win,i)=>({id:String(i+1),name:String(i+1),win,lose:3-win,draw:0,score:2*win,cloud_rank:i+1}));

test('historical backtest removes final outcomes, scores, wins and official ranks',()=>{
  const snapshot=holdOutFinalRound(players,rows);
  assert.equal(snapshot.players[0].score,4);
  assert.equal(snapshot.players[0].win,2);
  assert.ok(snapshot.players.every(p=>p.cloud_rank===0));
  assert.ok(snapshot.matchData.rows.filter(r=>r.bout===3).every(r=>r.p1_result==='' && r.p1_score===0 && r.p2_score===0));
  assert.equal(rows.at(-1).p1_result,'1','source must not be mutated');
  assert.throws(()=>holdOutFinalRound(players.map(p=>({...p,score:99})),rows),/must agree/);
});

test('prediction seed and fingerprint reproduce outcomes across upstream row order',()=>{
  const snapshot=holdOutFinalRound(players,rows);
  const options={snapshot,groupId:'1',participantId:'2',simulations:250};
  const a=predictPlayerRank(options);
  const b=predictPlayerRank({...options,snapshot:{...snapshot,players:[...snapshot.players].reverse(),
    matchData:{...snapshot.matchData,rows:[...snapshot.matchData.rows].reverse()}}});
  assert.deepEqual(a.model,b.model);
  assert.deepEqual(a.probabilities,b.probabilities);
  assert.equal(a.assumptions.ranking.verified,false);
  assert.equal(rankingRule().source,'unverified-default');
  assert.equal(rankingRule('score-opponent-score').source,'user-assumption');
  assert.throws(()=>rankingRule('invented'));
});

test('provincial rules record source, dates and minimum field/round requirements',()=>{
  const row={title:'河北省围棋段位赛',provincename:'河北省',min_time:'2025-01-01',win:7,lose:0};
  const level={kind:'dan',current:3};
  const rule=genericAssociationRule(row,level);
  assert.match(rule.provenance.source_url,/sport.hebei.gov.cn/);
  assert.equal(rule.provenance.effective_from,'2017-10-01');
  assert.equal(genericAssociationRule({...row,min_time:'2017-09-30'},level),null);
  assert.equal(genericAssociationRule({...row,title:'河北省围棋公益赛'},level),null);
  assert.equal(decidePromotion({row,rule,level,stats:{rank:1,groupSize:19}}).promoted,false);
  assert.equal(decidePromotion({row,rule,level,stats:{rank:1,groupSize:33}}).promoted,false);
  assert.equal(decidePromotion({row:{...row,win:9},rule,level,stats:{rank:1,groupSize:33}}).promoted,true);
});

test('bounded operational telemetry omits personal queries and detects data/latency failures',()=>{
  let time=0;const logs=[];
  const telemetry=createTelemetry({clock:()=>time,log:r=>logs.push(r)});
  for(let i=0;i<510;i++) {
    const res=new EventEmitter();res.statusCode=502;res.setHeader=()=>{};
    telemetry.middleware({path:'/api/search',url:'/api/search?name=private'},res,()=>{});
    time+=11000;res.emit('finish');
  }
  const requests=telemetry.snapshot();
  assert.equal(requests[0].sample_count,500);
  assert.doesNotMatch(JSON.stringify(logs),/private|name=/);
  const alerts=healthAlerts({coverage:{failedEventCount:1},cache:{missing_round_groups:1},requests});
  for(const code of ['INDEX_INCOMPLETE','CACHE_MISSING_ROUNDS','STALE_INDEX','REQUEST_ERRORS','REQUEST_LATENCY']) assert.ok(alerts.some(a=>a.code===code));
});

test('operational checks refuse to send an admin secret over public HTTP',async()=>{
  await assert.rejects(check('http://example.com','test-only'),/HTTPS/);
});

test('cache monitoring measures missing interior rounds rather than only the latest round',async t=>{
  const db=await databaseFixture(t);
  for(const [group,bouts] of [['complete',[1,2,3]],['missing',[1,3]]]) {
    await db.run('INSERT INTO group_match_cache_status(group_id,rounds,updated_at) VALUES(?,3,100)',[group]);
    for(const bout of bouts) await db.run('INSERT INTO group_match_cache(group_id,bout,p1_id,p2_id) VALUES(?,?,?,?)',[group,bout,'1','2']);
  }
  const health=await db.getOperationalCacheHealth();
  assert.equal(health.cached_groups,2);
  assert.equal(health.missing_round_groups,1);
  assert.equal(health.missing_round_rate,0.5);
});

test('the single strength engine keeps the 180-day boundary and returns its version even with no estimate',async()=>{
  const vm=require('node:vm');const root=path.resolve(__dirname,'..');const selected=[];
  const sandbox={module:{exports:{}},console,process:{env:{}},require:name=>name==='./db'?{
    queryParticipants:()=>{throw new Error('Must use the selected identity records');},
    queryParticipantsForGroups:async ids=>{selected.push(...ids);return [];},
  }:require(name.startsWith('.')?path.join(root,name):name)};
  vm.runInNewContext(fs.readFileSync(path.join(root,'strength.js'),'utf8'),sandbox);
  const row=(group_id,min_time)=>({group_id,min_time,participant_id:'1',group_name:'5段组',win:4,lose:3});
  const result=await sandbox.module.exports.estimatePlayerStrength({name:'test',dateTo:'2026-09-28',identityRows:[
    row('boundary','2026-04-01'),row('too-old','2026-03-31'),row('future','2026-09-29'),
  ]});
  assert.deepEqual([...new Set(selected)],['boundary']);
  assert.equal(result.model.window_days,180);
  assert.equal(result.model.engine,'server-graph');
  assert.equal(result.model.version,require('../model-versions').strength);
});

test('online backup is consistent, restore verifies records, existing destinations and tampering fail closed',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'go-search-backup-test-'));
  t.after(()=>{
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('go-search-backup-test-'));
    fs.rmSync(dir,{recursive:true,force:true});
  });
  const source=path.join(dir,'source.db');const db=new sqlite.Database(source);
  try {
    await run(db,'PRAGMA journal_mode=WAL');
    for(const table of ['events','event_groups','participant_index','group_match_cache','event_notice_cache','live_pairing_overrides']) {
      await run(db,`CREATE TABLE ${table}(id INTEGER)`);await run(db,`INSERT INTO ${table} VALUES(1)`);
    }
    const dest=path.join(dir,'backup');const manifest=await backup(source,dest);
    assert.equal(manifest.counts.events,1);
    await run(db,'INSERT INTO events VALUES(2)');
    assert.equal((await verify(dest)).counts.events,1);
    const restored=await restore(dest,path.join(dir,'restored'));
    assert.equal(restored.counts.events,1);
    await assert.rejects(restore(dest,path.join(dir,'restored')),/EEXIST/);
    fs.appendFileSync(path.join(dest,'yunbisai.db'),'tampering');
    await assert.rejects(verify(dest),/checksum/);
  } finally {await close(db);}
});
