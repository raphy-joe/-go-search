'use strict';

/**
 * crawler.js — 赛事列表爬虫
 *
 * 功能：
 *   从云比赛平台拉取全量赛事列表并持久化到本地 SQLite。
 *   搜索时直接从 DB 过滤赛事，省去每次搜索时的分页加载。
 */

const fetch  = require('node-fetch');
const { upsertEvents, getStats } = require('./db');

const EVENTS_API       = 'https://data-center.yunbisai.com/api/lswl-events';
const PAGE_CONCURRENCY = 5;
const PAGE_DELAY_MS    = 100;
const TIMEOUT_MS       = 12000;

const delay = ms => new Promise(r => setTimeout(r, ms));
const activeControllers = new Set();

// ── 单例状态 ──────────────────────────────────────────────────────────────────
let state = {
  running:    false,
  startedAt:  null,
  pagesLoaded: 0,
  totalPages:  0,
  eventsStored: 0,
  lastError:  null,
  stopRequested: false,
};

function getState() { return { ...state }; }

function isStopRequested() {
  return state.stopRequested || !state.running;
}

function throwIfStopped() {
  if (isStopRequested()) throw new Error('CRAWL_STOPPED');
}

// ── 拉取单页 ──────────────────────────────────────────────────────────────────
async function fetchPage(eventType, province, page) {
  throwIfStopped();
  const params = new URLSearchParams({
    page, PageSize: 100, eventType, areaNum: province || '',
  });
  const controller = new AbortController();
  activeControllers.add(controller);
  try {
    const res = await fetch(`${EVENTS_API}?${params}`, {
      timeout: TIMEOUT_MS,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    throwIfStopped();
    return json.datArr || {};
  } finally {
    activeControllers.delete(controller);
  }
}

// ── 主入口 ────────────────────────────────────────────────────────────────────
async function runCrawl({ eventType = '2', province = '' } = {}) {
  if (state.running) { console.log('[Crawler] Already running.'); return; }

  state = {
    running: true,
    startedAt: Date.now(),
    pagesLoaded: 0,
    totalPages: 0,
    eventsStored: 0,
    lastError: null,
    stopRequested: false,
  };
  console.log(`[Crawler] Start — type=${eventType} province="${province}"`);

  try {
    // 第 1 页：获取总页数
    const first = await fetchPage(eventType, province, 1);
    state.totalPages  = first.TotalPage || 1;
    state.pagesLoaded = 1;
    const allRows = [...(first.rows || [])];

    // 剩余页并发拉取
    const remaining = Array.from({ length: state.totalPages - 1 }, (_, i) => i + 2);
    while (remaining.length) {
      throwIfStopped();
      const batch = remaining.splice(0, PAGE_CONCURRENCY);
      const pages = await Promise.all(batch.map(p => fetchPage(eventType, province, p)));
      throwIfStopped();
      for (const pg of pages) {
        allRows.push(...(pg.rows || []));
        state.pagesLoaded++;
      }
      await delay(PAGE_DELAY_MS);
    }

    console.log(`[Crawler] ${allRows.length} events fetched, saving to DB...`);

    // 持久化
    throwIfStopped();
    const now = Date.now();
    await upsertEvents(allRows.map(e => ({
      event_id:     String(e.event_id),
      title:        e.title        || '',
      min_time:     e.min_time     || '',
      provincename: e.provincename || '',
      city_name:    e.city_name    || '',
      cname:        e.cname        || '',
      play_num:     parseInt(e.play_num) || 0,
      updated_at:   now,
    })));

    state.eventsStored = allRows.length;
    const stats = await getStats();
    console.log(`[Crawler] Done. DB now has ${stats.eventCount} events.`);

  } catch (err) {
    if (err.message === 'CRAWL_STOPPED' || err.name === 'AbortError') {
      console.log('[Crawler] Stopped before completion; partial data was not saved.');
    } else {
      state.lastError = err.message;
      console.error('[Crawler] Error:', err.message);
    }
  } finally {
    state.running = false;
    activeControllers.clear();
  }
}

function stopCrawl() {
  if (!state.running) return;
  state.stopRequested = true;
  for (const controller of activeControllers) controller.abort();
  console.log('[Crawler] Stop requested.');
}

module.exports = { runCrawl, stopCrawl, getState };
