'use strict';

const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── API base URLs ──────────────────────────────────────────────────────────────
const EVENTS_API  = 'https://data-center.yunbisai.com/api/lswl-events';
const SEARCH_API  = 'https://api.yunbisai.com/request/event/SearchInfo';
const DETAIL_BASE = 'https://www.yunbisai.com/tpl/eventFeatures/eventDetail-';

// ── In-memory event cache: key = "type|province", value = { ts, events[] } ───
const eventCache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

app.use(express.static(path.join(__dirname, 'public')));

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Helper: fetch one page of events ─────────────────────────────────────────
async function fetchEventPage(eventType, province, page) {
  const params = new URLSearchParams({
    page,
    PageSize: 100,
    eventType,
    areaNum: province || '',
  });
  const res = await fetch(`${EVENTS_API}?${params}`);
  if (!res.ok) throw new Error(`Events API ${res.status}`);
  const json = await res.json();
  return json.datArr || {};
}

function toSlimEvent(e) {
  return {
    event_id:     e.event_id,
    title:        e.title,
    min_time:     e.min_time,
    provincename: e.provincename,
    city_name:    e.city_name,
    cname:        e.cname,
    play_num:     e.play_num,
  };
}

// ── GET /api/search  ──────────────────────────────────────────────────────────
// Streams SSE: { type: 'status'|'pages'|'progress'|'hit'|'done'|'error' }
app.get('/api/search', async (req, res) => {
  const { name, eventType = '2', province = '', yearFrom, yearTo } = req.query;
  if (!name || !name.trim()) return res.status(400).json({ error: '请输入选手姓名' });

  const cleanName = name.trim();

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  let closed = false;
  res.on('close', () => { closed = true; });
  const send = obj => { if (!closed) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  try {
    const cacheKey = `${eventType}|${province}`;
    const cached   = eventCache.get(cacheKey);

    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      // ── Fast path: cached event list ─────────────────────────────────────
      await runSearch(cached.events, cleanName, yearFrom, yearTo, send, () => closed);
    } else {
      // ── Pipeline path: load pages + search concurrently ──────────────────
      await pipelineSearch(eventType, province, cleanName, yearFrom, yearTo, send, () => closed, cacheKey);
    }
  } catch (err) {
    send({ type: 'error', msg: err.message });
  }

  res.end();
});

// ── Pipeline search: loads event pages and searches in parallel ───────────────
async function pipelineSearch(eventType, province, name, yearFrom, yearTo, send, isClosed, cacheKey) {
  const searchQueue  = [];    // events ready to search
  const allCollected = [];    // for building cache at end
  let   pagesLoading = true;
  let   totalPages   = null;
  let   pagesLoaded  = 0;
  let   totalQueued  = 0;
  let   totalSearched = 0;
  let   lastProgressAt = 0;

  const SEARCH_CONCURRENCY = 8;
  const PAGE_CONCURRENCY   = 5;

  function shouldInclude(e) {
    if (e.play_num <= 0) return false;
    const t = (e.min_time || '').substring(0, 10);
    if (yearFrom && t < `${yearFrom}-01-01`) return false;
    if (yearTo   && t > `${yearTo}-12-31`)   return false;
    return true;
  }

  function enqueue(rows) {
    for (const r of (rows || [])) {
      const slim = toSlimEvent(r);
      allCollected.push(slim);
      if (shouldInclude(slim)) {
        searchQueue.push(slim);
        totalQueued++;
      }
    }
  }

  // ── Page loader ─────────────────────────────────────────────────────────────
  async function loadPages() {
    send({ type: 'status', msg: '正在加载赛事列表...' });
    const first = await fetchEventPage(eventType, province, 1);
    totalPages  = first.TotalPage || 1;
    pagesLoaded = 1;
    enqueue(first.rows);
    send({ type: 'pages', pagesLoaded, totalPages });

    const remaining = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    while (remaining.length && !isClosed()) {
      const batch = remaining.splice(0, PAGE_CONCURRENCY);
      const pages = await Promise.all(batch.map(p => fetchEventPage(eventType, province, p)));
      for (const pg of pages) {
        pagesLoaded++;
        enqueue(pg.rows);
      }
      send({ type: 'pages', pagesLoaded, totalPages });
    }
    pagesLoading = false;

    // Store full (unfiltered) list in cache
    const cacheKey_ = `${eventType}|${province}`;
    eventCache.set(cacheKey_, { ts: Date.now(), events: allCollected });
  }

  // ── Search worker ────────────────────────────────────────────────────────────
  async function searchWorker() {
    while (!isClosed()) {
      const event = searchQueue.shift();
      if (!event) {
        if (!pagesLoading) break;        // loader finished, queue empty → done
        await delay(80);                 // wait for loader to push more events
        continue;
      }
      await doSearch(event, name, send);
      totalSearched++;

      const now = Date.now();
      if (now - lastProgressAt > 300 || (!pagesLoading && searchQueue.length === 0)) {
        lastProgressAt = now;
        send({ type: 'progress', searched: totalSearched, queued: totalQueued, pagesLoaded, totalPages });
      }
    }
  }

  await Promise.all([
    loadPages(),
    ...Array.from({ length: SEARCH_CONCURRENCY }, searchWorker),
  ]);

  send({ type: 'done', searched: totalSearched, queued: totalQueued });
}

