'use strict';

const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const cron    = require('node-cron');
const crypto  = require('crypto');

const {
  initPromise,
  updateGroupResultQuality,
  queryExcludedResultGroups,
  queryUnindexedEvents,
  getIndexCoverage,
  queryParticipants,
  queryHeadToHeadCandidates,
  getGroupMatchCache,
  replaceGroupMatchCache,
  getLivePairingOverrides,
  getStats,
} = require('./db');
const { runCrawl, stopCrawl, getState: getCrawlerState } = require('./crawler');
const { runIndex, stopIndex, getState: getIndexerState } = require('./indexer');
const { estimatePlayerStrength } = require('./strength');
const { estimatePromotionHistory } = require('./promotions');
const {
  isCompleteMatchCache,
  isPlayedMatch,
  matchResultForSide,
  resolveMatchResult,
} = require('./match-results');
const liveEventSettings = require('./live-event-settings.json');
const { isGoEvent, isGoGroup } = require('./sport-filter');

const app  = express();
const PORT = process.env.PORT || 3000;

const SEARCH_API      = 'https://api.yunbisai.com/request/event/SearchInfo';
const EVENTS_API      = 'https://data-center.yunbisai.com/api/lswl-events';
const DETAIL_BASE     = 'https://www.yunbisai.com/tpl/eventFeatures/eventDetail-';
const AGAINSTPLAN_API = 'https://api.yunbisai.com/request/Group/Againstplan';
const EVENTPART_API   = 'https://api.yunbisai.com/request/Group/Eventpart';
const SEARCH_TIMEOUT_MS = 15000;
const SEARCH_RETRIES    = 1;
const LIVE_FALLBACK_LIMIT = parseInt(process.env.SEARCH_LIVE_FALLBACK_LIMIT || '250', 10);
const SEARCH_AUTO_BACKFILL = process.env.SEARCH_AUTO_BACKFILL === '1';
const MATCH_CACHE_INCOMPLETE_TTL_MS = parseInt(process.env.MATCH_CACHE_INCOMPLETE_TTL_MS || '60000', 10);
const MATCH_CACHE_COMPLETE_TTL_MS = parseInt(process.env.MATCH_CACHE_COMPLETE_TTL_MS || String(7 * 24 * 60 * 60 * 1000), 10);
const LIVE_SNAPSHOT_TTL_MS = parseInt(process.env.LIVE_SNAPSHOT_TTL_MS || '10000', 10);
const ROUND_FETCH_CONCURRENCY = Math.min(Math.max(parseInt(process.env.ROUND_FETCH_CONCURRENCY || '4', 10), 1), 8);
const API_RATE_LIMIT_WINDOW_MS = parseInt(process.env.API_RATE_LIMIT_WINDOW_MS || '60000', 10);
const API_RATE_LIMIT_MAX = parseInt(process.env.API_RATE_LIMIT_MAX || '60', 10);

const groupMatchFetches = new Map();
const liveGroupSnapshots = new Map();
const livePredictionResults = new Map();
const apiRateBuckets = new Map();

const delay = ms => new Promise(r => setTimeout(r, ms));

function configuredLiveEventTotalRounds(eventId) {
  const rounds = parseInt(liveEventSettings[String(eventId)]?.total_rounds) || 0;
  return Math.min(Math.max(rounds, 0), 30);
}

app.set('trust proxy', 'loopback');
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/live-')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use([
  '/api/search',
  '/api/matches',
  '/api/head-to-head',
  '/api/strength',
  '/api/promotions',
  '/api/live-events',
  '/api/live-event',
  '/api/live-group',
  '/api/live-prediction',
], rateLimitExpensiveApis);

function rateLimitExpensiveApis(req, res, next) {
  const now = Date.now();
  const key = String(req.ip || req.socket.remoteAddress || 'unknown');
  let bucket = apiRateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= API_RATE_LIMIT_WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    apiRateBuckets.set(key, bucket);
  }
  bucket.count++;
  if (bucket.count > API_RATE_LIMIT_MAX) {
    const retryAfter = Math.max(1, Math.ceil((bucket.startedAt + API_RATE_LIMIT_WINDOW_MS - now) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: `请求过于频繁，请在 ${retryAfter} 秒后重试` });
  }

  if (apiRateBuckets.size > 5000) {
    for (const [ip, value] of apiRateBuckets) {
      if (now - value.startedAt >= API_RATE_LIMIT_WINDOW_MS) apiRateBuckets.delete(ip);
    }
  }
  next();
}

function requireAdmin(req, res, next) {
  const expected = String(process.env.ADMIN_TOKEN || '');
  if (!expected) {
    return res.status(503).json({ error: '管理接口未启用，请在服务器设置 ADMIN_TOKEN' });
  }
  const bearer = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const provided = String(req.get('x-admin-token') || bearer || '');
  if (!safeTokenEqual(provided, expected)) {
    return res.status(401).json({ error: '管理接口认证失败' });
  }
  next();
}

function safeTokenEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

