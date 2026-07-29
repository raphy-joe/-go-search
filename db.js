'use strict';

/**
 * db.js — SQLite 数据库层
 *
 * 只存赛事列表（events 表）。
 * 参赛者数据仍由搜索时实时从云比赛 API 获取。
 */

const sqlite3 = require('sqlite3').verbose();
const path    = require('path');
const fs      = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const db = new sqlite3.Database(path.join(DATA_DIR, 'yunbisai.db'));
db.configure('busyTimeout', 10000);

// ── Promise wrappers ──────────────────────────────────────────────────────────
function run(sql, params = []) {
  return new Promise((res, rej) =>
    db.run(sql, params, function (err) { err ? rej(err) : res(this); })
  );
}
function all(sql, params = []) {
  return new Promise((res, rej) =>
    db.all(sql, params, (err, rows) => err ? rej(err) : res(rows))
  );
}
function get(sql, params = []) {
  return new Promise((res, rej) =>
    db.get(sql, params, (err, row) => err ? rej(err) : res(row))
  );
}

let writeLock = Promise.resolve();
function withWriteLock(fn) {
  const next = writeLock.then(fn, fn);
  writeLock = next.catch(() => {});
  return next;
}

const RETRYABLE_INDEX_COND = `(
  ie.event_id IS NULL
  OR ie.last_error LIKE 'SQLITE_%'
  OR ie.last_error LIKE '%database is locked%'
  OR ie.last_error LIKE '%cannot start a transaction%'
  OR ie.last_error LIKE '%timeout%'
  OR ie.last_error LIKE 'HTTP %'
)`;