// ── Search against cached event list ─────────────────────────────────────────
async function runSearch(events, name, yearFrom, yearTo, send, isClosed) {
  const filtered = events.filter(e => {
    if (e.play_num <= 0) return false;
    const t = (e.min_time || '').substring(0, 10);
    if (yearFrom && t < `${yearFrom}-01-01`) return false;
    if (yearTo   && t > `${yearTo}-12-31`)   return false;
    return true;
  });

  const CONCURRENCY = 8;
  let   searched    = 0;
  let   lastAt      = 0;
  const queue       = [...filtered];
  send({ type: 'progress', searched: 0, queued: filtered.length, pagesLoaded: 1, totalPages: 1 });

  async function worker() {
    while (queue.length && !isClosed()) {
      const event = queue.shift();
      if (!event) break;
      await doSearch(event, name, send);
      searched++;
      const now = Date.now();
      if (now - lastAt > 300 || queue.length === 0) {
        lastAt = now;
        send({ type: 'progress', searched, queued: filtered.length, pagesLoaded: 1, totalPages: 1 });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  send({ type: 'done', searched, queued: filtered.length });
}

// ── Single event player search ────────────────────────────────────────────────
async function doSearch(event, name, send) {
  try {
    const params = new URLSearchParams({ eventid: event.event_id, keywords: name, type: 1, callback: 'cb' });
    const r = await fetch(`${SEARCH_API}?${params}`, {
      headers: { Referer: 'https://www.yunbisai.com/' },
      timeout: 8000,
    });
    const text  = await r.text();
    // JSONP response format: cb({...}); — strip callback wrapper
    const jsonStr = text.trim().replace(/^[^(]+\(/, '').replace(/\);\s*$/, '').replace(/\)\s*$/, '');
    const data = JSON.parse(jsonStr);
    if (data.error === 0 && Array.isArray(data.datArr)) {
      for (const p of data.datArr) {
        if (p.participantname === name) {
          send({
            type: 'hit',
            event: {
              event_id:   event.event_id,
              title:      event.title,
              date:       (event.min_time || '').substring(0, 10),
              province:   event.provincename,
              city:       event.city_name,
              organizer:  event.cname,
              detail_url: `${DETAIL_BASE}${event.event_id}.html#groupID=${p.groupid}`,
            },
            player: {
              name:          p.participantname,
              group:         p.groupname,
              org:           p.othername,
              win:           p.vicsum,
              lose:          p.faisum,
              draw:          p.deusum,
              score:         p.integral,
              groupid:       p.groupid,
              participantid: p.participantid,
              detail_url:    `https://m.yunbisai.com/memberData/personInfo/${randomStr()}?id=${p.groupid}&pID=${p.participantid}&eventid=${event.event_id}`,
            },
          });
        }
      }
    }
  } catch (_) { /* skip failed */ }
}

function randomStr() {
  return Array.from({ length: 6 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
}

// ── GET /api/matches?group_id=X&rounds=N&player_id=Y ─────────────────────────
// Uses api.yunbisai.com/request/Group/Againstplan (JSONP) — works for all events
const AGAINSTPLAN_API = 'https://api.yunbisai.com/request/Group/Againstplan';
const AGAINSTPLAN_HEADERS = {
  'Referer': 'https://www.yunbisai.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

app.get('/api/matches', async (req, res) => {
  const { group_id, rounds, player_id } = req.query;
  if (!group_id || !rounds || !player_id) {
    return res.status(400).json({ error: 'missing params' });
  }
  const totalRounds = parseInt(rounds) || 0;
  if (totalRounds < 1) return res.json({ matches: [] });

  const results = [];
  for (let bout = 1; bout <= totalRounds; bout++) {
    try {
      const params = new URLSearchParams({ groupid: group_id, team: 0, bout, callback: 'cb' });
      const r = await fetch(`${AGAINSTPLAN_API}?${params}`, { headers: AGAINSTPLAN_HEADERS, timeout: 8000 });
      const text = await r.text();
      // JSONP: strip cb(...);
      const jsonStr = text.trim().replace(/^[^(]+\(/, '').replace(/\);\s*$/, '').replace(/\)\s*$/, '');
      const data = JSON.parse(jsonStr);
      const rows = (data.datArr && data.datArr.rows) ? data.datArr.rows : [];
      // Find the row where this player is p1 or p2
      const row = rows.find(m => String(m.p1id) === String(player_id) || String(m.p2id) === String(player_id));
      if (row) {
        const isP1 = String(row.p1id) === String(player_id);
        // p1_result: 1=win, 2=lose; score is stones/points
        const rawResult = isP1 ? row.p1_result : row.p2_result;
        const result = rawResult == '1' ? 'win' : rawResult == '2' ? 'lose' : 'draw';
        const score   = isP1 ? row.p1_score : row.p2_score;
        const oppScore = isP1 ? row.p2_score : row.p1_score;
        results.push({
          bout,
          opponent:     isP1 ? row.p2 : row.p1,
          opponent_org: isP1 ? (row.p2_teamname || '') : (row.p1_teamname || ''),
          result,
          score: parseFloat(score) || 0,
          opp_score: parseFloat(oppScore) || 0,
        });
      } else if (data.datArr === 'wait') {
        results.push({ bout, opponent: null, pending: true });
      } else {
        results.push({ bout, opponent: null });
      }
    } catch (_) {
      results.push({ bout, opponent: null, error: true });
    }
  }

  res.json({ matches: results });
});

app.listen(PORT, () => console.log(`✅  服务已启动：http://localhost:${PORT}`));
