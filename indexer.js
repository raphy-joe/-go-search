'use strict';

const fetch = require('node-fetch');
const {
  queryEventsForIndex,
  upsertEventGroups,
  replaceParticipantsForEvent,
  upsertIndexedEvent,
} = require('./db');

const DETAIL_BASE = 'https://www.yunbisai.com/tpl/eventFeatures/eventDetail-';
const EVENTPART_API = 'https://api.yunbisai.com/request/Group/Eventpart';
const REQUEST_TIMEOUT_MS = 15000;
const EVENT_CONCURRENCY = 4;
const GROUP_DELAY_MS = 80;

const delay = ms => new Promise(r => setTimeout(r, ms));
const activeControllers = new Set();

let state = {
  running: false,
  startedAt: null,
  totalEvents: 0,
  eventsIndexed: 0,
  eventsFailed: 0,
  groupsIndexed: 0,
  participantsIndexed: 0,
  currentEvent: null,
  lastError: null,
  stopRequested: false,
};

function getState() {
  return { ...state };
}

function stopIndex() {
  if (!state.running) return;
  state.stopRequested = true;
  for (const controller of activeControllers) controller.abort();
  console.log('[Indexer] Stop requested.');
}

function throwIfStopped() {
  if (state.stopRequested || !state.running) throw new Error('INDEX_STOPPED');
}

async function runIndex({ province = '', dateFrom, dateTo, force = false, limit = 0 } = {}) {
  if (state.running) {
    console.log('[Indexer] Already running.');
    return;
  }

  state = {
    running: true,
    startedAt: Date.now(),
    totalEvents: 0,
    eventsIndexed: 0,
    eventsFailed: 0,
    groupsIndexed: 0,
    participantsIndexed: 0,
    currentEvent: null,
    lastError: null,
    stopRequested: false,
  };

  try {
    const events = await queryEventsForIndex({ province, dateFrom, dateTo, force, limit });
    state.totalEvents = events.length;
    console.log(`[Indexer] Start indexing ${events.length} events.`);

    const queue = [...events];
    async function worker() {
      while (queue.length) {
        throwIfStopped();
        const event = queue.shift();
        if (!event) break;
        state.currentEvent = `${event.event_id} ${event.title || ''}`.trim();
        try {
          const result = await indexEvent(event);
          state.eventsIndexed++;
          state.groupsIndexed += result.groupCount;
          state.participantsIndexed += result.participantCount;
          if (state.eventsIndexed % 20 === 0 || !queue.length) {
            console.log(`[Indexer] ${state.eventsIndexed}/${state.totalEvents} events, ${state.participantsIndexed} participants.`);
          }
        } catch (err) {
          if (err.message === 'INDEX_STOPPED' || err.name === 'AbortError') throw err;
          state.eventsFailed++;
          state.lastError = err.message;
          await upsertIndexedEvent({
            event_id: event.event_id,
            group_count: 0,
            participant_count: 0,
            last_error: err.message,
          });
          console.warn(`[Indexer] event ${event.event_id} failed: ${err.message}`);
        }
      }
    }

    await Promise.all(Array.from({ length: EVENT_CONCURRENCY }, worker));
    console.log(`[Indexer] Done. Indexed ${state.eventsIndexed} events, ${state.participantsIndexed} participants.`);
  } catch (err) {
    if (err.message === 'INDEX_STOPPED' || err.name === 'AbortError') {
      console.log('[Indexer] Stopped before completion.');
    } else {
      state.lastError = err.message;
      console.error('[Indexer] Error:', err.message);
    }
  } finally {
    state.running = false;
    state.currentEvent = null;
    activeControllers.clear();
  }
}

async function indexEvent(event) {
  throwIfStopped();
  const groups = await fetchEventGroups(event.event_id);
  const now = Date.now();
  const normalizedGroups = groups.map(g => ({
    group_id: g.groupid,
    event_id: String(event.event_id),
    group_name: g.groupname || '',
    team_type: g.team || '0',
    pnumber: g.pnumber || 0,
    updated_at: now,
  }));
  await upsertEventGroups(normalizedGroups);

  const participants = [];
  for (const group of normalizedGroups) {
    throwIfStopped();
    const rows = await fetchGroupParticipants(group.group_id);
    for (const row of rows) {
      const participantId = row.participantid || row.id || row.pid || '';
      const participantName = row.participantname || row.name || '';
      if (!participantId || !participantName) continue;
      participants.push({
        event_id: String(event.event_id),
        group_id: group.group_id,
        group_name: group.group_name,
        participant_id: String(participantId),
        participant_name: participantName,
        org: row.teamname || row.othername || '',
        short_no: row.short || '',
        win: row.vicsum,
        lose: row.faisum,
        draw: row.deusum,
        score: row.integral,
        updated_at: now,
      });
    }
    await delay(GROUP_DELAY_MS);
  }

  await replaceParticipantsForEvent(event.event_id, participants);
  await upsertIndexedEvent({
    event_id: event.event_id,
    group_count: normalizedGroups.length,
    participant_count: participants.length,
    last_error: '',
    indexed_at: now,
  });

  return { groupCount: normalizedGroups.length, participantCount: participants.length };
}

async function fetchEventGroups(eventId) {
  const html = await fetchText(`${DETAIL_BASE}${eventId}.html`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: REQUEST_TIMEOUT_MS,
  });
  const groups = [];
  const seen = new Set();
  const anchorRe = /<a\b[^>]*data-groupid=["']?\d+["']?[^>]*>/gi;
  let m;
  while ((m = anchorRe.exec(html))) {
    const attrs = parseDataAttrs(m[0]);
    if (!attrs.groupid || seen.has(attrs.groupid)) continue;
    seen.add(attrs.groupid);
    groups.push(attrs);
  }
  if (groups.length === 0) throw new Error('no groups found');
  return groups;
}

async function fetchGroupParticipants(groupId) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const params = new URLSearchParams({ groupid: String(groupId), callback: 'cb' });
    const text = await fetchText(`${EVENTPART_API}?${params}`, {
      headers: { Referer: 'https://www.yunbisai.com/' },
      timeout: REQUEST_TIMEOUT_MS,
    });
    const data = parseJsonp(text);
    if (data.datArr === 'wait') {
      await delay(1000);
      continue;
    }
    if (data.error !== 0) throw new Error(data.msg || 'Eventpart API error');
    return data.datArr?.rows || [];
  }
  throw new Error(`participants wait timeout for group ${groupId}`);
}

async function fetchText(url, options) {
  const controller = new AbortController();
  activeControllers.add(controller);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    activeControllers.delete(controller);
  }
}

function parseJsonp(text) {
  const s = text.trim()
    .replace(/^[^(]+\(/, '')
    .replace(/\);\s*$/, '')
    .replace(/\)\s*$/, '');
  return JSON.parse(s);
}

function parseDataAttrs(html) {
  const attrs = {};
  const re = /data-([a-z0-9_-]+)=["']([^"']*)["']/gi;
  let m;
  while ((m = re.exec(html))) attrs[m[1].replace(/-/g, '')] = htmlDecode(m[2]);
  return attrs;
}

function htmlDecode(s) {
  return String(s || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const [k, v = 'true'] = arg.replace(/^--/, '').split('=');
    return [k, v];
  }));
  runIndex({
    province: args.province || '',
    dateFrom: args.dateFrom,
    dateTo: args.dateTo,
    force: args.force === 'true',
    limit: parseInt(args.limit) || 0,
  }).then(() => process.exit(0), err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { runIndex, stopIndex, getState, indexEvent };
