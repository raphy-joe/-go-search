'use strict';

const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const cron    = require('node-cron');

const {
  initPromise,
  queryUnindexedEvents,
  getIndexCoverage,
  queryParticipants,
  queryHeadToHeadCandidates,
  getGroupMatchCache,
  replaceGroupMatchCache,
  getStats,
} = require('./db');
const { runCrawl, stopCrawl, getState: getCrawlerState } = require('./crawler');
const { runIndex, stopIndex, getState: getIndexerState } = require('./indexer');

const app  = express();
const PORT = process.env.PORT || 3000;

const SEARCH_API      = 'https://api.yunbisai.com/request/event/SearchInfo';
const DETAIL_BASE     = 'https://www.yunbisai.com/tpl/eventFeatures/eventDetail-';
const AGAINSTPLAN_API = 'https://api.yunbisai.com/request/Group/Againstplan';
const SEARCH_TIMEOUT_MS = 15000;
const SEARCH_RETRIES    = 1;
const LIVE_FALLBACK_LIMIT = parseInt(process.env.SEARCH_LIVE_FALLBACK_LIMIT || '250', 10);

const delay = ms => new Promise(r => setTimeout(r, ms));

app.use(express.static(path.join(__dirname, 'public')));

// ── /api/search ───────────────────────────────────────────────────────────────
// DB 提供已过滤赛事列表 → 按姓名并发搜索
app.get('/api/search', async (req, res) => {
  const { name, eventType = '2', province = '', yearFrom, yearTo } = req.query;
  if (!name || !name.trim()) return res.status(400).json({ error: '请输入选手姓名' });

  const cleanName = name.trim();
  // __ALL__ 表示全国，不限省份
  const cleanProvince = (province === '__ALL__') ? '' : province;
  const dateFrom  = req.query.dateFrom || (yearFrom ? `${yearFrom}-01-01` : '0000-01-01');
  const dateTo    = req.query.dateTo   || (yearTo   ? `${yearTo}-12-31`   : '9999-12-31');

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  let closed = false;
  res.on('close', () => { closed = true; });
  const send = obj => { if (!closed) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  try {
    // 从 DB 取赛事列表（毫秒级，省去分页请求）
    const coverage = await getIndexCoverage({ province: cleanProvince, dateFrom, dateTo });
    const totalEventCount = coverage.eventCount || 0;
    const indexedEventCount = coverage.indexedEventCount || 0;
    const unindexedEventCount = coverage.unindexedEventCount || 0;
    const indexedHits = await queryParticipants({ name: cleanName, province: cleanProvince, dateFrom, dateTo });
    for (const row of indexedHits) send(indexedRowToHit(row));

    if (shouldReturnIndexOnly({ province: cleanProvince, unindexedEventCount, query: req.query })) {
      const backfillStarted = startIndexBackfill({ province: cleanProvince, dateFrom, dateTo });
      send({
        type: 'done',
        searched: indexedEventCount,
        queued: totalEventCount,
        failed: 0,
        indexed: indexedEventCount,
        indexHits: indexedHits.length,
        fallbackQueued: unindexedEventCount,
        partial: true,
        backfillStarted,
        mode: 'index-partial',
      });
      return res.end();
    }

    const events = await queryUnindexedEvents({ province: cleanProvince, dateFrom, dateTo });

    if (events.length === 0) {
      send({
        type: 'done',
        searched: indexedEventCount,
        queued: totalEventCount,
        failed: 0,
        indexed: indexedEventCount,
        indexHits: indexedHits.length,
        mode: 'index',
      });
      return res.end();
    }

    send({
      type: 'progress',
      searched: indexedEventCount,
      queued: totalEventCount,
      failed: 0,
      indexed: indexedEventCount,
      indexHits: indexedHits.length,
      fallbackQueued: events.length,
      pagesLoaded: 1,
      totalPages: 1,
    });

    // 并发按姓名搜索
    const CONCURRENCY = 8;
    let searched = indexedEventCount;
    let failed   = 0;
    let lastAt   = 0;
    const queue  = [...events];

    async function worker() {
      while (queue.length && !closed) {
        const event = queue.shift();
        if (!event) break;
        const result = await doSearch(event, cleanName, send);
        if (!result.ok) failed++;
        searched++;
        const now = Date.now();
        if (now - lastAt > 300 || queue.length === 0) {
          lastAt = now;
          send({
            type: 'progress',
            searched,
            queued: totalEventCount,
            failed,
            indexed: indexedEventCount,
            indexHits: indexedHits.length,
            fallbackQueued: events.length,
            pagesLoaded: 1,
            totalPages: 1,
          });
        }
        await delay(50);
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    send({
      type: 'done',
      searched,
      queued: totalEventCount,
      failed,
      indexed: indexedEventCount,
      indexHits: indexedHits.length,
      mode: indexedEventCount ? 'hybrid' : 'live',
    });

  } catch (err) {
    send({ type: 'error', msg: err.message });
  }

  res.end();
});

// ── 搜索单个赛事 ──────────────────────────────────────────────────────────────
function indexedRowToHit(row) {
  return {
    type: 'hit',
    source: 'index',
    event: {
      event_id:   String(row.event_id),
      title:      row.title,
      date:       (row.min_time || '').substring(0, 10),
      province:   row.provincename,
      city:       row.city_name,
      organizer:  row.cname,
      detail_url: `${DETAIL_BASE}${row.event_id}.html#groupID=${row.group_id}`,
    },
    player: {
      name:          row.participant_name,
      group:         row.group_name,
      org:           row.org,
      win:           String(row.win),
      lose:          String(row.lose),
      draw:          String(row.draw),
      score:         row.score,
      groupid:       String(row.group_id),
      participantid: String(row.participant_id),
      detail_url:    `https://m.yunbisai.com/memberData/personInfo/${randomStr()}?id=${row.group_id}&pID=${row.participant_id}&eventid=${row.event_id}`,
    },
  };
}

function shouldReturnIndexOnly({ province, unindexedEventCount, query }) {
  if (!unindexedEventCount) return false;
  if (query.live === '1' || query.full === '1') return false;
  if (!province) return true;
  return unindexedEventCount > LIVE_FALLBACK_LIMIT;
}

function startIndexBackfill({ province, dateFrom, dateTo }) {
  if (getIndexerState().running) return false;
  runIndex({ province, dateFrom, dateTo }).catch(console.error);
  return true;
}

async function doSearch(event, name, send) {
  try {
    const params = new URLSearchParams({
      eventid: event.event_id, keywords: name, type: 1, callback: 'cb',
    });
    const text = await fetchTextWithRetry(`${SEARCH_API}?${params}`, {
      headers: { Referer: 'https://www.yunbisai.com/' },
      timeout: SEARCH_TIMEOUT_MS,
    }, SEARCH_RETRIES);
    const s    = text.trim()
      .replace(/^[^(]+\(/, '').replace(/\);\s*$/, '').replace(/\)\s*$/, '');
    const data = JSON.parse(s);
    if (data.error === 0 && Array.isArray(data.datArr)) {
      for (const p of data.datArr) {
        if (p.participantname === name) {
          send({
            type: 'hit',
            event: {
              event_id:   String(event.event_id),
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
              groupid:       String(p.groupid),
              participantid: String(p.participantid),
              detail_url:    `https://m.yunbisai.com/memberData/personInfo/${randomStr()}?id=${p.groupid}&pID=${p.participantid}&eventid=${event.event_id}`,
            },
          });
        }
      }
    }
    return { ok: true };
  } catch (err) {
    console.warn(`[Search] event ${event.event_id} failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function fetchTextWithRetry(url, options, retries) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, options);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await delay(300 * (attempt + 1));
    }
  }
  throw lastErr;
}

// ── /api/matches ──────────────────────────────────────────────────────────────
const AGAINSTPLAN_HEADERS = {
  Referer:      'https://www.yunbisai.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

app.get('/api/matches', async (req, res) => {
  const { group_id, rounds, player_id } = req.query;
  if (!group_id || !rounds || !player_id)
    return res.status(400).json({ error: 'missing params' });

  const totalRounds = parseInt(rounds) || 0;
  if (totalRounds < 1) return res.json({ matches: [] });

  try {
    const groupRows = await getOrFetchGroupMatches(group_id, totalRounds);
    return res.json({ matches: buildPlayerMatches(groupRows, totalRounds, player_id) });
  } catch (err) {
    console.warn(`[Matches] group ${group_id} failed: ${err.message}`);
  }

  res.json({ matches: [] });
});

app.get('/api/head-to-head', async (req, res) => {
  const playerA = String(req.query.playerA || '').trim();
  const playerB = String(req.query.playerB || '').trim();
  if (!playerA || !playerB) return res.status(400).json({ error: 'missing players' });
  if (playerA === playerB) return res.status(400).json({ error: '请输入两位不同棋手' });

  const province = req.query.province === '__ALL__' ? '' : String(req.query.province || '');
  const dateFrom = req.query.dateFrom || '0000-01-01';
  const dateTo = req.query.dateTo || '9999-12-31';
  const limit = Math.min(parseInt(req.query.limit) || 300, 600);

  try {
    const candidates = await queryHeadToHeadCandidates({ playerA, playerB, province, dateFrom, dateTo, limit });
    const games = [];
    let checkedGroups = 0;
    let failedGroups = 0;

    for (const c of candidates) {
      const rounds = Math.max(parseInt(c.player_a_rounds) || 0, parseInt(c.player_b_rounds) || 0);
      if (!rounds) continue;
      checkedGroups++;
      try {
        const rows = await getOrFetchGroupMatches(c.group_id, rounds);
        const playerGames = findHeadToHeadGames(rows, c.player_a_id, c.player_b_id, c);
        games.push(...playerGames);
      } catch (err) {
        failedGroups++;
        console.warn(`[H2H] group ${c.group_id} failed: ${err.message}`);
      }
    }

    games.sort((a, b) => (b.event.date || '').localeCompare(a.event.date || '') || b.bout - a.bout);
    const summary = games.reduce((s, g) => {
      s.games++;
      if (g.result === 'win') s.win++;
      else if (g.result === 'lose') s.lose++;
      else s.draw++;
      return s;
    }, { games: 0, win: 0, lose: 0, draw: 0 });
    summary.winRate = summary.games ? (summary.win + 0.5 * summary.draw) / summary.games : 0;

    res.json({
      players: { a: playerA, b: playerB },
      scope: { province: province || '__ALL__', dateFrom, dateTo },
      summary,
      candidates: candidates.length,
      checkedGroups,
      failedGroups,
      games,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function buildPlayerMatches(groupRows, totalRounds, playerId) {
  const results = [];
  for (let bout = 1; bout <= totalRounds; bout++) {
    const row = groupRows.find(m =>
      m.bout === bout && (String(m.p1_id) === String(playerId) || String(m.p2_id) === String(playerId))
    );
    if (!row) {
      results.push({ bout, opponent: null });
      continue;
    }
    const isP1 = String(row.p1_id) === String(playerId);
    const raw = isP1 ? row.p1_result : row.p2_result;
    results.push({
      bout,
      opponent: isP1 ? row.p2_name : row.p1_name,
      opponent_org: isP1 ? row.p2_org : row.p1_org,
      result: raw == '1' ? 'win' : raw == '2' ? 'lose' : 'draw',
      score: parseFloat(isP1 ? row.p1_score : row.p2_score) || 0,
      opp_score: parseFloat(isP1 ? row.p2_score : row.p1_score) || 0,
    });
  }
  return results;
}

async function getOrFetchGroupMatches(groupId, rounds) {
  const cached = await getGroupMatchCache(groupId);
  if (cached.status && !cached.status.last_error && cached.status.rounds >= rounds) {
    return normalizeCachedRows(cached.rows);
  }

  const rows = await fetchGroupMatches(groupId, rounds);
  await replaceGroupMatchCache({ group_id: groupId, rounds, rows });
  return rows;
}

function normalizeCachedRows(rows) {
  return rows.map(r => ({
    group_id: String(r.group_id),
    bout: parseInt(r.bout) || 0,
    p1_id: String(r.p1_id || ''),
    p2_id: String(r.p2_id || ''),
    p1_name: r.p1_name || '',
    p2_name: r.p2_name || '',
    p1_org: r.p1_org || '',
    p2_org: r.p2_org || '',
    p1_result: String(r.p1_result ?? ''),
    p2_result: String(r.p2_result ?? ''),
    p1_score: parseFloat(r.p1_score) || 0,
    p2_score: parseFloat(r.p2_score) || 0,
  }));
}

async function fetchGroupMatches(groupId, rounds) {
  const allRows = [];
  for (let bout = 1; bout <= rounds; bout++) {
    const params = new URLSearchParams({ groupid: groupId, team: 0, bout, callback: 'cb' });
    const text = await fetchTextWithRetry(`${AGAINSTPLAN_API}?${params}`, {
      headers: AGAINSTPLAN_HEADERS,
      timeout: 8000,
    }, 1);
    const data = parseJsonp(text);
    const rows = data.datArr?.rows ?? [];
    for (const row of rows) {
      if (!row.p1id || !row.p2id) continue;
      allRows.push({
        group_id: String(groupId),
        bout,
        p1_id: String(row.p1id),
        p2_id: String(row.p2id),
        p1_name: row.p1 || '',
        p2_name: row.p2 || '',
        p1_org: row.p1_teamname || '',
        p2_org: row.p2_teamname || '',
        p1_result: String(row.p1_result ?? ''),
        p2_result: String(row.p2_result ?? ''),
        p1_score: parseFloat(row.p1_score) || 0,
        p2_score: parseFloat(row.p2_score) || 0,
      });
    }
    await delay(40);
  }
  return allRows;
}

function parseJsonp(text) {
  const s = text.trim()
    .replace(/^[^(]+\(/, '').replace(/\);\s*$/, '').replace(/\)\s*$/, '');
  return JSON.parse(s);
}

function findHeadToHeadGames(rows, playerAId, playerBId, candidate) {
  const games = [];
  for (const row of rows) {
    const aIsP1 = String(row.p1_id) === String(playerAId);
    const aIsP2 = String(row.p2_id) === String(playerAId);
    const bIsP1 = String(row.p1_id) === String(playerBId);
    const bIsP2 = String(row.p2_id) === String(playerBId);
    if (!((aIsP1 && bIsP2) || (aIsP2 && bIsP1))) continue;
    const raw = aIsP1 ? row.p1_result : row.p2_result;
    games.push({
      bout: row.bout,
      result: raw == '1' ? 'win' : raw == '2' ? 'lose' : 'draw',
      score: parseFloat(aIsP1 ? row.p1_score : row.p2_score) || 0,
      opp_score: parseFloat(aIsP1 ? row.p2_score : row.p1_score) || 0,
      playerA: {
        id: String(playerAId),
        name: candidate.player_a_name,
        org: aIsP1 ? row.p1_org : row.p2_org,
      },
      playerB: {
        id: String(playerBId),
        name: candidate.player_b_name,
        org: aIsP1 ? row.p2_org : row.p1_org,
      },
      group: {
        group_id: String(candidate.group_id),
        name: candidate.group_name || '',
      },
      event: {
        event_id: String(candidate.event_id),
        title: candidate.title,
        date: (candidate.min_time || '').substring(0, 10),
        province: candidate.provincename,
        city: candidate.city_name,
        organizer: candidate.cname,
        detail_url: `${DETAIL_BASE}${candidate.event_id}.html#groupID=${candidate.group_id}`,
      },
    });
  }
  return games;
}

// ── /api/crawl/* ──────────────────────────────────────────────────────────────

app.get('/api/crawl/status', async (_req, res) => {
  const stats = await getStats();
  res.json({ ...getCrawlerState(), stats });
});

app.post('/api/crawl/start', express.json(), (req, res) => {
  if (getCrawlerState().running)
    return res.status(409).json({ error: '爬虫正在运行' });
  const { eventType = '2', province = '', indexAfter = true } = req.body || {};
  runCrawl({ eventType, province })
    .then(() => {
      const crawlState = getCrawlerState();
      if (indexAfter === false || crawlState.stopRequested || crawlState.eventsStored === 0) return;
      if (getIndexerState().running) {
        console.log('[Crawler] Index backfill skipped because indexer is already running.');
        return;
      }
      return runIndex({ province });
    })
    .catch(console.error);
  res.json({ started: true, indexAfter: indexAfter !== false });
});

app.post('/api/crawl/stop', (_req, res) => {
  stopCrawl();
  res.json({ stopped: true });
});

app.get('/api/index/status', async (_req, res) => {
  const stats = await getStats();
  res.json({ ...getIndexerState(), stats });
});

app.post('/api/index/start', express.json(), (req, res) => {
  if (getIndexerState().running)
    return res.status(409).json({ error: '索引正在运行' });
  const { province = '', dateFrom, dateTo, force = false, limit = 0 } = req.body || {};
  runIndex({ province, dateFrom, dateTo, force, limit }).catch(console.error);
  res.json({ started: true });
});

app.post('/api/index/stop', (_req, res) => {
  stopIndex();
  res.json({ stopped: true });
});

// ── 定时任务：每天凌晨 2:30 刷新赛事列表 ─────────────────────────────────────
cron.schedule('30 2 * * *', () => {
  console.log('[Scheduler] Nightly crawl triggered.');
  runCrawl()
    .then(() => runIndex())
    .catch(console.error);
}, { timezone: 'Asia/Shanghai' });

// ── 启动：DB 空则立即爬一次 ───────────────────────────────────────────────────
initPromise.then(async () => {
  const { eventCount, lastUpdated } = await getStats();
  if (eventCount === 0) {
    console.log('[Startup] DB empty — starting initial crawl.');
    runCrawl().catch(console.error);
  } else {
    const age = lastUpdated ? Math.round((Date.now() - lastUpdated) / 3600000) : '?';
    console.log(`[Startup] DB ready — ${eventCount} events (${age}h ago).`);
  }
});

// ── Helper ────────────────────────────────────────────────────────────────────
function randomStr() {
  return Array.from({ length: 6 }, () =>
    'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]
  ).join('');
}

app.listen(PORT, () => console.log(`✅  服务已启动：http://localhost:${PORT}`));
