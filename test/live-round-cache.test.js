'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLiveRoundCache } = require('../live-round-cache');

test('completed history is reused while current round and metadata remain live', async () => {
  let now = 0, calls = 0;
  const cache = createLiveRoundCache({ now: () => now, liveTtlMs: 10, historyTtlMs: 100 });
  const get = bout => cache.get('1', bout, async () => ({ version: ++calls }));
  await get(1); await get(2); await get(3); cache.confirm('1', 3);
  now = 11;
  assert.equal((await get(1)).data.version, 4);
  assert.equal((await get(2)).data.version, 2);
  assert.equal((await get(3)).data.version, 5);
  now = 101;
  assert.equal((await get(2)).data.version, 6);
});

test('failed round fetches never replace cached data or advance its verification time', async () => {
  let now = 0;
  const cache = createLiveRoundCache({ now: () => now, liveTtlMs: 10, historyTtlMs: 100 });
  await cache.get('1', 2, async () => ({ value: 'good' }));
  now = 11;
  await assert.rejects(cache.get('1', 2, async () => { throw new Error('network'); }));
  cache.confirm('1', 3);
  const reused = await cache.get('1', 2, async () => { throw new Error('unexpected request'); });
  assert.equal(reused.data.value, 'good'); assert.equal(reused.checkedAt, 0);
  cache.invalidate('1');
  assert.equal((await cache.get('1', 2, async () => ({ value: 'corrected' }))).data.value, 'corrected');
});

test('LRU group budget evicts old histories', async () => {
  const cache = createLiveRoundCache({ maxGroups: 1 }); let calls = 0;
  for (const group of ['1', '2', '1']) await cache.get(group, 1, async () => ({ version: ++calls }));
  assert.equal(calls, 3);
});

test('a rejected refresh preserves the last valid sheet rather than caching its replacement', async () => {
  let now=0;
  const cache=createLiveRoundCache({now:()=>now,liveTtlMs:10,historyTtlMs:100,
    validateRefresh(next,previous){ if(previous && next.value==='partial') throw new Error('incomplete'); }});
  await cache.get('1',2,async()=>({value:'good'}));now=11;
  await assert.rejects(cache.get('1',2,async()=>({value:'partial'})),/incomplete/);
  cache.confirm('1',3);
  const preserved=await cache.get('1',2,async()=>{throw new Error('must remain cached');});
  assert.equal(preserved.data.value,'good');assert.equal(preserved.checkedAt,0);
});
