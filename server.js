'use strict';

const express = require('express');
const rawFetch = require('node-fetch');
const { limitedFetch } = require('./resource-limits');
const fetch = (url, options) => limitedFetch(rawFetch, url, options);
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
  getIdentityNotices,
  getOperationalCacheHealth,
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
const { fetchEventGroups } = require('./yunbisai-groups');
const { validatePredictionSnapshot, reconcileLivePlayers, computeCurrentRanking, LIVE_BYE_OPPONENT_ID } = require('./prediction-engine');
const { runPrediction } = require('./prediction-runner');
const { securityHeaders, validateQuery, createRequestBudget, requestContext, sendApiError } = require('./api-security');
const { partitionPlayerRows, selectIdentity, identityChoices, recordKey } = require('./player-identity');
const modelVersions = require('./model-versions');
const { rankingRule } = require('./prediction-rules');
const { createTelemetry, healthAlerts } = require('./operations');
const telemetry = createTelemetry();

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
let systemStatusSnapshot = null;
let systemStatusInFlight = null;

async function readSystemStatus() {
  if (systemStatusSnapshot?.expiresAt > Date.now()) return systemStatusSnapshot.value;
  if (!systemStatusInFlight) {
    systemStatusInFlight = Promise.all([getStats(), getIndexCoverage({})]).then(value => {
      systemStatusSnapshot = { value, expiresAt: Date.now() + 30000 };
      return value;
    }).finally(() => { systemStatusInFlight = null; });
  }
  return systemStatusInFlight;
}

function trimLiveCache(cache, maximum) {
  for (const [key, entry] of cache) if (!entry.promise && entry.expiresAt <= Date.now()) cache.delete(key);
  for (const [key, entry] of cache) {
    if (cache.size < maximum) break;
    if (!entry.promise) cache.delete(key);
  }
}

function configuredLiveEventTotalRounds(eventId) {
  const rounds = parseInt(liveEventSettings[String(eventId)]?.total_rounds) || 0;
  return Math.min(Math.max(rounds, 0), 30);
}

