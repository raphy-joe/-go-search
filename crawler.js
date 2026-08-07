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
const PAGE_CONCURRENCY = parseInt(process.env.CRAWL_PAGE_CONCURRENCY || '2', 10);
const PAGE_DELAY_MS    = parseInt(process.env.CRAWL_PAGE_DELAY_MS || '350', 10);
const TIMEOUT_MS       = parseInt(process.env.CRAWL_TIMEOUT_MS || '15000', 10);
const PAGE_RETRIES     = parseInt(process.env.CRAWL_PAGE_RETRIES || '4', 10);

const delay = ms => new Promise(r => setTimeout(r, ms));
const activeControllers = new Set();

// ── 单例状态 ──────────────────────────────────────────────────────────────────
let state = {
  running:    false,
  startedAt:  null,
  pagesLoaded: 0,
  totalPages:  0,
  eventsStored: 0,
  failedPages: [],
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

async function fetchPageWithRetry(eventType, province, page) {
  let lastErr;
  for (let attempt = 0; attempt <= PAGE_RETRIES; attempt++) {
    try {
      return await fetchPage(eventType, province, page);
    } catch (err) {
      if (err.message === 'CRAWL_STOPPED' || err.name === 'AbortError') throw err;
      lastErr = err;
      const isRateLimited = /HTTP 429/.test(err.message);
      const isRetryable = isRateLimited || /timeout|socket hang up|ECONNRESET|ETIMEDOUT/i.test(err.message);
      if (!isRetryable || attempt === PAGE_RETRIES) break;
      const backoff = (isRateLimited ? 2500 : 800) * Math.pow(1.8, attempt);
      const jitter = Math.floor(Math.random() * 400);
      console.warn(`[Crawler] page ${page} failed (${err.message}), retry ${attempt + 1}/${PAGE_RETRIES} after ${Math.round(backoff + jitter)}ms.`);
      await delay(backoff + jitter);
    }
  }
  throw lastErr;
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
    failedPages: [],
    lastError: null,
    stopRequested: false,
  };
  console.log(`[Crawler] Start — type=${eventType} province="${province}"`);

  try {
    // 第 1 页：获取总页数
    const first = await fetchPageWithRetry(eventType, province, 1);
    state.totalPages  = first.TotalPage || 1;
    state.pagesLoaded = 1;
    const allRows = [...(first.rows || [])];

    // 剩余页并发拉取
    const remaining = Array.from({ length: state.totalPages - 1 }, (_, i) => i + 2);
    while (remaining.length) {
      throwIfStopped();
      const batch = remaining.splice(0, PAGE_CONCURRENCY);
      const pages = await Promise.all(batch.map(async page => {
        try {
          return { page, data: await fetchPageWithRetry(eventType, province, page) };
        } catch (err) {
          if (err.message === 'CRAWL_STOPPED' || err.name === 'AbortError') throw err;
          state.failedPages.push({ page, error: err.message });
          state.lastError = `page ${page}: ${err.message}`;
          console.warn(`[Crawler] page ${page} skipped after retries: ${err.message}`);
          return { page, data: null };
        }
      }));
      throwIfStopped();
      for (const pg of pages.filter(p => p.data)) {
        allRows.push(...(pg.data.rows || []));
        state.pagesLoaded++;
      }
      await delay(PAGE_DELAY_MS);
    }

    const failedCount = state.failedPages.length;
    console.log(`[Crawler] ${allRows.length} events fetched${failedCount ? ` (${failedCount} pages failed)` : ''}, saving to DB...`);

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
    if (failedCount) {
      const sample = state.failedPages.slice(0, 12).map(p => `${p.page}:${p.error}`).join(', ');
      console.warn(`[Crawler] Done with ${failedCount} failed pages. Sample: ${sample}`);
    }
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
