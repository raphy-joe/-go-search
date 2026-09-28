'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { databaseFixture } = require('./helpers/database');
const event = { event_id:'1', title:'围棋段位赛', min_time:'2026-09-01', provincename:'四川省',city_name:'成都',cname:'协会',play_num:4,updated_at:1 };
const group = id => ({ group_id:id,event_id:'1',group_name:'3段组',pnumber:2 });
const player = (groupId,id,win=1) => ({event_id:'1',group_id:groupId,participant_id:id,participant_name:'选手'+id,win,lose:1,draw:0});
const snapshot = (time=10) => ({event_id:'1',groups:[group('10'),group('20')],indexed_at:time,
  groupResults:[{group_id:'10',rows:[player('10','1'),player('10','2')]},{group_id:'20',rows:[player('20','3'),player('20','4')]}]});
async function fixture(t) { const db=await databaseFixture(t);await db.upsertEvents([event]);return db; }

test('participant snapshots preserve good groups and publish only complete replacements',async t=>{
  const db=await fixture(t);assert.equal((await db.publishEventIndex(snapshot())).status,'success');
  const input=snapshot(20);input.groupResults[0].rows[0].win=2;input.groupResults[1].rows=[];
  const result=await db.publishEventIndex(input);assert.equal(result.status,'partial');
  assert.equal((await db.one("SELECT win FROM participant_index WHERE participant_id='1'")).win,2);
  assert.equal((await db.one("SELECT updated_at FROM participant_index WHERE participant_id='3'")).updated_at,10);
  const status=await db.one('SELECT * FROM indexed_events');assert.equal(status.last_success_at,10);assert.equal(status.last_attempt_at,20);
  const coverage=await db.getIndexCoverage({});assert.equal(coverage.indexedEventCount,0);assert.equal(coverage.partialEventCount,1);
  assert.equal((await db.queryEventsForIndex({})).length,1);
});

test('missing groups and shorter histories cannot delete indexed participants',async t=>{
  const db=await fixture(t);await db.publishEventIndex(snapshot());
  const input=snapshot(30);input.groups=input.groups.slice(0,1);input.groupResults=input.groupResults.slice(0,1);
  input.groupResults[0].rows[0].win=0;
  assert.equal((await db.publishEventIndex(input)).status,'failed');
  assert.equal((await db.all('SELECT * FROM participant_index')).length,4);
  await assert.rejects(db.replaceParticipantsForEvent('1',[]),/COVERAGE_REGRESSION/);
});

test('every fetch error remains pending for retry and cannot claim full coverage',async t=>{
  const db=await fixture(t);await db.publishEventIndex(snapshot());
  await db.upsertIndexedEvent({event_id:'1',last_error:'no groups found',indexed_at:50});
  const status=await db.one('SELECT * FROM indexed_events');assert.equal(status.last_success_at,10);assert.equal(status.participant_count,4);
  const coverage=await db.getIndexCoverage({});assert.equal(coverage.failedEventCount,1);assert.equal(coverage.indexedEventCount,0);
  assert.equal((await db.queryUnindexedEvents({})).length,1);
});

test('a group ownership conflict rolls back the entire publication',async t=>{
  const db=await fixture(t);await db.publishEventIndex(snapshot());
  await db.run("UPDATE event_groups SET event_id='2' WHERE group_id='20'");
  const input=snapshot(30);input.groupResults[0].rows[0].win=5;
  await assert.rejects(db.publishEventIndex(input),/GROUP_EVENT_MISMATCH/);
  assert.equal((await db.one("SELECT win FROM participant_index WHERE participant_id='1'")).win,1);
  assert.equal((await db.one('SELECT last_success_at FROM indexed_events')).last_success_at,10);
});

test('concurrent complete and incomplete snapshots retain the complete roster',async t=>{
  const db=await fixture(t);const short=snapshot(20);short.groupResults[0].rows.pop();
  await Promise.all([db.publishEventIndex(snapshot()),db.publishEventIndex(short)]);
  assert.equal((await db.all('SELECT * FROM participant_index')).length,4);
});

test('legacy index metadata migration separates success and failed attempts',async t=>{
  const db=await databaseFixture(t,async run=>{
    await run("CREATE TABLE indexed_events(event_id TEXT PRIMARY KEY,indexed_at INTEGER,group_count INTEGER,participant_count INTEGER,last_error TEXT)");
    await run("INSERT INTO indexed_events VALUES('1',10,2,4,''),('2',20,0,0,'no groups found')");
  });
  const rows=await db.all('SELECT * FROM indexed_events ORDER BY event_id');
  assert.equal(rows[0].last_success_at,10);assert.equal(rows[1].status,'failed');assert.equal(rows[1].last_success_at,0);
});
