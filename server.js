'use strict';

const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const cron    = require('node-cron');

const { initPromise, queryEvents, getStats } = require('./db');
const { runCrawl, stopCrawl, getState: getCrawlerState } = require('./crawler');

const app  = express();
const PORT = process.env.PORT || 3000;

const SEARCH_API      = 'https://api.yunbisai.com/request/event/SearchInfo';
const DETAIL_BASE     = 'https://www.yunbisai.com/tpl/eventFeatures/eventDetail-';
const AGAINSTPLAN_API = 'https://api.yunbisai.com/request/Group/Againstplan';

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
  const dateFrom  = yearFrom ? `${yearFrom}-01-01` : '0000-01-01';
  const dateTo    = yearTo   ? `${yearTo}-12-31`   : '9999-12-31';

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  let closed = false;
  res.on('close', () => { closed = true; });
  const send = obj => { if (!closed) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  try {
    // 从 DB 取赛事列表（毫秒级，省去分页请求）
    const events = await queryEvents({ province: cleanProvince, dateFrom, dateTo });

    if (events.length === 0) {
      send({ type: 'done', searched: 0, queued: 0 });
      return res.end();
    }

    send({
      type: 'progress', searched: 0, queued: events.length,
      pagesLoaded: 1, totalPages: 1,
    });

    // 并发按姓名搜索
    const CONCURRENCY = 8;
    let searched = 0;
    let lastAt   = 0;
    const queue  = [...events];

    async function worker() {
      while (queue.length && !closed) {
        const event = queue.shift();
        if (!event) break;
        await doSearch(event, cleanName, send);
        searched++;
        const now = Date.now();
        if (now - lastAt > 300 || queue.length === 0) {
          lastAt = now;
          send({ type: 'progress', searched, queued: events.length, pagesLoaded: 1, totalPages: 1 });
        }
        await delay(50);
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    send({ type: 'done', searched, queued: events.length });

  } catch (err) {
    send({ type: 'error', msg: err.message });
  }

  res.end();
});

// ── 搜索单个赛事 ──────────────────────────────────────────────────────────────
async function doSearch(event, name, send) {
  try {
    const params = new URLSearchParams({
      eventid: event.event_id, keywords: name, type: 1, callback: 'cb',
    });
    const r    = await fetch(`${SEARCH_API}?${params}`, {
      headers: { Referer: 'https://www.yunbisai.com/' }, timeout: 8000,
    });
    const text = await r.text();
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
  } catch (_) { /* skip */ }
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

  const results = [];
  for (let bout = 1; bout <= totalRounds; bout++) {
    try {
      const params = new URLSearchParams({ groupid: group_id, team: 0, bout, callback: 'cb' });
      const r      = await fetch(`${AGAINSTPLAN_API}?${params}`, {
        headers: AGAINSTPLAN_HEADERS, timeout: 8000,
      });
      const s    = (await r.text()).trim()
        .replace(/^[^(]+\(/, '').replace(/\);\s*$/, '').replace(/\)\s*$/, '');
      const data = JSON.parse(s);
      const rows = data.datArr?.rows ?? [];
      const row  = rows.find(m =>
        String(m.p1id) === String(player_id) || String(m.p2id) === String(player_id)
      );
      if (row) {
        const isP1 = String(row.p1id) === String(player_id);
        const raw  = isP1 ? row.p1_result : row.p2_result;
        results.push({
          bout,
          opponent:     isP1 ? row.p2          : row.p1,
          opponent_org: isP1 ? (row.p2_teamname || '') : (row.p1_teamname || ''),
          result:       raw == '1' ? 'win' : raw == '2' ? 'lose' : 'draw',
          score:        parseFloat(isP1 ? row.p1_score : row.p2_score) || 0,
          opp_score:    parseFloat(isP1 ? row.p2_score : row.p1_score) || 0,
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

// ── /api/crawl/* ──────────────────────────────────────────────────────────────

app.get('/api/crawl/status', async (_req, res) => {
  const stats = await getStats();
  res.json({ ...getCrawlerState(), stats });
});

app.post('/api/crawl/start', express.json(), (req, res) => {
  if (getCrawlerState().running)
    return res.status(409).json({ error: '爬虫正在运行' });
  const { eventType = '2', province = '' } = req.body || {};
  runCrawl({ eventType, province }).catch(console.error);
  res.json({ started: true });
});

app.post('/api/crawl/stop', (_req, res) => {
  stopCrawl();
  res.json({ stopped: true });
});

// ── 定时任务：每天凌晨 2:30 刷新赛事列表 ─────────────────────────────────────
cron.schedule('30 2 * * *', () => {
  console.log('[Scheduler] Nightly crawl triggered.');
  runCrawl().catch(console.error);
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
