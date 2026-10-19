'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { publishedFixture, entry } = require('./helpers/published-results');
const { parsePublishedResults, validateRoster, mergePublishedMatches, createPublishedResultsClient } = require('../yunbisai-results');
const { validatePredictionSnapshot, predictPlayerRank, isResolvedLiveMatch } = require('../prediction-engine');
const { snapshotFingerprint } = require('../prediction-rules');
const { databaseFixture } = require('./helpers/database');

const parsed = () => parsePublishedResults(publishedFixture(), '8', entry);
const fetchTable = async url => JSON.stringify(url.endsWith('/results/group/8')
  ? {error:0,datArr:[entry]} : publishedFixture());

test('a complete published table reconstructs reciprocal games, cumulative scores and inactive players', () => {
  const report = parsed();
  assert.equal(report.players.length,5);
  assert.equal(report.rows.length,7);
  const alpha = report.players.find(player=>player.id==='1');
  assert.equal(alpha.score,4);
  assert.equal(alpha.win,2);
  assert.equal(alpha.lose,1);
  assert.equal(alpha.cloud_rank,2);
  assert.equal(alpha.official_total_score,4.5);
  const absence = report.rows.find(row=>row.p1_id==='5');
  assert.equal(absence.p1_score,0);
  assert.equal(absence.p1_result,'4');
  assert.ok(report.rows.every(isResolvedLiveMatch));
});

test('missing fields, duplicate identities and asymmetric opponents cannot become final results', () => {
  const missing = publishedFixture();missing.data.tabletop[0]=missing.data.tabletop[0].replace(/\u4e2a\u4eba\u79ef\u5206/g,'Unknown');
  assert.throws(()=>parsePublishedResults(missing,'8',entry),/UNSUPPORTED_RESULT_COLUMNS/);
  const duplicate = publishedFixture();duplicate.data.tabledata[1]=duplicate.data.tabledata[0];
  assert.throws(()=>parsePublishedResults(duplicate,'8',entry),/DUPLICATE_RESULT_PLAYER/);
  const asymmetric = publishedFixture();asymmetric.data.tabledata[0]=asymmetric.data.tabledata[0].replace('*2;2','*3;2');
  assert.throws(()=>parsePublishedResults(asymmetric,'8',entry),/INCONSISTENT_RESULT_PAIRINGS/);
  const partial = publishedFixture();partial.data.tabledata[0]=partial.data.tabledata[0].replace('*4;4','*4;');
  assert.throws(()=>parsePublishedResults(partial,'8',entry),/INVALID_UPSTREAM_NUMBER/);
  const unstarted=publishedFixture();
  unstarted.data.tabledata=unstarted.data.tabledata.map(value=>{
    const cells=value.split(';');for(let i=4;i<10;i++)cells[i]='';cells[10]='0';cells[11]='0';return cells.join(';');
  });
  assert.throws(()=>parsePublishedResults(unstarted,'8',entry),/INCOMPLETE_PUBLISHED_RESULTS/);
});

test('published rosters cannot omit or rewind already known participants', () => {
  const report = parsed();
  assert.throws(()=>validateRoster(report,[...report.players,{id:'7',name:'Missing',win:0,lose:0,draw:0}]),/INCOMPLETE_RESULT_ROSTER/);
  assert.throws(()=>validateRoster(report,report.players.map(p=>p.id==='1'?{...p,win:4}:p)),/STALE_OR_MISMATCHED/);
});

test('official final ranks override hypothetical rounds and remain separate from Monte Carlo forecasts', () => {
  const report = parsed();
  const snapshot = {players:report.players,matchData:{rows:report.rows,totalRounds:3,completedRounds:3,knownPairingRounds:3,
    resultsFinal:true,totalRoundsSource:'published-results',manualPairingRounds:[]},publishedResult:{id:entry.id},snapshotAt:1};
  validatePredictionSnapshot(snapshot);
  const result=predictPlayerRank({snapshot,groupId:'8',participantId:'1',simulations:1000,requestedTotalRounds:9,nextResult:'loss'});
  assert.equal(result.total_rounds,3);
  assert.equal(result.next_opponent,null);
  assert.equal(result.results_final,true);
  assert.equal(result.current.rank,2);
  assert.equal(result.current.total_score,4.5);
  assert.equal(result.probabilities.length,1);
  assert.equal(result.probabilities[0].rank,2);
  assert.equal(result.probabilities[0].probability,1);
  assert.equal(result.assumptions.ranking.verified,true);
  const fingerprint=snapshotFingerprint(snapshot);
  report.players[0].cloud_rank=3;
  assert.notEqual(snapshotFingerprint(snapshot),fingerprint);
});

test('published reconciliation retains existing black/white orientation', () => {
  const row=parsed().rows.find(row=>row.p1_id==='1');
  const old={...row,p1_id:row.p2_id,p2_id:row.p1_id};
  const [merged]=mergePublishedMatches([old],[row]);
  assert.equal(merged.p1_id,old.p1_id);
  assert.equal(merged.p1_result,row.p2_result);
  assert.equal(merged.p2_score,row.p1_score);
});

