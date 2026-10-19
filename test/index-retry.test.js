'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { retrySchedule, classifyIndexFailure } = require('../index-retry');
const { databaseFixture } = require('./helpers/database');

test('index compensation classifies errors and caps exponential retry delays', () => {
  assert.equal(classifyIndexFailure('HTTP 429').reason, 'transient');
  assert.equal(classifyIndexFailure('MISSING_PARTICIPANTS').reason, 'incomplete');
  assert.equal(classifyIndexFailure('INVALID_UPSTREAM_NUMBER').reason, 'schema');
  assert.equal(classifyIndexFailure('HTTP 404').reason, 'unavailable');
  assert.equal(retrySchedule('timeout', 1, 0, () => 0).nextAttemptAt, 300000);
  assert.equal(retrySchedule('timeout', 2, 0, () => 0).nextAttemptAt, 600000);
  assert.equal(retrySchedule('INVALID_FIELD', 100, 0, () => 0).nextAttemptAt, 3 * 86400000);
});

test('only due failed events enter bounded compensation, and a success clears the retry', async t => {
  const db = await databaseFixture(t);
  await db.upsertEvents([1,2,3].map(id => ({ event_id: String(id), title: 'Go test event', min_time: '2026-10-01', play_num: 2, updated_at: 1 })));
  await db.upsertIndexedEvent({ event_id: '1', last_error: 'HTTP 429', indexed_at: 1000 });
  await db.upsertIndexedEvent({ event_id: '2', last_error: 'MISSING_PARTICIPANTS', indexed_at: 1000 });
  assert.equal((await db.queryEventsForIndex({ retryOnly: true, now: 1000 })).length, 0);
  const due = await db.queryEventsForIndex({ retryOnly: true, now: 400000, limit: 1 });
  assert.deepEqual(due.map(row => row.event_id), ['1']);
  assert.deepEqual((await db.queryEventsForIndex({ respectRetrySchedule: true, now: 1000 })).map(row => row.event_id), ['3']);
  await db.upsertIndexedEvent({ event_id: '1', indexed_at: 500000 });
  assert.equal((await db.all('SELECT * FROM index_retry_queue WHERE event_id=?', ['1'])).length, 0);
  assert.equal((await db.getIndexRetryHealth())[0].reason, 'incomplete');
});