app.get('/api/system-status', async (_req, res) => {
  try {
    const [stats, coverage] = await Promise.all([
      getStats(),
      getIndexCoverage({}),
    ]);
    const total = coverage.eventCount || 0;
    const indexed = coverage.indexedEventCount || 0;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      last_updated: stats.participantLastUpdated || stats.lastUpdated || null,
      events: total,
      indexed_events: indexed,
      coverage: total ? indexed / total : 0,
      crawler_running: getCrawlerState().running,
      indexer_running: getIndexerState().running,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── /api/search ───────────────────────────────────────────────────────────────
// DB 提供已过滤赛事列表 → 按姓名并发搜索
app.get('/api/search', async (req, res) => {
  const { name, eventType = '2', province = '', yearFrom, yearTo } = req.query;
  if (String(eventType) !== '2') return res.status(400).json({ error: '仅支持围棋比赛成绩' });
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
      const backfillStarted = SEARCH_AUTO_BACKFILL
        ? startIndexBackfill({ province: cleanProvince, dateFrom, dateTo })
        : false;
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
      rank:          String(row.rank || ''),
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
        if (p.participantname === name && isGoGroup(event.title, p.groupname)) {
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
              rank:          String(p.compositor || ''),
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
  if (!/^\d+$/.test(String(group_id)) || !/^\d+$/.test(String(player_id)))
    return res.status(400).json({ error: 'invalid group or player id' });

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

app.get('/api/live-events', async (req, res) => {
  const province = req.query.province === '__ALL__' ? '' : String(req.query.province || '');
  const dateFrom = req.query.dateFrom || formatDateOffset(-2);
  const dateTo = req.query.dateTo || formatDateOffset(7);
  const limit = Math.min(parseInt(req.query.limit) || 60, 120);
  const now = Date.now();

  try {
    const candidates = await fetchLiveEventCandidates({ province, dateFrom, dateTo, limit });
    const events = [];
    await mapLimit(candidates, 4, async event => {
      try {
        const groups = await fetchLiveEventGroups(event.event_id, event.title);
        const liveGroups = groups.filter(g => isLiveGroup(g, now));
        const status = liveGroups.length
          ? 'live'
          : eventStatusFromTimes(event.min_time, event.max_time, now);
        if (status === 'old') return;
        events.push({
          event_id: String(event.event_id),
          total_rounds: configuredLiveEventTotalRounds(event.event_id),
          title: event.title,
          date: (event.min_time || '').substring(0, 10),
          province: event.provincename,
          city: event.city_name,
          organizer: event.cname,
          detail_url: `${DETAIL_BASE}${event.event_id}.html`,
          group_count: groups.length,
          live_group_count: liveGroups.length,
          status,
          status_label: liveEventStatusLabel(status),
          begins_at: minDateValue(groups.map(g => g.bt)) || event.min_time || '',
          ends_at: maxDateValue(groups.map(g => g.et)) || event.max_time || '',
        });
      } catch (err) {
        console.warn(`[LiveEvents] event ${event.event_id} failed: ${err.message}`);
      }
    });
    events.sort((a, b) =>
      liveStatusOrder(a.status) - liveStatusOrder(b.status) ||
      (b.date || '').localeCompare(a.date || '') ||
      String(b.event_id).localeCompare(String(a.event_id))
    );
    res.json({ events, scope: { province: province || '__ALL__', dateFrom, dateTo } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/live-event', async (req, res) => {
  const eventId = String(req.query.event_id || '').trim();
  if (!eventId) return res.status(400).json({ error: 'missing event_id' });

  try {
    const groups = await fetchLiveEventGroups(eventId);
    const now = Date.now();
    res.json({
      event_id: eventId,
      total_rounds: configuredLiveEventTotalRounds(eventId),
      groups: groups.map(g => ({
        group_id: String(g.groupid),
        group_name: g.groupname || '',
        pnumber: parseInt(g.pnumber) || 0,
        group_state: String(g.groupstate || ''),
        begins_at: g.bt || '',
        ends_at: g.et || '',
        live: isLiveGroup(g, now),
      })),
    });
  } catch (err) {
    console.warn(`[LiveEvent] ${eventId} failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/live-group', async (req, res) => {
  const groupId = String(req.query.group_id || '').trim();
  const requestedTotalRounds = Math.min(Math.max(parseInt(req.query.total_rounds) || 0, 0), 30);
  if (!groupId) return res.status(400).json({ error: 'missing group_id' });

  try {
    const snapshot = await getLiveGroupSnapshot(groupId, requestedTotalRounds);
    const { players, matchData } = snapshot;
    const liveState = reconcileLivePlayers(players, matchData.rows);
    const current = computeCurrentRanking(liveState.players, matchData.rows, Math.max(matchData.completedRounds || 0, 1));
    res.json({
      group_id: groupId,
      total_rounds: requestedTotalRounds
        ? Math.max(requestedTotalRounds, matchData.completedRounds || 0, matchData.knownPairingRounds || 0)
        : matchData.totalRounds,
      total_rounds_source: requestedTotalRounds ? 'event' : matchData.totalRoundsSource,
      completed_rounds: matchData.completedRounds,
      known_pairing_rounds: matchData.knownPairingRounds,
      manual_pairing_rounds: matchData.manualPairingRounds,
      score_updates_applied: liveState.updatedCount > 0,
      score_updated_players: liveState.updatedCount,
      score_updated_through_round: liveState.updatedThroughRound,
      players: current,
      snapshot_at: snapshot.snapshotAt,
    });
  } catch (err) {
    console.warn(`[LiveGroup] ${groupId} failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/live-prediction', async (req, res) => {
  const groupId = String(req.query.group_id || '').trim();
  const participantId = String(req.query.participant_id || '').trim();
  const simulations = Math.min(Math.max(parseInt(req.query.simulations) || 2000, 200), 8000);
  const requestedTotalRounds = Math.min(Math.max(parseInt(req.query.total_rounds) || 0, 0), 30);
  const nextResult = ['win', 'loss'].includes(req.query.next_result) ? req.query.next_result : '';
  if (!groupId || !participantId) return res.status(400).json({ error: 'missing params' });

  try {
    const result = await getCachedLivePrediction({ groupId, participantId, simulations, requestedTotalRounds, nextResult });
    res.json(result);
  } catch (err) {
    console.warn(`[LivePrediction] group ${groupId} player ${participantId} failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/head-to-head', async (req, res) => {
  const playerA = String(req.query.playerA || '').trim();
  const playerB = String(req.query.playerB || '').trim();
  if (!playerA || !playerB) return res.status(400).json({ error: 'missing players' });
  if (playerA === playerB) return res.status(400).json({ error: '请输入两位不同棋手' });

  const province = req.query.province === '__ALL__' ? '' : String(req.query.province || '');
  const dateFrom = req.query.dateFrom || '0000-01-01';
  const rawDateTo = req.query.dateTo || '9999-12-31';
  const dateTo = /^\d{4}-\d{2}-\d{2}$/.test(rawDateTo) ? `${rawDateTo} 23:59:59` : rawDateTo;
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
      if (!g.result) return s;
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

app.get('/api/strength', async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'missing player name' });

  const province = req.query.province === '__ALL__' ? '' : String(req.query.province || '');
  const dateTo = req.query.dateTo || undefined;

  try {
    const result = await estimatePlayerStrength({
      name,
      province,
      dateTo,
      getOrFetchGroupMatches,
    });
    res.json(result);
  } catch (err) {
    console.warn(`[Strength] ${name} failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/promotions', async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'missing player name' });

  const province = req.query.province === '__ALL__' ? '' : String(req.query.province || '');
  const dateFrom = req.query.dateFrom || '0000-01-01';
  const rawDateTo = req.query.dateTo || '9999-12-31';
  const dateTo = /^\d{4}-\d{2}-\d{2}$/.test(rawDateTo) ? `${rawDateTo} 23:59:59` : rawDateTo;

  try {
    const result = await estimatePromotionHistory({ name, province, dateFrom, dateTo });
    res.json(result);
  } catch (err) {
    console.warn(`[Promotions] ${name} failed: ${err.message}`);
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
    const result = matchResultForSide(row, isP1 ? 'p1' : 'p2');
    results.push({
      bout,
      opponent: isP1 ? row.p2_name : row.p1_name,
      opponent_org: isP1 ? row.p2_org : row.p1_org,
      result,
      played: result !== null,
      score: parseFloat(isP1 ? row.p1_score : row.p2_score) || 0,
      opp_score: parseFloat(isP1 ? row.p2_score : row.p1_score) || 0,
    });
  }
  return results;
}

async function getOrFetchGroupMatches(groupId, rounds) {
  const cached = await getGroupMatchCache(groupId);
  const cachedRows = normalizeCachedRows(cached.rows);
  if (cached.status && !cached.status.last_error && cached.status.rounds >= rounds) {
    const complete = isCompleteMatchCache(cachedRows, rounds);
    const ttl = complete ? MATCH_CACHE_COMPLETE_TTL_MS : MATCH_CACHE_INCOMPLETE_TTL_MS;
    if (Date.now() - Number(cached.status.updated_at || 0) <= ttl) {
      const quality = await updateGroupResultQuality(groupId, cachedRows);
      if (!quality.eligible) throw new Error('INSUFFICIENT_RESULTS');
      return cachedRows;
    }
  }

  const key = `${String(groupId)}:${Math.max(parseInt(rounds) || 0, 1)}`;
  if (!groupMatchFetches.has(key)) {
    const request = (async () => {
      const rows = await fetchGroupMatches(groupId, rounds);
      await replaceGroupMatchCache({ group_id: groupId, rounds, rows });
      const quality = await updateGroupResultQuality(groupId, rows);
      if (!quality.eligible) throw new Error('INSUFFICIENT_RESULTS');
      return rows;
    })();
    groupMatchFetches.set(key, request);
  }

  const request = groupMatchFetches.get(key);
  try {
    return await request;
  } catch (err) {
    if (err.message === 'INSUFFICIENT_RESULTS') throw err;
    if (cachedRows.length) {
      console.warn(`[Matches] using stale cache for group ${groupId}: ${err.message}`);
      return cachedRows;
    }
    throw err;
  } finally {
    if (groupMatchFetches.get(key) === request) groupMatchFetches.delete(key);
  }
}

async function getLiveGroupSnapshot(groupId, requestedTotalRounds = 0) {
  const key = `${String(groupId)}:${parseInt(requestedTotalRounds) || 0}`;
  const cached = liveGroupSnapshots.get(key);
  if (cached && cached.value && cached.expiresAt > Date.now()) return cached.value;
  if (cached?.promise) return cached.promise;

  const promise = Promise.all([
    fetchGroupParticipantsLive(groupId),
    fetchGroupMatchesLive(groupId, requestedTotalRounds),
  ]).then(([players, matchData]) => ({ players, matchData, snapshotAt: Date.now() }));
  liveGroupSnapshots.set(key, { promise, expiresAt: 0, value: null });
  try {
    const value = await promise;
    liveGroupSnapshots.set(key, {
      value,
      promise: null,
      expiresAt: Date.now() + LIVE_SNAPSHOT_TTL_MS,
    });
    return value;
  } catch (err) {
    if (liveGroupSnapshots.get(key)?.promise === promise) liveGroupSnapshots.delete(key);
    throw err;
  }
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
  const bouts = Array.from({ length: rounds }, (_, index) => index + 1);
  await mapLimit(bouts, ROUND_FETCH_CONCURRENCY, async bout => {
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
  });
  allRows.sort((a, b) => a.bout - b.bout);
  return allRows;
}

function parseJsonp(text) {
  const s = text.trim()
    .replace(/^[^(]+\(/, '').replace(/\);\s*$/, '').replace(/\)\s*$/, '');
  return JSON.parse(s);
}

function formatDateOffset(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function fetchLiveEventCandidates({ province = '', dateFrom, dateTo, limit = 60 }) {
  const rows = [];
  const pageSize = Math.min(Math.max(limit, 20), 100);
  const maxPages = province ? 2 : 4;
  for (let page = 1; page <= maxPages && rows.length < limit; page++) {
    const params = new URLSearchParams({
      page,
      PageSize: pageSize,
      eventType: '2',
      areaNum: province || '',
    });
    const text = await fetchTextWithRetry(`${EVENTS_API}?${params}`, {
      timeout: SEARCH_TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, 1);
    const json = JSON.parse(text);
    const pageRows = json.datArr?.rows || [];
    for (const row of pageRows) {
      if (String(row.event_value) !== '2' || !isGoEvent(row)) continue;
      const start = (row.min_time || '').substring(0, 10);
      const end = (row.max_time || row.min_time || '').substring(0, 10);
      if (dateFrom && end < dateFrom) continue;
      if (dateTo && start > dateTo) continue;
      rows.push({
        event_id: String(row.event_id),
        title: row.title || '',
        min_time: row.min_time || '',
        max_time: row.max_time || '',
        provincename: row.provincename || '',
        city_name: row.city_name || '',
        cname: row.cname || '',
        play_num: parseInt(row.play_num) || 0,
      });
      if (rows.length >= limit) break;
    }
    if (!pageRows.length) break;
    await delay(80);
  }
  return rows;
}

function eventStatusFromTimes(minTime, maxTime, now = Date.now()) {
  const start = parseChinaTime(minTime);
  const end = parseChinaTime(maxTime || minTime);
  if (start && end && start <= now && now <= end) return 'live';
  if (start && now < start) return 'upcoming';
  if (end && now - end <= 8 * 3600000) return 'today-ended';
  if (end && now - end <= 2 * 24 * 3600000) return 'recent-ended';
  return 'old';
}

function liveEventStatusLabel(status) {
  return {
    live: '进行中',
    upcoming: '即将开始',
    'today-ended': '今日结束',
    'recent-ended': '近期结束',
  }[status] || '可查询';
}

function liveStatusOrder(status) {
  return {
    live: 0,
    upcoming: 1,
    'today-ended': 2,
    'recent-ended': 3,
  }[status] ?? 9;
}

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      if (item) await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function fetchLiveEventGroups(eventId, eventTitle = '') {
  const html = await fetchTextWithRetry(`${DETAIL_BASE}${eventId}.html`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: SEARCH_TIMEOUT_MS,
  }, 1);
  const groups = [];
  const title = eventTitle || htmlDecode(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '');
  const seen = new Set();
  const anchorRe = /<a\b[^>]*data-groupid=["']?\d+["']?[^>]*>/gi;
  let m;
  while ((m = anchorRe.exec(html))) {
    const attrs = parseDataAttrs(m[0]);
    if (!attrs.groupid || seen.has(attrs.groupid)) continue;
    seen.add(attrs.groupid);
    if (isGoEvent({ title }) && isGoGroup(title, attrs.groupname)) groups.push(attrs);
  }
  if (groups.length === 0) throw new Error('no groups found');
  return groups;
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

function parseChinaTime(value) {
  if (!value) return null;
  const cleaned = String(value).trim().replace(/\.\d+$/, '');
  const m = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
  return Date.UTC(+y, +mo - 1, +d, +h - 8, +mi, +s);
}

function isLiveGroup(group, now = Date.now()) {
  const begin = parseChinaTime(group.bt);
  const end = parseChinaTime(group.et);
  if (begin && end) return begin <= now && now <= end;
  if (begin) return begin <= now && now - begin < 3 * 24 * 3600000;
  return String(group.groupstate || '') === '0';
}

function minDateValue(values) {
  return values.filter(Boolean).sort()[0] || '';
}

function maxDateValue(values) {
  return values.filter(Boolean).sort().pop() || '';
}

async function fetchGroupParticipantsLive(groupId) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const params = new URLSearchParams({ groupid: String(groupId), callback: 'cb' });
    const text = await fetchTextWithRetry(`${EVENTPART_API}?${params}`, {
      headers: { Referer: 'https://www.yunbisai.com/' },
      timeout: SEARCH_TIMEOUT_MS,
    }, 1);
    const data = parseJsonp(text);
    if (data.datArr === 'wait') {
      await delay(800);
      continue;
    }
    if (data.error !== 0) throw new Error(data.msg || 'Eventpart API error');
    return (data.datArr?.rows || []).map(row => ({
      id: String(row.participantid || row.id || row.pid || ''),
      name: row.participantname || row.name || '',
      org: row.teamname || row.othername || '',
      short_no: String(row.short || ''),
      win: parseInt(row.vicsum) || 0,
      lose: parseInt(row.faisum) || 0,
      draw: parseInt(row.deusum) || 0,
      score: parseFloat(row.integral) || 0,
      cloud_rank: parseInt(row.compositor) || 0,
    })).filter(p => p.id && p.name);
  }
  throw new Error(`participants wait timeout for group ${groupId}`);
}

async function fetchGroupMatchesLive(groupId, requestedTotalRounds = 0) {
  const manualRowsPromise = getLivePairingOverrides(groupId);
  const first = await fetchGroupRoundLive(groupId, 1);
  const cloudTotalRounds = parseInt(first.total_bout) || 0;
  const totalRounds = cloudTotalRounds || inferTotalRoundsFromRows(first.rows || []);
  const fetchThroughRound = Math.max(totalRounds, parseInt(requestedTotalRounds) || 0);
  const firstRows = first.rows || [];
  const allRows = normalizeLiveRoundRows(groupId, 1, firstRows);
  const seenRoundPayloads = new Set();
  const firstSignature = liveRoundPayloadSignature(firstRows);
  if (firstSignature) seenRoundPayloads.add(firstSignature);

  const remainingBouts = Array.from({ length: Math.max(fetchThroughRound - 1, 0) }, (_, index) => index + 2);
  await mapLimit(remainingBouts, ROUND_FETCH_CONCURRENCY, async bout => {
    const data = await fetchGroupRoundLive(groupId, bout);
    const rawRows = data.rows || [];
    const signature = liveRoundPayloadSignature(rawRows);
    const isCloudFallback = signature && seenRoundPayloads.has(signature);
    if (!isCloudFallback) {
      allRows.push(...normalizeLiveRoundRows(groupId, bout, rawRows));
      if (signature) seenRoundPayloads.add(signature);
    }
  });

  const cloudRounds = new Set(allRows.map(row => row.bout));
  const manualPairingRounds = new Set();
  const manualRows = normalizeLivePairingOverrideRows(await manualRowsPromise);
  for (const row of manualRows) {
    if (row.bout > fetchThroughRound || cloudRounds.has(row.bout)) continue;
    allRows.push(row);
    manualPairingRounds.add(row.bout);
  }
  allRows.sort((a, b) => a.bout - b.bout || a.seat - b.seat);

  const knownPairingRounds = Math.max(0, ...allRows.map(r => r.bout));
  const rounds = new Map();
  for (const row of allRows) {
    if (!rounds.has(row.bout)) rounds.set(row.bout, []);
    rounds.get(row.bout).push(row);
  }
  let completedRounds = 0;
  for (let bout = 1; bout <= fetchThroughRound; bout++) {
    const rows = rounds.get(bout) || [];
    if (!rows.length || !rows.every(isPlayedMatch)) break;
    completedRounds = bout;
  }

  return {
    rows: allRows,
    totalRounds,
    totalRoundsSource: cloudTotalRounds ? 'cloud' : 'inferred',
    completedRounds,
    knownPairingRounds,
    manualPairingRounds: [...manualPairingRounds].sort((a, b) => a - b),
  };
}

function normalizeLivePairingOverrideRows(rows) {
  return rows
    .filter(row => row.p1_id && row.p2_id)
    .map(row => ({
      group_id: String(row.group_id),
      bout: parseInt(row.bout) || 0,
      seat: parseInt(row.seat) || 0,
      p1_id: String(row.p1_id),
      p2_id: String(row.p2_id),
      p1_name: row.p1_name || '',
      p2_name: row.p2_name || '',
      p1_org: row.p1_org || '',
      p2_org: row.p2_org || '',
      p1_result: '',
      p2_result: '',
      p1_score: 0,
      p2_score: 0,
    }));
}

function liveRoundPayloadSignature(rows) {
  if (!rows?.length) return '';
  return rows
    .map(row => String(row.againstplanid || `${row.seatnum || ''}:${row.p1id || ''}:${row.p2id || ''}`))
    .sort()
    .join('|');
}

async function fetchGroupRoundLive(groupId, bout) {
  const params = new URLSearchParams({ groupid: String(groupId), team: 0, bout, callback: 'cb' });
  const text = await fetchTextWithRetry(`${AGAINSTPLAN_API}?${params}`, {
    headers: AGAINSTPLAN_HEADERS,
    timeout: 8000,
  }, 1);
  const data = parseJsonp(text);
  if (data.error && data.error !== 0) throw new Error(data.msg || 'Againstplan API error');
  return data.datArr || { rows: [] };
}

function inferTotalRoundsFromRows(rows) {
  const n = rows?.length ? rows.length * 2 : 0;
  if (n <= 8) return 5;
  if (n <= 32) return 7;
  return 9;
}

function normalizeLiveRoundRows(groupId, bout, rows) {
  return rows
    .filter(row => (
      (row.p1id && String(row.p1id) !== '0')
      || (row.p2id && String(row.p2id) !== '0')
    ))
    .map(row => {
      const p1Id = row.p1id && String(row.p1id) !== '0'
        ? String(row.p1id)
        : LIVE_BYE_OPPONENT_ID;
      const p2Id = row.p2id && String(row.p2id) !== '0'
        ? String(row.p2id)
        : LIVE_BYE_OPPONENT_ID;
      return {
        group_id: String(groupId),
        bout,
        seat: parseInt(row.seatnum) || 0,
        p1_id: p1Id,
        p2_id: p2Id,
        p1_name: row.p1 || (p1Id === LIVE_BYE_OPPONENT_ID ? '轮空' : ''),
        p2_name: row.p2 || (p2Id === LIVE_BYE_OPPONENT_ID ? '轮空' : ''),
        p1_org: row.p1_teamname || '',
        p2_org: row.p2_teamname || '',
        p1_result: String(row.p1_result ?? ''),
        p2_result: String(row.p2_result ?? ''),
        p1_score: parseFloat(row.p1_score) || 0,
        p2_score: parseFloat(row.p2_score) || 0,
      };
    });
}

function reconcileLivePlayers(players, matches) {
  const matchStats = new Map(players.map(player => [String(player.id), {
    score: 0,
    win: 0,
    lose: 0,
    draw: 0,
    games: 0,
    throughRound: 0,
  }]));

  for (const row of matches) {
    if (!isPlayedMatch(row)) continue;
    applyLiveMatchResult(matchStats.get(row.p1_id), row.p1_result, row.p2_result, row.p1_score, row.p2_score, row.bout);
    applyLiveMatchResult(matchStats.get(row.p2_id), row.p2_result, row.p1_result, row.p2_score, row.p1_score, row.bout);
  }

  let updatedCount = 0;
  let updatedThroughRound = 0;
  const reconciledPlayers = players.map(player => {
    const stats = matchStats.get(String(player.id));
    const cloudGames = (parseInt(player.win) || 0) + (parseInt(player.lose) || 0) + (parseInt(player.draw) || 0);
    const useRoundResults = Boolean(stats && stats.games > cloudGames);
    if (!useRoundResults) return { ...player, score_reconciled: false };

    updatedCount += 1;
    updatedThroughRound = Math.max(updatedThroughRound, stats.throughRound);
    return {
      ...player,
      score: roundNumber(stats.score),
      win: stats.win,
      lose: stats.lose,
      draw: stats.draw,
      score_reconciled: true,
    };
  });

  return {
    players: reconciledPlayers,
    updatedCount,
    updatedThroughRound,
  };
}

function applyLiveMatchResult(stats, ownResult, opponentResult, ownScore, opponentScore, bout) {
  if (!stats) return;
  const result = resolveLiveMatchResult(ownResult, opponentResult, ownScore, opponentScore);
  if (!result) return;

  const parsedScore = parseFloat(ownScore);
  const fallbackScore = result === 'win' ? 2 : result === 'draw' ? 1 : 0;
  stats.score += Number.isFinite(parsedScore) ? parsedScore : fallbackScore;
  stats[result] += 1;
  stats.games += 1;
  stats.throughRound = Math.max(stats.throughRound, parseInt(bout) || 0);
}

function resolveLiveMatchResult(ownResult, opponentResult, ownScore, opponentScore) {
  return resolveMatchResult(ownResult, opponentResult, ownScore, opponentScore) || '';
}

function computeCurrentRanking(players, matches, totalRounds) {
  const playerMap = new Map(players.map(p => [String(p.id), p]));
  const useComputedRanks = players.some(player => player.score_reconciled);
  const scoreMap = new Map(players.map(p => [String(p.id), parseFloat(p.score) || 0]));
  const opponentSets = buildInitialOpponentSets(players, matches);
  const rows = rankPlayersFromScores(players, scoreMap, opponentSets, Math.max(totalRounds || 0, 1));
  return rows.map(row => ({
    ...row,
    cloud_rank: playerMap.get(row.id)?.cloud_rank || 0,
    display_rank: useComputedRanks ? row.rank : (playerMap.get(row.id)?.cloud_rank || row.rank),
    score_reconciled: Boolean(playerMap.get(row.id)?.score_reconciled),
    win: playerMap.get(row.id)?.win || 0,
    lose: playerMap.get(row.id)?.lose || 0,
    draw: playerMap.get(row.id)?.draw || 0,
  }));
}

async function getCachedLivePrediction(options) {
  const key = [
    options.groupId,
    options.participantId,
    options.simulations,
    options.requestedTotalRounds,
    options.nextResult,
  ].join(':');
  const cached = livePredictionResults.get(key);
  if (cached?.promise) return cached.promise;
  if (cached?.value && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  if (livePredictionResults.size > 500) {
    const now = Date.now();
    for (const [cacheKey, entry] of livePredictionResults) {
      if (entry.expiresAt <= now) livePredictionResults.delete(cacheKey);
    }
  }

  const promise = predictPlayerRank(options);
  livePredictionResults.set(key, {
    promise,
    value: null,
    expiresAt: Date.now() + LIVE_SNAPSHOT_TTL_MS,
  });
  try {
    const value = await promise;
    livePredictionResults.set(key, {
      promise: null,
      value,
      expiresAt: Date.now() + LIVE_SNAPSHOT_TTL_MS,
    });
    return value;
  } catch (err) {
    if (livePredictionResults.get(key)?.promise === promise) livePredictionResults.delete(key);
    throw err;
  }
}

async function predictPlayerRank({
  groupId,
  participantId,
  simulations,
  requestedTotalRounds = 0,
  nextResult = '',
}) {
  const snapshot = await getLiveGroupSnapshot(groupId, requestedTotalRounds);
  const { players: rawPlayers, matchData } = snapshot;
  const liveState = reconcileLivePlayers(rawPlayers, matchData.rows);
  const players = liveState.players;
  const selected = players.find(p => String(p.id) === String(participantId));
  if (!selected) throw new Error('player not found in group');

  const currentRows = computeCurrentRanking(players, matchData.rows, Math.max(matchData.completedRounds || 0, 1));
  const current = currentRows.find(p => p.id === String(participantId));
  const minimumTotalRounds = Math.max(matchData.completedRounds || 0, matchData.knownPairingRounds || 0, 1);
  const totalRounds = requestedTotalRounds
    ? Math.max(requestedTotalRounds, minimumTotalRounds)
    : Math.max(matchData.totalRounds || 0, minimumTotalRounds);
  const rowsByBout = groupMatchesByBout(matchData.rows);
  const pairingPlayers = selectActiveSimulationPlayers(players, matchData.rows, matchData.completedRounds);
  const nextOpponent = findNextKnownOpponent({
    participantId,
    matches: matchData.rows,
    players,
    currentRows,
    completedRounds: matchData.completedRounds,
    totalRounds,
  });
  const normalizedNextResult = ['win', 'loss'].includes(nextResult) ? nextResult : '';
  const appliedNextResult = nextOpponent && !nextOpponent.is_bye ? normalizedNextResult : '';
  const playerId = String(participantId);
  const counts = new Map();

  for (let i = 0; i < simulations; i++) {
    const scoreMap = new Map(players.map(p => [String(p.id), parseFloat(p.score) || 0]));
    const opponentSets = buildInitialOpponentSets(players, matchData.rows);
    const playedKeys = new Set(matchData.rows.filter(isPlayedMatch).map(matchKey));

    for (let bout = 1; bout <= totalRounds; bout++) {
      const rows = rowsByBout.get(bout) || [];
      const unplayedRows = rows.filter(row => !playedKeys.has(matchKey(row)) && !isPlayedMatch(row));
      if (unplayedRows.length) {
        for (const row of unplayedRows) {
          const isSelectedNextMatch = appliedNextResult
            && row.bout === nextOpponent.bout
            && (row.p1_id === playerId || row.p2_id === playerId);
          if (isSelectedNextMatch) {
            simulateKnownPairingWithPlayerResult(row, playerId, appliedNextResult, scoreMap, opponentSets);
          } else {
            simulateKnownPairing(row, scoreMap, opponentSets);
          }
        }
        continue;
      }
      if (rows.length) continue;
      const pairings = buildSwissPairings(pairingPlayers, scoreMap, opponentSets);
      for (const pairing of pairings) simulateGeneratedPairing(pairing, scoreMap, opponentSets);
    }

    const ranked = rankPlayersFromScores(players, scoreMap, opponentSets, totalRounds);
    const target = ranked.find(p => p.id === playerId);
    counts.set(target.rank, (counts.get(target.rank) || 0) + 1);
  }

  const probabilities = [...counts.entries()]
    .map(([rank, count]) => ({
      rank,
      count,
      probability: count / simulations,
    }))
    .sort((a, b) => b.probability - a.probability || a.rank - b.rank)
    .slice(0, 5);

  return {
    group_id: String(groupId),
    total_rounds: totalRounds,
    detected_total_rounds: matchData.totalRounds,
    total_rounds_source: requestedTotalRounds ? 'manual' : matchData.totalRoundsSource,
    completed_rounds: matchData.completedRounds,
    known_pairing_rounds: matchData.knownPairingRounds,
    manual_pairing_rounds: matchData.manualPairingRounds,
    score_updates_applied: liveState.updatedCount > 0,
    score_updated_players: liveState.updatedCount,
    score_updated_through_round: liveState.updatedThroughRound,
    next_bout: matchData.completedRounds < totalRounds ? matchData.completedRounds + 1 : null,
    snapshot_at: snapshot.snapshotAt,
    next_opponent: nextOpponent,
    next_result: appliedNextResult,
    simulations,
    model: {
      pairing: 'real-pairings-then-swiss-active-roster',
      pairing_players: pairingPlayers.length,
      win_probability: appliedNextResult ? `next-match-fixed-${appliedNextResult}` : 'equal-strength-50-50',
      ranking_rule: 'cloud-total-score',
    },
    player: {
      id: String(selected.id),
      name: selected.name,
      org: selected.org,
    },
    current,
    probabilities,
  };
}

function simulateKnownPairingWithPlayerResult(row, participantId, result, scoreMap, opponentSets) {
  const playerId = String(participantId);
  const opponentId = row.p1_id === playerId ? row.p2_id : row.p1_id;
  addOpponents(row.p1_id, row.p2_id, opponentSets);
  addScore(result === 'win' ? playerId : opponentId, 2, scoreMap);
}

function findNextKnownOpponent({ participantId, matches, players, currentRows, completedRounds, totalRounds }) {
  const playerId = String(participantId);
  const nextMatch = matches
    .filter(row => (
      row.bout > completedRounds
      && row.bout <= totalRounds
      && !isPlayedMatch(row)
      && (row.p1_id === playerId || row.p2_id === playerId)
    ))
    .sort((a, b) => a.bout - b.bout || a.seat - b.seat)[0];
  if (!nextMatch) return null;

  const isPlayerOne = nextMatch.p1_id === playerId;
  const opponentId = isPlayerOne ? nextMatch.p2_id : nextMatch.p1_id;
  const fallbackName = isPlayerOne ? nextMatch.p2_name : nextMatch.p1_name;
  const fallbackOrg = isPlayerOne ? nextMatch.p2_org : nextMatch.p1_org;
  const isBye = String(opponentId) === LIVE_BYE_OPPONENT_ID;
  const opponent = players.find(player => String(player.id) === String(opponentId));
  const opponentCurrent = currentRows.find(player => String(player.id) === String(opponentId));

  return {
    bout: nextMatch.bout,
    seat: nextMatch.seat,
    id: String(opponentId),
    name: isBye ? '轮空' : (opponent?.name || fallbackName || ''),
    org: isBye ? '' : (opponent?.org || fallbackOrg || ''),
    is_bye: isBye,
    current_rank: isBye ? null : (opponentCurrent?.display_rank || opponentCurrent?.cloud_rank || opponentCurrent?.rank || null),
    score: isBye ? null : (opponentCurrent?.score ?? opponent?.score ?? null),
    opponent_score: isBye ? null : (opponentCurrent?.opponent_score ?? null),
    win: isBye ? 0 : (opponent?.win || 0),
    lose: isBye ? 0 : (opponent?.lose || 0),
    draw: isBye ? 0 : (opponent?.draw || 0),
  };
}

const LIVE_BYE_OPPONENT_ID = '__live_bye__';

function selectActiveSimulationPlayers(players, matches, completedRounds) {
  const round = parseInt(completedRounds) || 0;
  if (!round) return players;

  const playerIds = new Set(players.map(player => String(player.id)));
  const activeIds = new Set();
  for (const row of matches) {
    if (row.bout !== round) continue;
    if (playerIds.has(row.p1_id)) activeIds.add(row.p1_id);
    if (playerIds.has(row.p2_id)) activeIds.add(row.p2_id);
  }
  if (activeIds.size < 2) return players;
  return players.filter(player => activeIds.has(String(player.id)));
}

function groupMatchesByBout(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.bout)) map.set(row.bout, []);
    map.get(row.bout).push(row);
  }
  return map;
}

function buildInitialOpponentSets(players, rows) {
  const sets = new Map(players.map(p => [String(p.id), new Set()]));
  for (const row of rows) {
    if (!isPlayedMatch(row)) continue;
    const hasP1 = sets.has(row.p1_id);
    const hasP2 = sets.has(row.p2_id);
    if (hasP1 && !hasP2) {
      sets.get(row.p1_id).add(LIVE_BYE_OPPONENT_ID);
      continue;
    }
    if (!hasP1 && hasP2) {
      sets.get(row.p2_id).add(LIVE_BYE_OPPONENT_ID);
      continue;
    }
    if (!hasP1 || !hasP2) continue;
    sets.get(row.p1_id).add(row.p2_id);
    sets.get(row.p2_id).add(row.p1_id);
  }
  return sets;
}

function matchKey(row) {
  return `${row.bout}:${row.p1_id}:${row.p2_id}`;
}

function simulateKnownPairing(row, scoreMap, opponentSets) {
  const hasP1 = scoreMap.has(row.p1_id);
  const hasP2 = scoreMap.has(row.p2_id);
  if (hasP1 !== hasP2) {
    const byePlayer = hasP1 ? row.p1_id : row.p2_id;
    addScore(byePlayer, 2, scoreMap);
    opponentSets.get(byePlayer)?.add(LIVE_BYE_OPPONENT_ID);
    return;
  }

  addOpponents(row.p1_id, row.p2_id, opponentSets);
  if (Math.random() < 0.5) {
    addScore(row.p1_id, 2, scoreMap);
  } else {
    addScore(row.p2_id, 2, scoreMap);
  }
}

function simulateGeneratedPairing(pairing, scoreMap, opponentSets) {
  if (pairing.bye) {
    addScore(pairing.bye, 2, scoreMap);
    opponentSets.get(String(pairing.bye))?.add(LIVE_BYE_OPPONENT_ID);
    return;
  }
  addOpponents(pairing.p1, pairing.p2, opponentSets);
  if (Math.random() < 0.5) {
    addScore(pairing.p1, 2, scoreMap);
  } else {
    addScore(pairing.p2, 2, scoreMap);
  }
}

function addScore(id, score, scoreMap) {
  scoreMap.set(String(id), (scoreMap.get(String(id)) || 0) + score);
}

function addOpponents(a, b, opponentSets) {
  if (!opponentSets.has(String(a)) || !opponentSets.has(String(b))) return;
  opponentSets.get(String(a)).add(String(b));
  opponentSets.get(String(b)).add(String(a));
}

function buildSwissPairings(players, scoreMap, opponentSets) {
  const queue = players
    .map(player => {
      const id = String(player.id);
      const opponentScore = [...(opponentSets.get(id) || [])]
        .filter(opponentId => opponentId !== LIVE_BYE_OPPONENT_ID)
        .reduce((sum, opponentId) => sum + (scoreMap.get(String(opponentId)) || 0), 0);
      return {
        id,
        score: scoreMap.get(id) || 0,
        opponentScore,
        short: parseInt(player.short_no) || 9999,
      };
    })
    .sort((a, b) => b.score - a.score || b.opponentScore - a.opponentScore || a.short - b.short);
  const pairings = [];
  let byePlayer = null;

  if (queue.length % 2 === 1) {
    let byeIndex = -1;
    for (let index = queue.length - 1; index >= 0; index--) {
      if (!opponentSets.get(queue[index].id)?.has(LIVE_BYE_OPPONENT_ID)) {
        byeIndex = index;
        break;
      }
    }
    if (byeIndex < 0) byeIndex = queue.length - 1;
    byePlayer = queue.splice(byeIndex, 1)[0];
  }

  while (queue.length > 1) {
    const player = queue.shift();
    let bestIndex = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let index = 0; index < queue.length; index++) {
      const opponent = queue[index];
      if (opponentSets.get(player.id)?.has(opponent.id)) continue;
      const cost = Math.abs(player.score - opponent.score) * 100000
        + Math.abs(player.opponentScore - opponent.opponentScore) * 100
        + index;
      if (cost < bestCost) {
        bestCost = cost;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) bestIndex = 0;
    const opponent = queue.splice(bestIndex, 1)[0];
    pairings.push({ p1: player.id, p2: opponent.id });
  }

  if (byePlayer) pairings.push({ bye: byePlayer.id });
  return pairings;
}

function rankPlayersFromScores(players, scoreMap, opponentSets, roundsForFormula) {
  const maxScore = Math.max(1, ...players.map(p => scoreMap.get(String(p.id)) || 0));
  const rows = players.map(p => {
    const id = String(p.id);
    const score = scoreMap.get(id) || 0;
    const opponentScore = [...(opponentSets.get(id) || [])].reduce((sum, oppId) => sum + (scoreMap.get(String(oppId)) || 0), 0);
    const totalScore = score + (opponentScore * 2 / maxScore - roundsForFormula);
    return {
      id,
      name: p.name,
      org: p.org,
      short_no: p.short_no,
      score: roundNumber(score),
      opponent_score: roundNumber(opponentScore),
      total_score: roundNumber(totalScore, 5),
    };
  });

  rows.sort((a, b) =>
    b.total_score - a.total_score ||
    b.score - a.score ||
    (parseInt(a.short_no) || 9999) - (parseInt(b.short_no) || 9999) ||
    a.name.localeCompare(b.name, 'zh-CN')
  );

  let last = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (last && nearlyEqual(row.total_score, last.total_score) && nearlyEqual(row.score, last.score)) {
      row.rank = last.rank;
    } else {
      row.rank = i + 1;
    }
    last = row;
  }
  return rows;
}

function nearlyEqual(a, b) {
  return Math.abs((a || 0) - (b || 0)) < 0.00001;
}

function roundNumber(value, digits = 2) {
  const base = Math.pow(10, digits);
  return Math.round((parseFloat(value) || 0) * base) / base;
}

function findHeadToHeadGames(rows, playerAId, playerBId, candidate) {
  const games = [];
  for (const row of rows) {
    const aIsP1 = String(row.p1_id) === String(playerAId);
    const aIsP2 = String(row.p2_id) === String(playerAId);
    const bIsP1 = String(row.p1_id) === String(playerBId);
    const bIsP2 = String(row.p2_id) === String(playerBId);
    if (!((aIsP1 && bIsP2) || (aIsP2 && bIsP1))) continue;
    const result = matchResultForSide(row, aIsP1 ? 'p1' : 'p2');
    if (!result) continue;
    games.push({
      bout: row.bout,
      result,
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

app.post('/api/crawl/start', requireAdmin, express.json(), (req, res) => {
  if (getCrawlerState().running)
    return res.status(409).json({ error: '爬虫正在运行' });
  const { eventType = '2', province = '', indexAfter = true } = req.body || {};
  if (String(eventType) !== '2') return res.status(400).json({ error: '仅支持围棋比赛成绩' });
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

app.post('/api/crawl/stop', requireAdmin, (_req, res) => {
  stopCrawl();
  res.json({ stopped: true });
});

app.get('/api/index/status', async (_req, res) => {
  const stats = await getStats();
  res.json({ ...getIndexerState(), stats });
});

app.post('/api/index/start', requireAdmin, express.json(), (req, res) => {
  if (getIndexerState().running)
    return res.status(409).json({ error: '索引正在运行' });
  const { province = '', dateFrom, dateTo, force = false, limit = 0 } = req.body || {};
  runIndex({ province, dateFrom, dateTo, force, limit }).catch(console.error);
  res.json({ started: true });
});

app.post('/api/index/stop', requireAdmin, (_req, res) => {
  stopIndex();
  res.json({ stopped: true });
});

// ── 定时任务：每天凌晨 2:30 刷新赛事列表 ─────────────────────────────────────
cron.schedule('30 2 * * *', () => {
  console.log('[Scheduler] Nightly crawl triggered.');
  runCrawl()
    .then(() => runIndex())
    .then(async () => {
      for (const group of await queryExcludedResultGroups()) {
        try { await getOrFetchGroupMatches(group.group_id, group.rounds); } catch (_) { /* Still quarantined. */ }
      }
    })
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
