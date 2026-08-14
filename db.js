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

function envNonNegativeInt(name, fallback) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const INDEX_REFRESH_PAST_DAYS = envNonNegativeInt('INDEX_REFRESH_PAST_DAYS', 45);
const INDEX_REFRESH_FUTURE_DAYS = envNonNegativeInt('INDEX_REFRESH_FUTURE_DAYS', 14);
const RECENT_EVENT_REFRESH_COND = `(
  e.updated_at > COALESCE(ie.indexed_at, 0)
  AND date(e.min_time) BETWEEN date('now', '-${INDEX_REFRESH_PAST_DAYS} days') AND date('now', '+${INDEX_REFRESH_FUTURE_DAYS} days')
)`;

const NEEDS_INDEX_COND = `(
  ie.event_id IS NULL
  OR ${RECENT_EVENT_REFRESH_COND}
  OR ie.last_error LIKE 'SQLITE_%'
  OR ie.last_error LIKE '%database is locked%'
  OR ie.last_error LIKE '%cannot start a transaction%'
  OR ie.last_error LIKE '%timeout%'
  OR ie.last_error LIKE '%socket hang up%'
  OR ie.last_error LIKE '%ECONNRESET%'
  OR ie.last_error LIKE '%ETIMEDOUT%'
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
      rank             INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS group_match_cache (
      group_id      TEXT NOT NULL DEFAULT '',
      bout          INTEGER NOT NULL DEFAULT 0,
      p1_id         TEXT NOT NULL DEFAULT '',
      p2_id         TEXT NOT NULL DEFAULT '',
      p1_name       TEXT NOT NULL DEFAULT '',
      p2_name       TEXT NOT NULL DEFAULT '',
      p1_org        TEXT NOT NULL DEFAULT '',
      p2_org        TEXT NOT NULL DEFAULT '',
      p1_result     TEXT NOT NULL DEFAULT '',
      p2_result     TEXT NOT NULL DEFAULT '',
      p1_score      REAL NOT NULL DEFAULT 0,
      p2_score      REAL NOT NULL DEFAULT 0,
      updated_at    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (group_id, bout, p1_id, p2_id)
    );

    CREATE INDEX IF NOT EXISTS idx_group_match_cache_group ON group_match_cache (group_id, bout);
    CREATE INDEX IF NOT EXISTS idx_group_match_cache_p1 ON group_match_cache (p1_name, p2_name);
    CREATE INDEX IF NOT EXISTS idx_group_match_cache_p2 ON group_match_cache (p2_name, p1_name);

    CREATE TABLE IF NOT EXISTS group_match_cache_status (
      group_id      TEXT PRIMARY KEY,
      rounds        INTEGER NOT NULL DEFAULT 0,
      updated_at    INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS event_notice_cache (
      event_id      TEXT PRIMARY KEY,
      notice_text   TEXT NOT NULL DEFAULT '',
      updated_at    INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT NOT NULL DEFAULT ''
    );
  `, err => err ? rej(err) : res())
).then(ensureParticipantRankColumn);

async function ensureParticipantRankColumn() {
  const cols = await all('PRAGMA table_info(participant_index)');
  if (cols.some(c => c.name === 'rank')) return;
  await run('ALTER TABLE participant_index ADD COLUMN rank INTEGER NOT NULL DEFAULT 0');
}

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
  if (!force) conds.push(NEEDS_INDEX_COND);

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
       SUM(CASE WHEN ${NEEDS_INDEX_COND} THEN 0 ELSE 1 END) AS indexedEventCount,
       SUM(CASE WHEN ${NEEDS_INDEX_COND} THEN 1 ELSE 0 END) AS unindexedEventCount
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
       p.org, p.win, p.lose, p.draw, p.score, p.rank
     FROM participant_index p
     JOIN events e ON e.event_id = p.event_id
     WHERE ${conds.join(' AND ')} ORDER BY e.min_time DESC`,
    params
  );
}

async function queryParticipantsForGroups(groupIds) {
  await initPromise;
  const ids = [...new Set((groupIds || []).map(String).filter(Boolean))];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');

  return all(
    `SELECT
       e.event_id, e.title, e.min_time, e.provincename, e.city_name, e.cname,
       p.group_id, p.group_name, p.participant_id, p.participant_name,
       p.org, p.win, p.lose, p.draw, p.score, p.rank
     FROM participant_index p
     JOIN events e ON e.event_id = p.event_id
     WHERE p.group_id IN (${placeholders})`,
    ids
  );
}

async function queryHeadToHeadCandidates({ playerA, playerB, province = '', dateFrom, dateTo, limit = 250 }) {
  await initPromise;
  const params = [playerA, playerB];
  const conds = [
    'p1.participant_name = ?',
    'p2.participant_name = ?',
    'p1.participant_id <> p2.participant_id',
  ];

  if (province) { conds.push('e.provincename = ?'); params.push(province); }
  if (dateFrom) { conds.push('e.min_time >= ?'); params.push(dateFrom); }
  if (dateTo) { conds.push('e.min_time <= ?'); params.push(dateTo); }

  params.push(limit);

  return all(
    `SELECT
       e.event_id, e.title, e.min_time, e.provincename, e.city_name, e.cname,
       p1.group_id, p1.group_name,
       p1.participant_id AS player_a_id, p1.participant_name AS player_a_name, p1.org AS player_a_org,
       p2.participant_id AS player_b_id, p2.participant_name AS player_b_name, p2.org AS player_b_org,
       (p1.win + p1.lose + p1.draw) AS player_a_rounds,
       (p2.win + p2.lose + p2.draw) AS player_b_rounds
     FROM participant_index p1
     JOIN participant_index p2
       ON p2.event_id = p1.event_id
      AND p2.group_id = p1.group_id
     JOIN events e ON e.event_id = p1.event_id
     WHERE ${conds.join(' AND ')}
     ORDER BY e.min_time DESC
     LIMIT ?`,
    params
  );
}

async function queryPromotionCandidates({ name, province = '', dateFrom, dateTo }) {
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
       p.org, p.win, p.lose, p.draw, p.score, p.rank,
       eg.pnumber AS group_size,
       (SELECT COUNT(*) FROM participant_index px WHERE px.group_id = p.group_id) AS indexed_group_size
     FROM participant_index p
     JOIN events e ON e.event_id = p.event_id
     LEFT JOIN event_groups eg ON eg.group_id = p.group_id
     WHERE ${conds.join(' AND ')}
     ORDER BY e.min_time DESC`,
    params
  );
}

