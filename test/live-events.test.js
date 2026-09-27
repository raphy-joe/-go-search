'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const now = Date.parse('2026-09-27T12:00:00+08:00');
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const event = (id = '70596') => ({ event_id: id, title: '\u56db\u5ddd\u7701\u68cb\u7c7b\u9526\u6807\u8d5b',
  event_value: '2', min_time: '2026-09-26 00:00:00', max_time: '2026-09-27 19:30:00', provincename: '\u56db\u5ddd\u7701' });
const group = (id = 346562, eventid = 70596) => ({ groupid: id, eventid, groupname: '\u7537\u5b50\u7532\u7ec4',
  eventtype: 2, pnumber: 21, begintime: '2026-09-26 00:00:00', endtime: '2026-09-27 19:30:00' });
const html = '<title>\u56f4\u68cb\u6bd4\u8d5b</title><a data-groupid="17" data-groupname="3\u6bb5\u7ec4" data-pnumber="20" data-bt="2026-09-27 09:00:00" data-et="2026-09-27 19:00:00">';

function load({ events = [event()], listError = false, groups = () => [group()], fallback = '\u8be5\u6bd4\u8d5b\u6570\u636e\u4e0d\u5b58\u5728' } = {}) {
  const routes = new Map(), calls = [];
  const app = { set() {}, use() {}, listen() {}, post() {}, get(route, handler) { routes.set(route, handler); } };
  const express = Object.assign(() => app, { static: () => () => {}, json: () => () => {} });
  const mocks = { express, './db': { initPromise: new Promise(() => {}) }, './crawler': {}, './indexer': {},
    './strength': {}, './promotions': {}, 'node-cron': { schedule() {} },
    'node-fetch': async url => {
      const u = new URL(url);
      calls.push(u);
      let body;
      if (u.pathname === '/api/lswl-events') {
        body = listError ? { error: 1, msg: 'temporarily unavailable', datArr: { rows: [] } }
          : { error: 0, datArr: { rows: u.searchParams.get('page') === '1' ? events : [] } };
      } else if (u.pathname.startsWith('/api/lswl-groups/event/')) {
        const data = groups(u.pathname.split('/').pop());
        body = Array.isArray(data) ? { error: 0, data } : data;
      } else if (u.pathname.startsWith('/tpl/eventFeatures/eventDetail-')) body = fallback;
      else throw new Error('Unexpected URL: ' + url);
      return { ok: true, text: async () => typeof body === 'string' ? body : JSON.stringify(body) };
    },
  };
  const sandbox = { console: { log() {}, warn() {}, error() {} }, Buffer, URLSearchParams, Date: FixedDate, Math,
    setTimeout: callback => setTimeout(callback, 0), clearTimeout, __dirname: root, process: { env: {} },
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name.startsWith('.') ? path.join(root, name) : name) };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), sandbox);
  return { calls, async request(route, query = {}) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await routes.get(route)({ query }, res);
    return res;
  } };
}

test('live events use typed public groups even when the old event page is unavailable', async () => {
  const f = load();
  const res = await f.request('/api/live-events', { province: '\u56db\u5ddd\u7701' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.events.length, 1);
  assert.equal(res.body.events[0].status, 'live');
  assert.equal(res.body.events[0].live_group_count, 1);
  assert.equal(res.body.events[0].detail_url, 'https://m.yunbisai.com/event/70596');
  assert.equal(res.body.failed_events, 0);
  assert.equal(f.calls.some(u => u.pathname.includes('eventDetail-')), false);
});

test('event detail normalizes API dates and IDs and filters other sports', async () => {
  const f = load({ groups: () => [group(), group(), { ...group(2), eventtype: 1 },
    { ...group(3), eventtype: 2, groupname: '\u8c61\u68cb\u7532\u7ec4' }, { ...group(4), eventtype: undefined }] });
  const res = await f.request('/api/live-event', { event_id: '70596' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.groups.length, 1);
  const g = res.body.groups[0];
  assert.equal(g.group_id, '346562');
  assert.equal(g.pnumber, 21);
  assert.equal(g.begins_at, '2026-09-26 00:00:00');
  assert.equal(g.ends_at, '2026-09-27 19:30:00');
  assert.equal(g.live, true);
});

test('legacy HTML is a fallback on API failure', async () => {
  const f = load({ groups: () => ({ error: 1, msg: 'wait' }), fallback: html });
  const res = await f.request('/api/live-event', { event_id: '70596' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.groups[0].group_id, '17');
  assert.equal(f.calls.length, 2);
});

test('group API and HTML failures are not a successful empty event list', async () => {
  const f = load({ groups: () => ({ error: 1, data: [] }) });
  const res = await f.request('/api/live-events');
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.failed_events, 1);
  assert.match(res.body.error, /\u8bfb\u53d6\u5931\u8d25/);
});

test('partial group fetch failures retain successful events with a warning', async () => {
  const f = load({ events: [event(), event('70543')],
    groups: id => id === '70596' ? [group()] : { error: 0, data: 'wait' } });
  const res = await f.request('/api/live-events');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.events.length, 1);
  assert.equal(res.body.failed_events, 1);
  assert.ok(res.body.warning.includes('1'));
});

test('event-list business errors cannot masquerade as no competitions', async () => {
  const res = await load({ listError: true }).request('/api/live-events');
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /\u8bfb\u53d6\u5931\u8d25/);
});

