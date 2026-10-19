'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {predictPlayerRank,validatePredictionSnapshot}=require('../prediction-engine');
const {runPrediction}=require('../prediction-runner');
const game=(bout,a,b)=>({bout,p1_id:a,p2_id:b,p1_result:'1',p2_result:'2',p1_score:2,p2_score:0});
const fixture=()=>({players:[{id:'1',name:'A',score:6,win:3,lose:0},{id:'2',name:'B',score:4,win:2,lose:1},
  {id:'3',name:'C',score:2,win:1,lose:2},{id:'4',name:'D',score:0,win:0,lose:3}],
  matchData:{rows:[game(1,'1','4'),game(1,'2','3'),game(2,'1','3'),game(2,'2','4'),game(3,'1','2'),game(3,'3','4')],
    totalRounds:3,completedRounds:3,knownPairingRounds:3},snapshotAt:1});
const options=snapshot=>({snapshot,groupId:'9',participantId:'1',simulations:200,requestedTotalRounds:3});

test('missing historical rounds cannot be replayed on top of official totals',()=>{
  const snapshot=fixture();snapshot.matchData.rows=snapshot.matchData.rows.filter(r=>r.bout!==2);snapshot.matchData.completedRounds=1;
  assert.throws(()=>predictPlayerRank(options(snapshot)),e=>e.code==='INCOMPLETE_PREDICTION_DATA');
});
test('missing pairings and duplicate player appearances reject prediction',()=>{
  const missing=fixture();missing.matchData.rows.pop();assert.throws(()=>validatePredictionSnapshot(missing),/不完整/);
  const duplicate=fixture();duplicate.matchData.rows.push(game(3,'1','4'));assert.throws(()=>validatePredictionSnapshot(duplicate),/不完整/);
});
test('completed tournaments retain deterministic ranks and do not gain scores',()=>{
  const result=predictPlayerRank(options(fixture()));
  assert.equal(result.current.score,6);assert.deepEqual(result.probabilities,[{rank:1,count:200,probability:1}]);
});
test('an unpublished future round is simulated without exposing fictional pairings',()=>{
  const result=predictPlayerRank({...options(fixture()),requestedTotalRounds:4});
  assert.equal(result.next_opponent,null);assert.equal(result.next_bout,4);assert.equal(result.simulations,200);
  assert.ok(result.probabilities.length>0);assert.ok(result.probabilities.length<=5);
});
test('official next pairing and manual win scenario work in the worker',async()=>{
  const snapshot=fixture();snapshot.matchData.rows.push({...game(4,'1','3'),p1_result:'0',p2_result:'0',p1_score:0,p2_score:0},
    {...game(4,'2','4'),p1_result:'0',p2_result:'0',p1_score:0,p2_score:0});
  snapshot.matchData.knownPairingRounds=4;
  const result=await runPrediction({...options(snapshot),requestedTotalRounds:4,nextResult:'win'});
  assert.equal(result.next_opponent.id,'3');assert.equal(result.next_result,'win');assert.equal(result.probabilities[0].rank,1);
});
test('a partially downloaded first pairing sheet cannot omit half the field',()=>{
  const snapshot=fixture();snapshot.players=snapshot.players.map(p=>({...p,score:0,win:0,lose:0}));
  snapshot.matchData.rows=[{...game(1,'1','2'),p1_result:'0',p2_result:'0',p1_score:0,p2_score:0}];
  assert.throws(()=>validatePredictionSnapshot(snapshot),/不完整/);
});
test('an aborted prediction does not launch a worker',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(runPrediction(options(fixture()),{signal:controller.signal}),e=>e.code==='ABORTED');
});

const absence=(bout,id,side='p1')=>({bout,p1_id:side==='p1'?id:'__live_bye__',
  p2_id:side==='p2'?id:'__live_bye__',p1_result:side==='p1'?'4':'',
  p2_result:side==='p2'?'4':'',p1_score:0,p2_score:0});

test('an unscored absence does not block the field or get simulated as a bye win',()=>{
  for(const side of ['p1','p2']) {
    const snapshot=fixture();snapshot.players.push({id:'5',name:'Absent',score:0,win:0,lose:0});
    snapshot.matchData.rows.push(absence(1,'5',side));
    assert.doesNotThrow(()=>validatePredictionSnapshot(snapshot));
    const result=predictPlayerRank({...options(snapshot),participantId:'5',includeDistribution:true});
    assert.equal(result.current.score,0);
    assert.deepEqual(result.probabilities,[{rank:5,count:200,probability:1}]);
    const future=predictPlayerRank({...options(snapshot),participantId:'5',requestedTotalRounds:4});
    assert.equal(future.model.pairing_players,4);
    assert.equal(future.next_opponent,null);
    assert.deepEqual(future.probabilities,[{rank:5,count:200,probability:1}]);
  }
});