async function getGroupMatchCache(group_id) {
  await initPromise;
  const [status, rows] = await Promise.all([
    get(`SELECT group_id, rounds, updated_at, last_error FROM group_match_cache_status WHERE group_id = ?`, [String(group_id)]),
    all(`SELECT * FROM group_match_cache WHERE group_id = ? ORDER BY bout ASC`, [String(group_id)]),
  ]);
  return { status: status || null, rows };
}

async function getEventNoticeCache(event_id) {
  await initPromise;
  return get(
    `SELECT event_id, notice_text, updated_at, last_error
     FROM event_notice_cache WHERE event_id = ?`,
    [String(event_id)]
  );
}

async function replaceEventNoticeCache({ event_id, notice_text = '', last_error = '', updated_at = Date.now() }) {
  return withWriteLock(async () => {
    await initPromise;
    return run(
      `INSERT OR REPLACE INTO event_notice_cache
         (event_id, notice_text, updated_at, last_error)
       VALUES (?, ?, ?, ?)`,
      [String(event_id), notice_text || '', updated_at, last_error || '']
    );
  });
}

async function replaceGroupMatchCache({ group_id, rounds, rows, last_error = '', updated_at = Date.now() }) {
  return withWriteLock(async () => {
    await initPromise;
    const sql = `
      INSERT OR REPLACE INTO group_match_cache
        (group_id, bout, p1_id, p2_id, p1_name, p2_name, p1_org, p2_org, p1_result, p2_result, p1_score, p2_score, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    await run('BEGIN IMMEDIATE');
    try {
      await run('DELETE FROM group_match_cache WHERE group_id = ?', [String(group_id)]);
      for (const r of rows) {
        await run(sql, [
          String(group_id), parseInt(r.bout) || 0,
          String(r.p1_id || ''), String(r.p2_id || ''),
          r.p1_name || '', r.p2_name || '', r.p1_org || '', r.p2_org || '',
          String(r.p1_result ?? ''), String(r.p2_result ?? ''),
          parseFloat(r.p1_score) || 0, parseFloat(r.p2_score) || 0,
          updated_at,
        ]);
      }
      await run(
        `INSERT OR REPLACE INTO group_match_cache_status
          (group_id, rounds, updated_at, last_error)
         VALUES (?, ?, ?, ?)`,
        [String(group_id), parseInt(rounds) || 0, updated_at, last_error || '']
      );
      await run('COMMIT');
    } catch (err) {
      await run('ROLLBACK');
      throw err;
    }
  });
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
        (event_id, group_id, group_name, participant_id, participant_name, org, short_no, win, lose, draw, score, rank, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    await run('BEGIN IMMEDIATE');
    try {
      await run('DELETE FROM participant_index WHERE event_id = ?', [String(event_id)]);
      for (const p of participants) {
        await run(sql, [
          String(p.event_id), String(p.group_id), p.group_name || '',
          String(p.participant_id), p.participant_name || '', p.org || '', p.short_no || '',
          parseInt(p.win) || 0, parseInt(p.lose) || 0, parseInt(p.draw) || 0,
          String(p.score ?? ''), parseInt(p.rank) || 0, p.updated_at || Date.now(),
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
  queryParticipantsForGroups,
  queryPromotionCandidates,
  queryHeadToHeadCandidates,
  getGroupMatchCache,
  replaceGroupMatchCache,
  getEventNoticeCache,
  replaceEventNoticeCache,
  upsertIndexedEvent,
  upsertEventGroups,
  replaceParticipantsForEvent,
  getStats,
};