app.set('trust proxy', 'loopback');
app.set('x-powered-by', false);
app.set('query parser', 'simple');
app.use(securityHeaders);
app.use(telemetry.middleware);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', validateQuery, createRequestBudget());
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
    const [, coverage] = await readSystemStatus();
    const total = coverage.eventCount || 0;
    const indexed = coverage.indexedEventCount || 0;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      last_updated: coverage.lastSuccessAt || null,
      last_attempt_at: coverage.lastAttemptAt || null,
      events: total,
      indexed_events: indexed,
      failed_events: coverage.failedEventCount || 0,
      partial_events: coverage.partialEventCount || 0,
      stale_events: coverage.staleEventCount || 0,
      coverage: total ? indexed / total : 0,
      crawler_running: getCrawlerState().running,
      indexer_running: getIndexerState().running,
    });
  } catch (err) {
    sendApiError(res, err);
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
  const queryDateTo = `${dateTo} 23:59:59`;

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  let closed = false;
  res.on('close', () => { closed = true; });
  const send = obj => { if (!closed) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  const found = new Map();
  const emitHit = hit => {
    const row = hitToIdentityRow(hit);
    const key = recordKey(row);
    if (found.has(key)) return;
    found.set(key, row);
    send(hit);
  };
  const emitIdentities = async () => {
    const profiles = await buildIdentityProfiles([...found.values()]);
    send({ type: 'identities', profiles: identityChoices(profiles),
      memberships: profiles.flatMap(p => p.rows.map(r => ({ key: recordKey(r), identity_id: p.id }))) });
  };

  try {
    // 从 DB 取赛事列表（毫秒级，省去分页请求）
    const coverage = await getIndexCoverage({ province: cleanProvince, dateFrom, dateTo: queryDateTo });
    const totalEventCount = coverage.eventCount || 0;
    const indexedEventCount = coverage.indexedEventCount || 0;
    const unindexedEventCount = coverage.unindexedEventCount || 0;
    const indexedHits = await queryParticipants({ name: cleanName, province: cleanProvince, dateFrom, dateTo: queryDateTo });
    for (const row of indexedHits) emitHit(indexedRowToHit(row));

    if (shouldReturnIndexOnly({ province: cleanProvince, unindexedEventCount, query: req.query })) {
      const backfillStarted = SEARCH_AUTO_BACKFILL
        ? startIndexBackfill({ province: cleanProvince, dateFrom, dateTo })
        : false;
      await emitIdentities();
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

    const events = await queryUnindexedEvents({ province: cleanProvince, dateFrom, dateTo: queryDateTo });

    if (events.length === 0) {
      await emitIdentities();
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
        const result = await doSearch(event, cleanName, emitHit);
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
    if (closed) return;
    await emitIdentities();
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
    console.warn('[Search] Query failed:', err.message);
    send({ type: 'error', msg: '查询暂时失败，请稍后重试' });
  }

  res.end();
});

function hitToIdentityRow(hit) {
  const { event, player } = hit;
  return { event_id: event.event_id, title: event.title, min_time: event.date,
    provincename: event.province, city_name: event.city, cname: event.organizer,
    group_id: player.groupid, group_name: player.group, participant_id: player.participantid,
    participant_name: player.name, org: player.org, win: player.win, lose: player.lose,
    draw: player.draw, score: player.score, rank: player.rank };
}

app.get('/healthz', async (_req,res)=>{
  try { await initPromise; await readSystemStatus(); res.setHeader('Cache-Control','no-store'); res.json({status:'ok',uptime_seconds:Math.floor(process.uptime()),models:modelVersions}); }
  catch (_) { res.status(503).json({status:'unavailable'}); }
});

app.get('/api/ops/status', requireAdmin, async (_req,res)=>{
  try {
    const [,coverage]=await readSystemStatus();
    const cache=await getOperationalCacheHealth();
    const requests=telemetry.snapshot();
    const alerts=healthAlerts({coverage,cache,requests});
    res.setHeader('Cache-Control','no-store');
    res.json({checked_at:Date.now(),coverage,cache,requests,alerts,models:modelVersions});
  } catch(error) { sendApiError(res,error); }
});

async function buildIdentityProfiles(rows) {
  const notices = await getIdentityNotices(rows.map(r => r.event_id));
  return partitionPlayerRows(rows, notices);
}

async function loadIdentity({ name, province, dateFrom, dateTo, identity }) {
  const end = String(dateTo || formatDateOffset(0)).slice(0,10);
  const start = dateFrom || `${Number(end.slice(0,4))-2}${end.slice(4)}`;
  const rows = await queryParticipants({ name, province, dateFrom: start, dateTo: `${end} 23:59:59` });
  const profiles = await buildIdentityProfiles(rows);
  return { profiles, selected: selectIdentity(profiles, identity) };
}

function requireSelectedIdentity(state) {
  if (state.profiles.length > 1 && !state.selected) {
    throw Object.assign(new Error('存在未确认的同名参赛轨迹，请先选择棋手'), { code: 'IDENTITY_REQUIRED', status: 409 });
  }
  return state.selected?.rows || [];
}

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
  if (unindexedEventCount > LIVE_FALLBACK_LIMIT) return true;
  if (query.live === '1' || query.full === '1') return false;
  if (!province) return true;
  return unindexedEventCount > LIVE_FALLBACK_LIMIT;
}

function startIndexBackfill({ province, dateFrom, dateTo }) {
  if (getIndexerState().running) return false;
  requestContext.exit(() => runIndex({ province, dateFrom, dateTo }).catch(console.error));
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
    if (data.error !== 0 || !Array.isArray(data.datArr)) throw new Error('INVALID_SEARCH_RESPONSE');
    {
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
      if (requestContext.getStore()?.aborted || options?.signal?.aborted) throw err;
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

  const totalRounds = Number(rounds);
  if (!Number.isInteger(totalRounds) || totalRounds < 1 || totalRounds > 30) {
    return res.status(400).json({ error: '轮次必须为 1 到 30 的整数' });
  }

  try {
    const groupRows = await getOrFetchGroupMatches(group_id, totalRounds);
    return res.json({ matches: buildPlayerMatches(groupRows, totalRounds, player_id),
      stale: Boolean(groupRows.cacheInfo?.stale), updated_at: groupRows.cacheInfo?.updated_at || null });
  } catch (err) {
    console.warn(`[Matches] group ${group_id} failed: ${err.message}`);
    return sendApiError(res, err, '对局暂时读取失败，请重试');
  }
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
    let failedEvents = 0;
    await mapLimit(candidates, 4, async event => {
      try {
        const groups = await fetchLiveEventGroups(event.event_id, event.title);
        if (!groups.length) return;
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
          detail_url: `https://m.yunbisai.com/event/${event.event_id}`,
          group_count: groups.length,
          live_group_count: liveGroups.length,
          status,
          status_label: liveEventStatusLabel(status),
          begins_at: minDateValue(groups.map(g => g.bt)) || event.min_time || '',
          ends_at: maxDateValue(groups.map(g => g.et)) || event.max_time || '',
        });
      } catch (err) {
        failedEvents++;
        console.warn(`[LiveEvents] event ${event.event_id} failed: ${err.message}`);
      }
    });
    events.sort((a, b) =>
      liveStatusOrder(a.status) - liveStatusOrder(b.status) ||
      (b.date || '').localeCompare(a.date || '') ||
      String(b.event_id).localeCompare(String(a.event_id))
    );
    if (!events.length && failedEvents) {
      return res.status(502).json({ error: '云比赛赛事组别暂时读取失败，请稍后重试', failed_events: failedEvents });
    }
    res.json({ events, scope: { province: province || '__ALL__', dateFrom, dateTo },
      failed_events: failedEvents,
      warning: failedEvents ? `有 ${failedEvents} 场赛事组别暂时读取失败，当前结果可能不完整` : '',
    });
  } catch (err) {
    sendApiError(res, err);
  }
});

