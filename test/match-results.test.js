'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isCompleteMatchCache,
  isPlayedMatch,
  matchResultForSide,
  matchScoreForSide,
  resolveMatchResult,
} = require('../match-results');

test('blank pairings remain unplayed instead of becoming draws', () => {
  const row = { p1_result: '', p2_result: '', p1_score: 0, p2_score: 0 };
  assert.equal(isPlayedMatch(row), false);
  assert.equal(matchResultForSide(row, 'p1'), null);
  assert.equal(matchScoreForSide(row, 'p1'), null);
});

test('result codes resolve from either side', () => {
  assert.equal(resolveMatchResult('1', '2', 0, 0), 'win');
  assert.equal(resolveMatchResult('', '1', 0, 0), 'lose');
  assert.equal(resolveMatchResult('3', '3', 0, 0), 'draw');
});

test('scores are only a fallback when the pairing has a non-zero score', () => {
  assert.equal(resolveMatchResult('', '', 2, 0), 'win');
  assert.equal(resolveMatchResult('', '', 0, 2), 'lose');
  assert.equal(resolveMatchResult('', '', 1, 1), 'draw');
});

test('only fully played rounds form a complete long-lived match cache', () => {
  const completed = [
    { bout: 1, p1_result: '1', p2_result: '2' },
    { bout: 2, p1_result: '2', p2_result: '1' },
  ];
  const pending = [
    ...completed,
    { bout: 3, p1_result: '', p2_result: '', p1_score: 0, p2_score: 0 },
  ];

  assert.equal(isCompleteMatchCache(completed, 2), true);
  assert.equal(isCompleteMatchCache(completed, 3), false);
  assert.equal(isCompleteMatchCache(pending, 3), false);
});
