'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {databaseFixture}=require('./helpers/database');

test('typed group discovery plus partial participant errors preserve complete groups and retry the event',async t=>{
  const db=await databaseFixture(t);
  await db.upsertEvents([{event_id:'1',title:'围棋段位赛',min_time:'2026-09-01',provincename:'四川省',play_num:2,updated_at:1}]);
  const calls=[];let fail=false;
  const rawFetch=async url=>{
    const u=new URL(url);calls.push(u);
    const body=u.pathname.includes('/lswl-groups/event/')?{error:0,data:[10,20].map(groupid=>({groupid,eventid:1,eventtype:2,groupname:'5段组',pnumber:1}))}
      :fail&&u.searchParams.get('groupid')==='20'?{error:1,msg:'temporary business error'}
        :{error:0,datArr:{rows:[{participantid:u.searchParams.get('groupid'),participantname:'棋手',vicsum:4,faisum:3}]}};
    return {ok:true,text:async()=>JSON.stringify(body)};
  };
  const root=path.resolve(__dirname,'..');
  const context={console:{log(){},warn(){},error(){}},module:{exports:{}},process:{env:{}},URLSearchParams,AbortController,
    setTimeout:callback=>setTimeout(callback,0),clearTimeout,
    require:name=>name==='./db'?db:name==='node-fetch'?rawFetch:require(name.startsWith('.')?path.join(root,name):name)};
  vm.runInNewContext(fs.readFileSync(path.join(root,'indexer.js'),'utf8'),context);
  const indexer=context.module.exports;
  await indexer.runIndex({force:true});
  assert.equal(indexer.getState().eventsIndexed,1,JSON.stringify(indexer.getState()));
  assert.equal((await db.all('SELECT * FROM participant_index')).length,2);
  const success=(await db.one('SELECT * FROM indexed_events')).last_success_at;
  fail=true;await indexer.runIndex({force:true});
  assert.equal(indexer.getState().eventsPartial,1);assert.equal(indexer.getState().eventsIndexed,0);
  assert.equal((await db.all('SELECT * FROM participant_index')).length,2);
  assert.equal((await db.one('SELECT * FROM indexed_events')).last_success_at,success);
  assert.equal((await db.queryEventsForIndex({})).length,1);
  assert.ok(calls.some(u=>u.pathname==='/api/lswl-groups/event/1'));
  assert.equal(calls.some(u=>u.pathname.includes('eventDetail-')),false);
});