test('genuinely empty events and empty published groups stay successful', async () => {
  for (const f of [load({ events: [] }), load({ groups: () => [] }), load({ groups: () => [{ ...group(), eventtype: 1 }] })]) {
    const res = await f.request('/api/live-events');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.events.length, 0);
    assert.equal(res.body.failed_events, 0);
    assert.equal(f.calls.some(u => u.pathname.includes('eventDetail-')), false);
  }
});

test('mismatched group ownership is rejected instead of showing another event', async () => {
  const res = await load({ groups: () => [group(1, 123)] }).request('/api/live-event', { event_id: '70596' });
  assert.equal(res.statusCode, 500);
});

test('invalid event identifiers do not trigger upstream requests', async () => {
  const f = load();
  const res = await f.request('/api/live-event', { event_id: '../70596' });
  assert.equal(res.statusCode, 400);
  assert.equal(f.calls.length, 0);
});

function loadPage(response = { ok: true, data: { events: [] } }) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', style: {}, innerHTML: '', textContent: '',
      addEventListener() {}, setCustomValidity() {}, reportValidity() {}, focus() {}, querySelectorAll() { return []; } });
    return elements.get(id);
  };
  let calls = 0;
  const sandbox = { document: { getElementById: element, querySelector: element }, URLSearchParams,
    window: { location: { search: '' } }, console,
    fetch: async () => { calls++; return { ok: response.ok, json: async () => response.data }; } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/live-prediction.js'), 'utf8'), sandbox);
  return { sandbox, element, calls: () => calls };
}

test('initial page does not search until a province is selected and confirmed', async () => {
  const f = loadPage();
  assert.equal(f.calls(), 0);
  await f.sandbox.loadLiveEvents();
  assert.equal(f.calls(), 0);
  f.element('liveProvince').value = '\u56db\u5ddd\u7701';
  await f.sandbox.loadLiveEvents();
  assert.equal(f.calls(), 1);
  assert.equal(f.element('liveEventCount').textContent, '0');
});

test('failed search is shown as an error rather than zero competitions', async () => {
  const f = loadPage({ ok: false, data: { error: '\u4e0a\u6e38\u5931\u8d25' } });
  f.element('liveProvince').value = '\u56db\u5ddd\u7701';
  await f.sandbox.loadLiveEvents();
  assert.equal(f.element('liveEventCount').textContent, '--');
  assert.match(f.element('liveEventsList').innerHTML, /\u67e5\u8be2\u5931\u8d25/);
  assert.equal(f.element('loadLiveEventsBtn').disabled, false);
});

test('partial-result warnings are escaped and remain alongside event choices', () => {
  const f = loadPage();
  f.sandbox.renderLiveEvents([{ event_id: '70596', title: 'Go', group_count: 1 }], '<warning>');
  const content = f.element('liveEventsList').innerHTML;
  assert.ok(content.includes('&lt;warning&gt;'));
  assert.ok(content.includes('data-event-id="70596"'));
  assert.equal(f.element('liveEventCount').textContent, '1');
});