app.get('/api/live-event', async (req, res) => {
  const eventId = String(req.query.event_id || '').trim();
  if (!/^\d+$/.test(eventId)) return res.status(400).json({ error: 'invalid event_id' });

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
    sendApiError(res, err);
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
    const rule = rankingRule(req.query.ranking_rule);
    const current = computeCurrentRanking(liveState.players, matchData.rows, Math.max(matchData.completedRounds || 0, 1), rule.id);
    let dataWarning = '';
    try { validatePredictionSnapshot(snapshot); } catch (error) { dataWarning = error.message; }
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
      players: dataWarning ? current.map(p => ({ ...p, opponent_score:null, total_score:null })) : current,
      data_warning: dataWarning,
      prediction_available: !dataWarning,
      snapshot_at: snapshot.snapshotAt,
      ranking_rule: rule,
    });
  } catch (err) {
    console.warn(`[LiveGroup] ${groupId} failed: ${err.message}`);
    sendApiError(res, err);
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
    const result = await getCachedLivePrediction({ groupId, participantId, simulations, requestedTotalRounds, nextResult,
      rankingRuleId:req.query.ranking_rule || '', seed:req.query.seed || '' });
    res.json(result);
  } catch (err) {
    console.warn(`[LivePrediction] group ${groupId} player ${participantId} failed: ${err.message}`);
    sendApiError(res, err);
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
    const a = await loadIdentity({ name: playerA, province, dateFrom, dateTo, identity: req.query.identity_a });
    const b = await loadIdentity({ name: playerB, province, dateFrom, dateTo, identity: req.query.identity_b });
    const identities = { a: identityChoices(a.profiles), b: identityChoices(b.profiles) };
    if (a.profiles.length && b.profiles.length && ((a.profiles.length > 1 && !a.selected) || (b.profiles.length > 1 && !b.selected))) {
      return res.json({ identity_required: true, identities, selected_identities: { a:a.selected?.id || '', b:b.selected?.id || '' },
        players: { a:playerA, b:playerB }, games:[], summary:{ games:0,win:0,lose:0,draw:0,winRate:0 } });
    }
    const aKeys = new Set((a.selected?.rows || []).map(recordKey));
    const bKeys = new Set((b.selected?.rows || []).map(recordKey));
    const allCandidates = await queryHeadToHeadCandidates({ playerA, playerB, province, dateFrom, dateTo, limit });
    const candidates = allCandidates.filter(c => aKeys.has(`${c.event_id}:${c.group_id}:${c.player_a_id}`)
      && bKeys.has(`${c.event_id}:${c.group_id}:${c.player_b_id}`));
    const games = [];
    let checkedGroups = 0;
    let failedGroups = 0;

    for (const c of candidates) {
      if (req.workSignal?.aborted) return;
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
      identities,
      selected_identities: { a:a.selected?.id || '', b:b.selected?.id || '' },
      scope: { province: province || '__ALL__', dateFrom, dateTo },
      summary,
      candidates: candidates.length,
      checkedGroups,
      failedGroups,
      partial: failedGroups > 0 || allCandidates.length >= limit,
      truncated: allCandidates.length >= limit,
      games,
    });
  } catch (err) {
    sendApiError(res, err);
  }
});

