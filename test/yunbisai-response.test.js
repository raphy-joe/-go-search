'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {parseResponse,assertSuccess,eventPage,participants,matchRound}=require('../yunbisai-response');

test('JSON and JSONP share strict parsing without treating HTML or business errors as empty data',()=>{
  for(const text of ['{"error":0}','cb({"error":0});','jQuery_123({"error":"0"})']) assertSuccess(parseResponse(text));
  assert.throws(()=>parseResponse('<html>login</html>'),/INVALID_UPSTREAM_RESPONSE/);
  assert.throws(()=>assertSuccess({error:false}),/UPSTREAM_BUSINESS_ERROR/);
  assert.throws(()=>eventPage({error:1,datArr:{rows:[]}}),/UPSTREAM_BUSINESS_ERROR/);
  assert.throws(()=>eventPage({error:0}),/INVALID_EVENT_LIST_RESPONSE/);
});

test('missing participant scores and statistics cannot silently become zero',()=>{
  const row={participantid:'1',participantname:'Alpha',vicsum:'1',faisum:'0',deusum:'0',integral:'2',group_id:'8'};
  const read=r=>participants({error:0,datArr:{rows:[r]}},'8');
  assert.equal(read(row)[0].integral,2);
  assert.throws(()=>read({...row,integral:undefined}),/INVALID_UPSTREAM_NUMBER/);
  assert.throws(()=>read({...row,deusum:undefined}),/INVALID_UPSTREAM_NUMBER/);
  assert.throws(()=>read({...row,group_id:'9'}),/INVALID_PARTICIPANT_IDENTITY/);
  assert.throws(()=>read({...row,vicsum:'NaN'}),/INVALID_UPSTREAM_NUMBER/);
});

test('unknown result codes and absent real-player scores fail closed',()=>{
  const row={p1id:'1',p2id:'2',p1_result:'0',p2_result:'0',p1_score:'0',p2_score:'0'};
  const read=r=>matchRound({error:0,datArr:{rows:[r]}},'8');
  assert.equal(read(row).rows.length,1);
  assert.throws(()=>read({...row,p1_result:'99'}),/UNKNOWN_RESULT_CODE/);
  assert.throws(()=>read({...row,p2_score:undefined}),/INVALID_UPSTREAM_NUMBER/);
});

test('the source may omit the score of a nonexistent opponent on a zero-point absence',()=>{
  const round=matchRound({error:0,datArr:{rows:[{p1id:'1',p2id:'0',p1_result:'4',p2_result:null,p1_score:'0.0',p2_score:null}]}},'8');
  assert.equal(round.rows[0].p2_score,0);
  assert.equal(round.rows[0].p1_score,0);
});
