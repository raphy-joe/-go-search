'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { probeUpstream } = require('../upstream-probe');
const row = (id, name) => ({ participantid:String(id),participantname:name,vicsum:1,faisum:0,deusum:0,integral:2,compositor:1 });

function source({ repeatPage = false, unknownPlayer = false, duplicateRound = false, shortRoster = false } = {}) {
  return async url => {
    const u = new URL(url); let data;
    if (u.pathname.endsWith('lswl-events')) data = {error:0,datArr:{ TotalPage:2, rows:[{
      event_id: repeatPage ? 1 : Number(u.searchParams.get('page')), title:'Go event', min_time:'2026-10-01' }] }};
    else if (u.pathname.includes('lswl-groups')) data = {error:0,data:[{groupid:'2',eventid:'1',eventtype:2,pnumber:2}]};
    else if (u.pathname.endsWith('Eventpart')) data = {error:0,datArr:{rows: shortRoster ? [row(3,'A')] : [row(3,'A'),row(4,'B')]}};
    else if (u.pathname.endsWith('Againstplan')) data = {error:0,datArr:{groupid:'2',total_bout:2,rows:[{
      againstplanid:duplicateRound?'same':u.searchParams.get('bout'),p1id:'3',p2id:unknownPlayer?'5':'4',
      p1_result:1,p2_result:2,p1_score:2,p2_score:0 }]}};
    else data = {error:0,datArr:[]};
    return JSON.stringify(data);
  };
}
const samples = [{eventId:'1',groupId:'2',formal:false}];

test('compatibility probe checks real response contracts without modifying application storage', async () => {
  const result = await probeUpstream({ fetchText:source(),samples,now:()=>1 });
  assert.equal(result.status,'ok'); assert.equal(result.checks.length,2); assert.equal(result.checked_at,1);
});

test('schema/paging/roster failures are critical, repeated future-round fallback is distinguishable', async () => {
  for (const options of [{repeatPage:true},{unknownPlayer:true},{shortRoster:true}]) {
    const result = await probeUpstream({fetchText:source(options),samples});
    assert.equal(result.status,'failed');
    assert.ok(result.findings.some(finding => finding.severity === 'critical'));
  }
  const fallback = await probeUpstream({fetchText:source({duplicateRound:true}),samples});
  assert.equal(fallback.status,'degraded');
  assert.equal(fallback.findings[0].code,'ROUND_ENDPOINT_FALLBACK');
});