app.get('/api/strength', async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'missing player name' });

  const province = req.query.province === '__ALL__' ? '' : String(req.query.province || '');
  const dateTo = req.query.dateTo || undefined;

  try {
    const identityState = await loadIdentity({ name, province, dateFrom: req.query.dateFrom, dateTo, identity: req.query.identity });
    const result = await estimatePlayerStrength({
      name,
      province,
      dateTo,
      getOrFetchGroupMatches,
      identityRows: requireSelectedIdentity(identityState),
    });
    res.json(result);
  } catch (err) {
    console.warn(`[Strength] ${name} failed: ${err.message}`);
    sendApiError(res, err, '棋力评估暂时不可用，请重试');
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
    const identityState = await loadIdentity({ name, province, dateFrom, dateTo, identity: req.query.identity });
    const result = await estimatePromotionHistory({ name, province, dateFrom, dateTo,
      identityRows: requireSelectedIdentity(identityState), allowExternalEvidence: identityState.profiles.length <= 1 });
    res.json(result);
  } catch (err) {
    console.warn(`[Promotions] ${name} failed: ${err.message}`);
    sendApiError(res, err, '升段历史暂时不可用，请重试');
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
      opponent_id: isP1 ? row.p2_id : row.p1_id,
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
  if (!Number.isInteger(Number(rounds)) || Number(rounds) < 1 || Number(rounds) > 30) {
    throw new Error('INVALID_ROUND_COUNT');
  }
  const cached = await getGroupMatchCache(groupId);
  const cachedRows = normalizeCachedRows(cached.rows);
  rounds = Math.max(parseInt(rounds) || 1, parseInt(cached.status?.rounds) || 0,
    ...cachedRows.map(row => row.bout));
  if (rounds > 30) throw new Error('INVALID_CACHED_ROUND_COUNT');
  if (cached.status && !cached.status.last_error && hasAllMatchRounds(cachedRows, rounds)) {
    const complete = isCompleteMatchCache(cachedRows, rounds);
    const ttl = complete ? MATCH_CACHE_COMPLETE_TTL_MS : MATCH_CACHE_INCOMPLETE_TTL_MS;
    if (Date.now() - Number(cached.status.updated_at || 0) <= ttl) {
      const quality = await updateGroupResultQuality(groupId, cachedRows);
      if (!quality.eligible) throw new Error('INSUFFICIENT_RESULTS');
      cachedRows.cacheInfo = { stale: false, updated_at: cached.status.updated_at };
      return cachedRows;
    }
  }

  const key = `${String(groupId)}:${Math.max(parseInt(rounds) || 0, 1)}`;
  if (!groupMatchFetches.has(key)) {
    const request = (async () => {
      const rows = await fetchGroupMatches(groupId, rounds);
      if (!hasAllMatchRounds(rows, rounds)) throw new Error('INCOMPLETE_MATCH_RESPONSE');
      const stored = await replaceGroupMatchCache({ group_id: groupId, rounds, rows, preserveCoverage: true });
      let effectiveRows = rows;
      let cacheInfo = { stale: false, updated_at: Date.now() };
      if (stored === false) {
        const latest = await getGroupMatchCache(groupId);
        effectiveRows = normalizeCachedRows(latest.rows);
        const required = Math.max(rounds, parseInt(latest.status?.rounds) || 0);
        if (!hasAllMatchRounds(effectiveRows, required)) throw new Error('INCOMPLETE_MATCH_CACHE');
        cacheInfo = { stale: true, updated_at: latest.status?.updated_at || null };
        console.warn(`[Matches] retained fuller cache for group ${groupId}`);
      }
      const quality = await updateGroupResultQuality(groupId, effectiveRows);
      if (!quality.eligible) throw new Error('INSUFFICIENT_RESULTS');
      effectiveRows.cacheInfo = cacheInfo;
      return effectiveRows;
    })();
    groupMatchFetches.set(key, request);
  }

  const request = groupMatchFetches.get(key);
  try {
    return await request;
  } catch (err) {
    if (err.message === 'INSUFFICIENT_RESULTS') throw err;
    if (hasAllMatchRounds(cachedRows, rounds)) {
      const quality = await updateGroupResultQuality(groupId, cachedRows);
      if (!quality.eligible) throw new Error('INSUFFICIENT_RESULTS');
      console.warn(`[Matches] using stale cache for group ${groupId}: ${err.message}`);
      cachedRows.cacheInfo = { stale: true, updated_at: cached.status?.updated_at || null };
      return cachedRows;
    }
    throw err;
  } finally {
    if (groupMatchFetches.get(key) === request) groupMatchFetches.delete(key);
  }
}

