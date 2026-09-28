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
