'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchTextWithRetry, retryAfterMs, createCircuitBreaker, sleep } = require('../upstream-client');
const { createLimiter } = require('../resource-limits');

test('Retry-After accepts seconds and HTTP dates, never negative or invalid delays', () => {
  assert.equal(retryAfterMs('3'), 3000);
  assert.equal(retryAfterMs('Mon, 19 Oct 2026 00:00:05 GMT', Date.parse('2026-10-19T00:00:00Z')), 5000);
  assert.equal(retryAfterMs('nonsense'), 0);
  assert.equal(retryAfterMs('-2'), 0);
});

test('retry honours server delay, jitters exponential backoff, and does not retry permanent errors', async () => {
  const delays = []; let calls = 0;
  const fetch = async () => ++calls < 3 ? { ok: false, status: calls === 1 ? 429 : 503,
    headers: { get: () => calls === 1 ? '2' : null } } : { ok: true, text: async () => 'ok' };
  assert.equal(await fetchTextWithRetry(fetch, 'https://example.test', {}, 2,
    { wait: async ms => delays.push(ms), random: () => 0.5 }), 'ok');
  assert.deepEqual(delays, [2000, 1150]);
  calls = 0;
  await assert.rejects(fetchTextWithRetry(async () => { calls++; return { ok: false, status: 404 }; }, '', {}, 4), /404/);
  assert.equal(calls, 1);
  await assert.rejects(fetchTextWithRetry(async () => ({ ok: false, status: 429, headers: { get: () => '120' } }), '', {}, 4,
    { wait: () => { throw new Error('must fail fast'); } }), error => error.retryAfterMs === 120000);
});

test('circuit opens after failures, allows one recovery probe, and retains in-flight cooldowns', () => {
  let now = 0;
  const circuit = createCircuitBreaker({ now: () => now, threshold: 2, cooldownMs: 1000 });
  const error = Object.assign(new Error('HTTP 503'), { status: 503 });
  circuit.before('api'); circuit.failure('api', error);
  circuit.before('api'); circuit.failure('api', error);
  assert.throws(() => circuit.before('api'), error => error.code === 'UPSTREAM_COOLDOWN');
  circuit.success('api');
  assert.throws(() => circuit.before('api'), error => error.code === 'UPSTREAM_COOLDOWN');
  now = 1000; circuit.before('api');
  assert.throws(() => circuit.before('api'), error => error.code === 'UPSTREAM_COOLDOWN');
  circuit.success('api'); circuit.before('api');
  circuit.failure('api', Object.assign(new Error('HTTP 429'), { status: 429, retryAfterMs: 5000 }));
  assert.equal(circuit.snapshot()[0].retry_at, 6000);
  circuit.failure('api',Object.assign(new Error('cancelled'),{name:'AbortError'}));
  assert.equal(circuit.snapshot()[0].retry_at,6000);
  circuit.failure('api',error);
  assert.equal(circuit.snapshot()[0].retry_at,6000);
});

test('cancelled retry sleep exits promptly', async () => {
  const controller = new AbortController();
  const waiting = sleep(10000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, error => error.name === 'AbortError');
});

test('foreground requests jump queued background work and retain reserved capacity', async () => {
  const run = createLimiter({ concurrency: 2, backgroundConcurrency: 1, maxQueue: 8, timeoutMs: 1000 });
  let release; const order = [];
  const first = run(() => new Promise(resolve => { release = resolve; }), { priority: 'background' });
  await new Promise(setImmediate);
  const background = run(() => { order.push('background'); }, { priority: 'background' });
  const foreground = run(() => { order.push('foreground'); });
  await foreground;
  assert.deepEqual(order, ['foreground']);
  release(); await Promise.all([first, background]);
  assert.deepEqual(order, ['foreground', 'background']);
});

test('background reservation does not bypass the bounded queue when foreground slots are idle', async () => {
  const run=createLimiter({concurrency:4,backgroundConcurrency:1,maxQueue:1,timeoutMs:1000});
  let release;
  const first=run(()=>new Promise(resolve=>{release=resolve;}),{priority:'background'});
  await new Promise(setImmediate);
  const queued=run(()=>{}, {priority:'background'});
  await assert.rejects(run(()=>{}, {priority:'background'}), error=>error.code==='BUSY');
  await run(()=>{});
  release();await Promise.all([first,queued]);
});