function hasAllMatchRounds(rows, rounds) {
  if (!rows.length) return false;
  const bouts = new Set(rows.map(row => Number(row.bout)));
  for (let bout = 1; bout <= rounds; bout++) if (!bouts.has(bout)) return false;
  return true;
}

async function getLiveGroupSnapshot(groupId, requestedTotalRounds = 0) {
  const key = `${String(groupId)}:${parseInt(requestedTotalRounds) || 0}`;
  const cached = liveGroupSnapshots.get(key);
  if (cached && cached.value && cached.expiresAt > Date.now()) return cached.value;
  if (cached?.promise) return cached.promise;
  trimLiveCache(liveGroupSnapshots, 32);

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
  // Avoid upstream cache-generation races within the same historical group.
  await mapLimit(bouts, 1, async bout => {
    const params = new URLSearchParams({ groupid: groupId, team: 0, bout, callback: 'cb' });
    let rows;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const text = await fetchTextWithRetry(`${AGAINSTPLAN_API}?${params}`, {
          headers: AGAINSTPLAN_HEADERS,
          timeout: 8000,
        }, 1);
        const data = parseJsonp(text);
        if (data.error !== 0 || !Array.isArray(data.datArr?.rows) || !data.datArr.rows.length) {
          throw new Error(`INCOMPLETE_MATCH_ROUND group=${groupId} bout=${bout}`);
        }
        rows = data.datArr.rows;
        if (!rows.some(row => row.p1id && row.p2id)) throw new Error(`EMPTY_MATCH_ROUND bout=${bout}`);
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await delay(500 * (attempt + 1));
      }
    }
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
    if (Number(json.error) !== 0 || !Array.isArray(json.datArr?.rows)) {
      throw new Error('云比赛赛事列表暂时读取失败，请稍后重试');
    }
    const pageRows = json.datArr.rows;
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
  return fetchEventGroups(eventId, { fetchText: fetchTextWithRetry, eventTitle });
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
    if (!Array.isArray(data.datArr?.rows)) throw new Error('INVALID_PARTICIPANT_RESPONSE');
    return data.datArr.rows.map(row => ({
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
  if (cloudTotalRounds < 0 || cloudTotalRounds > 30) throw new Error('INVALID_UPSTREAM_ROUNDS');
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


async function getCachedLivePrediction(options) {
  const key = [
    options.groupId,
    options.participantId,
    options.simulations,
    options.requestedTotalRounds,
    options.nextResult,
    options.rankingRuleId,
    options.seed,
    modelVersions.prediction,
  ].join(':');
  const cached = livePredictionResults.get(key);
  if (cached?.promise) return cached.promise;
  if (cached?.value && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  trimLiveCache(livePredictionResults, 200);

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

async function predictPlayerRank(options) {
  const snapshot = await getLiveGroupSnapshot(options.groupId, options.requestedTotalRounds);
  return runPrediction({ ...options, snapshot }, { signal: requestContext.getStore() });
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
  try {
    const [stats] = await readSystemStatus();
    res.json({ ...getCrawlerState(), stats });
  } catch (err) { sendApiError(res, err); }
});

app.post('/api/crawl/start', requireAdmin, express.json(), (req, res) => {
  if (getCrawlerState().running)
    return res.status(409).json({ error: '爬虫正在运行' });
  const { eventType = '2', province = '', indexAfter = true } = req.body || {};
  if (String(eventType) !== '2') return res.status(400).json({ error: '仅支持围棋比赛成绩' });
  requestContext.exit(() => runCrawl({ eventType, province })
    .then(() => {
      const crawlState = getCrawlerState();
      if (indexAfter === false || crawlState.stopRequested || crawlState.eventsStored === 0) return;
      if (getIndexerState().running) {
        console.log('[Crawler] Index backfill skipped because indexer is already running.');
        return;
      }
      return runIndex({ province });
    })
    .catch(console.error));
  res.json({ started: true, indexAfter: indexAfter !== false });
});

app.post('/api/crawl/stop', requireAdmin, (_req, res) => {
  stopCrawl();
  res.json({ stopped: true });
});

app.get('/api/index/status', async (_req, res) => {
  try {
    const [stats] = await readSystemStatus();
    res.json({ ...getIndexerState(), stats });
  } catch (err) { sendApiError(res, err); }
});

app.post('/api/index/start', requireAdmin, express.json(), (req, res) => {
  if (getIndexerState().running)
    return res.status(409).json({ error: '索引正在运行' });
  const { province = '', dateFrom, dateTo, force = false, limit = 0 } = req.body || {};
  requestContext.exit(() => runIndex({ province, dateFrom, dateTo, force, limit }).catch(console.error));
  res.json({ started: true });
});

app.post('/api/index/stop', requireAdmin, (_req, res) => {
  stopIndex();
  res.json({ stopped: true });
});

// ── 定时任务：每天凌晨 2:30 刷新赛事列表 ─────────────────────────────────────
if (process.env.BACKGROUND_TASKS_DISABLED !== '1') cron.schedule('30 2 * * *', () => {
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
  if (eventCount === 0 && process.env.BACKGROUND_TASKS_DISABLED !== '1') {
    console.log('[Startup] DB empty — starting initial crawl.');
    runCrawl().catch(console.error);
  } else {
    const age = lastUpdated ? Math.round((Date.now() - lastUpdated) / 3600000) : '?';
    console.log(`[Startup] DB ready — ${eventCount} events (${age}h ago).`);
  }
}).catch(error => console.error('[Startup] Database initialization failed:', error.message));

// ── Helper ────────────────────────────────────────────────────────────────────
function randomStr() {
  return Array.from({ length: 6 }, () =>
    'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]
  ).join('');
}

app.listen(PORT, () => console.log(`✅  服务已启动：http://localhost:${PORT}`));