test('a nonparticipant does not invalidate a second-round pairing sheet',()=>{
  const snapshot=fixture();snapshot.players=snapshot.players.map(p=>({...p,score:['1','2'].includes(p.id)?2:0,
    win:['1','2'].includes(p.id)?1:0,lose:['3','4'].includes(p.id)?1:0}));
  snapshot.players.push({id:'5',name:'Absent',score:0,win:0,lose:0});
  snapshot.matchData.rows=snapshot.matchData.rows.filter(row=>row.bout<3).map(row=>row.bout===2?
    {...row,p1_result:'0',p2_result:'0',p1_score:0,p2_score:0}:row);
  snapshot.matchData.rows.push(absence(1,'5'));snapshot.matchData.completedRounds=1;
  assert.doesNotThrow(()=>validatePredictionSnapshot(snapshot));
});

test('an unresolved code 4 game against a real opponent still blocks prediction',()=>{
  const snapshot=fixture();snapshot.matchData.rows[0]={...game(1,'1','4'),p1_result:'4',p2_result:'4',p1_score:0,p2_score:0};
  assert.throws(()=>validatePredictionSnapshot(snapshot),e=>e.code==='INCOMPLETE_PREDICTION_DATA');
});

test('confirmed event rounds override an old six-round player link',()=>{
  const snapshot=fixture();snapshot.matchData.totalRounds=7;snapshot.matchData.totalRoundsSource='event-config';
  const result=predictPlayerRank({...options(snapshot),requestedTotalRounds:6});
  assert.equal(result.total_rounds,7);
  assert.equal(result.total_rounds_source,'event-config');
});

test('unresolved tied places never count as guaranteed top-N slots', () => {
  const snapshot = { players: ['1','2','3','4'].map(id => ({ id, name: id, score: 1, win: 0, lose: 0, draw: 1 })),
    matchData: { rows: [game(1,'1','2'),game(1,'3','4')].map(row => ({ ...row,
      p1_result:'3',p2_result:'3',p1_score:1,p2_score:1 })), totalRounds:1,completedRounds:1,knownPairingRounds:1 }, snapshotAt:1 };
  const result = predictPlayerRank({ ...options(snapshot), requestedTotalRounds:1 });
  assert.deepEqual(result.rank_intervals, [{ rank:1, rank_max:4, count:200, probability:1 }]);
  assert.deepEqual(result.top_n[0], { n:1, probability_min:0, probability_max:1 });
  assert.deepEqual(result.top_n[2], { n:3, probability_min:0, probability_max:1 });
  assert.deepEqual(result.top_n[3], { n:4, probability_min:1, probability_max:1 });
  assert.equal(result.assumptions.ranking.verified, false);
  assert.equal(result.probability_semantics, 'unresolved-tie-bounds');
});

test('top-N probability bounds are monotone and derive from every simulation, not only the five displayed outcomes', () => {
  const result = predictPlayerRank({ ...options(fixture()), requestedTotalRounds:7, includeDistribution:true });
  for (const bounds of result.top_n) {
    const expectedMin = result.rank_intervals.filter(row => row.rank_max <= bounds.n).reduce((sum,row) => sum + row.count,0) / result.simulations;
    const expectedMax = result.rank_intervals.filter(row => row.rank <= bounds.n).reduce((sum,row) => sum + row.count,0) / result.simulations;
    assert.equal(bounds.probability_min, expectedMin);
    assert.equal(bounds.probability_max, expectedMax);
    assert.ok(bounds.probability_min <= bounds.probability_max);
  }
  assert.equal(result.top_n.at(-1).probability_min, 1);
});

test('corrected round results reconcile stale statistics even when the number of played games is unchanged', () => {
  const snapshot=fixture();
  snapshot.matchData.rows[0]={...game(1,'1','4'),p1_result:'2',p2_result:'1',p1_score:0,p2_score:2};
  const result=predictPlayerRank(options(snapshot));
  assert.equal(result.current.score,4);
  assert.equal(result.current.win,2);
  assert.equal(result.current.lose,1);
  assert.equal(result.score_updates_applied,true);
});
