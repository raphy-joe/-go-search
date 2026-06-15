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
  `, err => err ? rej(err) : res())
);

// ── Queries ───────────────────────────────────────────────────────────────────

/** 批量 upsert 赛事（单事务） */
async function upsertEvents(events) {
  await initPromise;
  const sql = `
    INSERT OR REPLACE INTO events
      (event_id, title, min_time, provincename, city_name, cname, play_num, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;
  await run('BEGIN');
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

/** 获取 DB 中赛事总数和更新时间 */
async function getStats() {
  await initPromise;
  const [cnt, ts] = await Promise.all([
    get(`SELECT COUNT(*) AS c FROM events`),
    get(`SELECT MAX(updated_at) AS t FROM events`),
  ]);
  return { eventCount: cnt.c, lastUpdated: ts.t };
}

module.exports = { initPromise, upsertEvents, queryEvents, getStats };
