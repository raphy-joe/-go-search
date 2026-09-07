'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { isGoEvent, isGoGroup, sportSql } = require('../sport-filter');
const { assessYunMatches } = require('../result-quality');

test('Yunbisai rejects other sports and ambiguous multi-sport groups', () => {
  assert.equal(isGoEvent({ title: '\u56fd\u9645\u8c61\u68cb\u6bd4\u8d5b', event_value: '2' }), false);
  assert.equal(isGoEvent({ title: '\u56f4\u68cb\u6bd4\u8d5b', event_value: '1' }), false);
  assert.equal(isGoEvent({ title: '\u56f4\u68cb\u6bd4\u8d5b', event_value: '2' }), true);
  assert.equal(isGoGroup('\u56f4\u68cb\u8c61\u68cb\u6bd4\u8d5b', '\u56f4\u68cb\u7ec4'), true);
  assert.equal(isGoGroup('\u56f4\u68cb\u8c61\u68cb\u6bd4\u8d5b', 'U10'), false);
  assert.equal(isGoGroup('\u56f4\u68cb\u6bd4\u8d5b', '\u4e94\u5b50\u68cb\u7ec4'), false);
});

test('legacy SQL filtering agrees with ingestion filtering', async () => {
  const db = new sqlite3.Database(':memory:');
  const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, error => error ? reject(error) : resolve());
  });
  try {
    await run('CREATE TABLE events(title TEXT, group_name TEXT)');
    const rows = [
      ['\u56f4\u68cb\u8c61\u68cb\u6bd4\u8d5b', '\u56f4\u68cb\u7ec4'],
      ['\u56f4\u68cb\u8c61\u68cb\u6bd4\u8d5b', '\u8c61\u68cb\u7ec4'],
      ['\u56fd\u9645\u8c61\u68cb\u6bd4\u8d5b', 'A'],
      ['\u56f4\u68cb\u6bd4\u8d5b', '3\u6bb5\u7ec4'],
      ['\u68cb\u7c7b\u8fd0\u52a8\u4f1a', 'U10'],
    ];
    for (const row of rows) await run('INSERT INTO events VALUES(?,?)', row);
    const actual = await new Promise((resolve, reject) => {
      db.all(`SELECT * FROM events WHERE ${sportSql('title', 'group_name')}`,
        (error, result) => error ? reject(error) : resolve(result));
    });
    assert.equal(actual.length, rows.filter(([title, group]) => isGoEvent({ title }) && isGoGroup(title, group)).length);
  } finally {
    await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
  }
});

test('small result gaps remain unknown and severe gaps are excluded', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    bout: 1, p1_id: String(index * 2 + 1), p2_id: String(index * 2 + 2),
    p1_result: index < 8 ? '1' : '', p2_result: index < 8 ? '2' : '',
  }));
  assert.equal(assessYunMatches(rows).eligible, true);
  rows[7].p1_result = rows[7].p2_result = '';
  assert.equal(assessYunMatches(rows).eligible, false);
});

test('missing interior rounds are excluded without assuming future rounds', () => {
  const rows = [1, 2, 3].map(bout => ({ bout, p1_id: '1', p2_id: '2', p1_result: '1', p2_result: '2' }));
  assert.equal(assessYunMatches(rows).eligible, true);
  assert.equal(assessYunMatches([rows[0], rows[2]]).eligible, false);
});