// ── Schema ────────────────────────────────────────────────────────────────────
const initPromise = new Promise((res, rej) =>
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous  = NORMAL;

    CREATE TABLE IF NOT EXISTS events (
      event_id     TEXT    PRIMARY KEY,
      title        TEXT    NOT NULL DEFAULT '',
      min_time     TEXT    NOT NULL DEFAULT '',
      provincename TEXT    NOT NULL DEFAULT '',
      city_name    TEXT    NOT NULL DEFAULT '',
      cname        TEXT    NOT NULL DEFAULT '',
      play_num     INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_events_province ON events (provincename);
    CREATE INDEX IF NOT EXISTS idx_events_time     ON events (min_time);
    CREATE INDEX IF NOT EXISTS idx_events_filter_province ON events (provincename, min_time, play_num);
    CREATE INDEX IF NOT EXISTS idx_events_filter_time     ON events (min_time, play_num);
    CREATE INDEX IF NOT EXISTS idx_events_play_time_event ON events (play_num, min_time, event_id);
    CREATE INDEX IF NOT EXISTS idx_events_province_play_time_event ON events (provincename, play_num, min_time, event_id);

    CREATE TABLE IF NOT EXISTS event_groups (
      group_id     TEXT PRIMARY KEY,
      event_id     TEXT NOT NULL DEFAULT '',
      group_name   TEXT NOT NULL DEFAULT '',
      team_type    TEXT NOT NULL DEFAULT '0',
      pnumber      INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_event_groups_event ON event_groups (event_id);

    CREATE TABLE IF NOT EXISTS participant_index (
      event_id         TEXT NOT NULL DEFAULT '',
      group_id         TEXT NOT NULL DEFAULT '',
      group_name       TEXT NOT NULL DEFAULT '',
      participant_id   TEXT NOT NULL DEFAULT '',
      participant_name TEXT NOT NULL DEFAULT '',
      org              TEXT NOT NULL DEFAULT '',
      short_no         TEXT NOT NULL DEFAULT '',
      win              INTEGER NOT NULL DEFAULT 0,
      lose             INTEGER NOT NULL DEFAULT 0,
      draw             INTEGER NOT NULL DEFAULT 0,
      score            TEXT NOT NULL DEFAULT '',
      updated_at       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (event_id, group_id, participant_id)
    );

    CREATE INDEX IF NOT EXISTS idx_participant_index_name  ON participant_index (participant_name);
    CREATE INDEX IF NOT EXISTS idx_participant_index_name_event ON participant_index (participant_name, event_id);
    CREATE INDEX IF NOT EXISTS idx_participant_index_name_event_group ON participant_index (participant_name, event_id, group_id, participant_id);
    CREATE INDEX IF NOT EXISTS idx_participant_index_event ON participant_index (event_id);
    CREATE INDEX IF NOT EXISTS idx_participant_index_group ON participant_index (group_id);

    CREATE TABLE IF NOT EXISTS indexed_events (
      event_id           TEXT PRIMARY KEY,
      indexed_at         INTEGER NOT NULL DEFAULT 0,
      group_count        INTEGER NOT NULL DEFAULT 0,
      participant_count  INTEGER NOT NULL DEFAULT 0,
      last_error         TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_indexed_events_error_event ON indexed_events (last_error, event_id);
  `, err => err ? rej(err) : res())
);

// ── Queries ───────────────────────────────────────────────────────────────────

/** 批量 upsert 赛事（单事务） */
async function upsertEvents(events) {
  return withWriteLock(async () => {
    await initPromise;
    const sql = `
      INSERT OR REPLACE INTO events
        (event_id, title, min_time, provincename, city_name, cname, play_num, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    await run('BEGIN IMMEDIATE');
    try {
      for (const e of events) {
        await run(sql, [
          e.event_id, e.title, e.min_time,
          e.provincename, e.city_name, e.cname,
          e.play_num, e.updated_at,
        ]);
      }
      await run('COMMIT');
    } catch (err) {
      await run('ROLLBACK');
      throw err;
    }
  });
}

/**
 * 查询符合条件的赛事（用于搜索时过滤）
 * @returns {Promise<Array>}
 */
async function queryEvents({ province, dateFrom, dateTo }) {
  await initPromise;
  const params = [];
  const conds  = ['play_num > 0'];

  if (province) { conds.push('provincename = ?'); params.push(province); }
  if (dateFrom) { conds.push('min_time >= ?');     params.push(dateFrom); }
  if (dateTo)   { conds.push('min_time <= ?');     params.push(dateTo); }

  return all(
    `SELECT event_id, title, min_time, provincename, city_name, cname
     FROM events WHERE ${conds.join(' AND ')} ORDER BY min_time DESC`,
    params
  );
}

async function queryEventsForIndex({ province = '', dateFrom, dateTo, force = false, limit = 0 }) {
  await initPromise;
  const params = [];
  const conds  = ['e.play_num > 0'];

  if (province) { conds.push('e.provincename = ?'); params.push(province); }
  if (dateFrom) { conds.push('e.min_time >= ?');     params.push(dateFrom); }
  if (dateTo)   { conds.push('e.min_time <= ?');     params.push(dateTo); }
  if (!force) conds.push(RETRYABLE_INDEX_COND);

  const limitClause = limit ? ' LIMIT ?' : '';
  if (limit) params.push(limit);

  return all(
    `SELECT e.event_id, e.title, e.min_time, e.provincename, e.city_name, e.cname
     FROM events e
     LEFT JOIN indexed_events ie ON ie.event_id = e.event_id
     WHERE ${conds.join(' AND ')} ORDER BY e.min_time DESC${limitClause}`,
    params
  );
}

async function queryUnindexedEvents({ province, dateFrom, dateTo }) {
  return queryEventsForIndex({ province, dateFrom, dateTo, force: false });
}

async function getIndexCoverage({ province = '', dateFrom, dateTo }) {
  await initPromise;
  const params = [];
  const conds = ['e.play_num > 0'];

  if (province) { conds.push('e.provincename = ?'); params.push(province); }
  if (dateFrom) { conds.push('e.min_time >= ?'); params.push(dateFrom); }
  if (dateTo) { conds.push('e.min_time <= ?'); params.push(dateTo); }

  return get(
    `SELECT
       COUNT(*) AS eventCount,
       SUM(CASE WHEN ${RETRYABLE_INDEX_COND} THEN 0 ELSE 1 END) AS indexedEventCount,
       SUM(CASE WHEN ${RETRYABLE_INDEX_COND} THEN 1 ELSE 0 END) AS unindexedEventCount
     FROM events e
     LEFT JOIN indexed_events ie ON ie.event_id = e.event_id
     WHERE ${conds.join(' AND ')}`,
    params
  );
}

async function queryParticipants({ name, province = '', dateFrom, dateTo }) {
  await initPromise;
  const params = [name];
  const conds = ['p.participant_name = ?'];

  if (province) { conds.push('e.provincename = ?'); params.push(province); }
  if (dateFrom) { conds.push('e.min_time >= ?'); params.push(dateFrom); }
  if (dateTo) { conds.push('e.min_time <= ?'); params.push(dateTo); }

  return all(
    `SELECT
       e.event_id, e.title, e.min_time, e.provincename, e.city_name, e.cname,
       p.group_id, p.group_name, p.participant_id, p.participant_name,
       p.org, p.win, p.lose, p.draw, p.score
     FROM participant_index p
     JOIN events e ON e.event_id = p.event_id
     WHERE ${conds.join(' AND ')} ORDER BY e.min_time DESC`,
    params
  );
}

async function upsertIndexedEvent({ event_id, group_count = 0, participant_count = 0, last_error = '', indexed_at = Date.now() }) {
  return withWriteLock(async () => {
    await initPromise;
    return run(
      `INSERT OR REPLACE INTO indexed_events
         (event_id, indexed_at, group_count, participant_count, last_error)
       VALUES (?, ?, ?, ?, ?)`,
      [String(event_id), indexed_at, group_count, participant_count, last_error]
    );
  });
}

async function upsertEventGroups(groups) {
  return withWriteLock(async () => {
    await initPromise;
    const sql = `
      INSERT OR REPLACE INTO event_groups
        (group_id, event_id, group_name, team_type, pnumber, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    await run('BEGIN IMMEDIATE');
    try {
      for (const g of groups) {
        await run(sql, [
          String(g.group_id), String(g.event_id), g.group_name || '',
          String(g.team_type ?? '0'), parseInt(g.pnumber) || 0, g.updated_at || Date.now(),
        ]);
      }
      await run('COMMIT');
    } catch (err) {
      await run('ROLLBACK');
      throw err;
    }
  });
}

async function replaceParticipantsForEvent(event_id, participants) {
  return withWriteLock(async () => {
    await initPromise;
    const sql = `
      INSERT OR REPLACE INTO participant_index
        (event_id, group_id, group_name, participant_id, participant_name, org, short_no, win, lose, draw, score, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    await run('BEGIN IMMEDIATE');
    try {
      await run('DELETE FROM participant_index WHERE event_id = ?', [String(event_id)]);
      for (const p of participants) {
        await run(sql, [
          String(p.event_id), String(p.group_id), p.group_name || '',
          String(p.participant_id), p.participant_name || '', p.org || '', p.short_no || '',
          parseInt(p.win) || 0, parseInt(p.lose) || 0, parseInt(p.draw) || 0,
          String(p.score ?? ''), p.updated_at || Date.now(),
        ]);
      }
      await run('COMMIT');
    } catch (err) {
      await run('ROLLBACK');
      throw err;
    }
  });
}

/** 获取 DB 中赛事总数和更新时间 */
async function getStats() {
  await initPromise;
  const [cnt, ts, pcnt, icnt, pts] = await Promise.all([
    get(`SELECT COUNT(*) AS c FROM events`),
    get(`SELECT MAX(updated_at) AS t FROM events`),
    get(`SELECT COUNT(*) AS c FROM participant_index`),
    get(`SELECT COUNT(*) AS c FROM indexed_events WHERE last_error = ''`),
    get(`SELECT MAX(updated_at) AS t FROM participant_index`),
  ]);
  return {
    eventCount: cnt.c,
    lastUpdated: ts.t,
    participantCount: pcnt.c,
    indexedEventCount: icnt.c,
    participantLastUpdated: pts.t,
  };
}

module.exports = {
  initPromise,
  upsertEvents,
  queryEvents,
  queryEventsForIndex,
  queryUnindexedEvents,
  getIndexCoverage,
  queryParticipants,
  upsertIndexedEvent,
  upsertEventGroups,
  replaceParticipantsForEvent,
  getStats,
};