test('published table clients reject foreign groups and retain verified persistent results during failures', async () => {
  const report=parsed();
  let saved=0;
  const client=createPublishedResultsClient({getCached:async()=>report,saveCached:async()=>saved++});
  const result=await client('8',{players:report.players,fetchText:async()=>{throw new Error('network down');}});
  assert.equal(result.report.report_id,'99');
  assert.ok(result.warning);
  assert.equal(saved,0);
  const foreign=createPublishedResultsClient({saveCached:async()=>saved++});
  const rejected=await foreign('8',{fetchText:async()=>JSON.stringify({error:0,datArr:[{...entry,group_id:'9'}]})});
  assert.equal(rejected.report,null);
  assert.equal(saved,0);
});

test('complete published tables are coarsely cached without repeated upstream downloads', async () => {
  let calls=0;
  const client=createPublishedResultsClient();
  const fetchText=async url=>{calls++;return fetchTable(url);};
  assert.ok((await client('8',{fetchText})).report);
  assert.ok((await client('8',{fetchText})).report);
  assert.equal(calls,2);
});

test('explicit unscored games require a report published after the verified event end', async () => {
  const table=publishedFixture();
  const a=table.data.tabledata[0].split(';');a[9]='-';a[11]='2';table.data.tabledata[0]=a.join(';');
  const d=table.data.tabledata[3].split(';');d[9]='-';table.data.tabledata[3]=d.join(';');
  const fetchText=async url=>JSON.stringify(url.endsWith('/results/group/8')?{error:0,datArr:[entry]}:table);
  const unconfirmed=await createPublishedResultsClient()('8',{fetchText});
  assert.equal(unconfirmed.report,null);
  const confirmed=await createPublishedResultsClient()('8',{fetchText,endedAt:'2026-10-07 19:30:00'});
  assert.equal(confirmed.report.unscored_games,1);
  const snapshot={players:confirmed.report.players,matchData:{rows:confirmed.report.rows,totalRounds:3,completedRounds:3,knownPairingRounds:3,resultsFinal:true}};
  validatePredictionSnapshot(snapshot);
  assert.equal(confirmed.report.players.find(p=>p.id==='1').draw,0);
  assert.ok(confirmed.report.rows.some(row=>row.published_no_game&&isResolvedLiveMatch(row)));
});

test('event-end migration preserves old records and finds long-running competitions outside recent pages', async t => {
  const db=await databaseFixture(t,run=>run(`CREATE TABLE events(event_id TEXT PRIMARY KEY,title TEXT NOT NULL DEFAULT '',
    min_time TEXT NOT NULL DEFAULT '',provincename TEXT NOT NULL DEFAULT '',city_name TEXT NOT NULL DEFAULT '',
    cname TEXT NOT NULL DEFAULT '',play_num INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)`));
  await db.upsertEvents([{event_id:'70104',title:'Go',min_time:'2026-08-01',max_time:'2026-11-29',provincename:'Sichuan',play_num:47}]);
  await db.upsertEvents([{event_id:'70104',title:'Go',min_time:'2026-08-01',provincename:'Sichuan',play_num:47}]);
  const results=await db.queryLiveEventCandidates({province:'Sichuan',dateFrom:'2026-10-17',dateTo:'2026-10-26'});
  assert.equal(results.length,1);
  assert.equal(results[0].max_time,'2026-11-29');
});

test('persistent formal results cannot be replaced by an older report or a shorter roster', async t => {
  const db=await databaseFixture(t);
  const report=parsed();
  assert.equal(await db.savePublishedGroupResult(report),true);
  assert.equal(await db.savePublishedGroupResult({...report,published_at:'2026-10-01 00:00:00'}),false);
  assert.equal(await db.savePublishedGroupResult({...report,report_id:'98'}),false);
  assert.equal(await db.savePublishedGroupResult({...report,players:report.players.slice(1)}),false);
  assert.equal(await db.savePublishedGroupResult({...report,verified_final:true}),true);
  assert.equal(await db.savePublishedGroupResult(report),true);
  assert.equal((await db.getPublishedGroupResult('8')).players.length,5);
  assert.equal((await db.getPublishedGroupResult('8')).verified_final,true);
});

test('an unavailable formal verification keeps usable rows but does not claim complete indexing',async t=>{
  const db=await databaseFixture(t);
  const report=parsed();
  const result=await db.publishEventIndex({event_id:'1',groups:[{group_id:'8',event_id:'1',group_name:'Go',pnumber:5}],
    groupResults:[{group_id:'8',warning:'Formal source not verified',rows:report.players.map(p=>({
      event_id:'1',group_id:'8',participant_id:p.id,participant_name:p.name,win:p.win,lose:p.lose,draw:p.draw,score:p.score,rank:p.cloud_rank}))}]});
  assert.equal(result.status,'partial');
  assert.equal((await db.all('SELECT * FROM participant_index')).length,5);
  assert.equal((await db.one('SELECT status FROM indexed_events')).status,'partial');
});
