'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePromotionSequence, promotionQuota } = require('../promotions');

test('promotion paths are unique and strictly increasing across kyu and dan ranks', () => {
  const path = normalizePromotionSequence([
    { date: '2024-01-01', event_id: '1', promotedTo: '10级' },
    { date: '2024-02-01', event_id: '2', promotedTo: '5级' },
    { date: '2024-03-01', event_id: '3', promotedTo: '5级' },
    { date: '2024-04-01', event_id: '4', promotedTo: '2级' },
    { date: '2024-05-01', event_id: '5', promotedTo: '1段' },
    { date: '2024-06-01', event_id: '6', promotedTo: '3级' },
    { date: '2024-07-01', event_id: '7', promotedTo: '1段' },
    { date: '2024-08-01', event_id: '8', promotedTo: '2段' },
  ]);

  assert.deepEqual(path.map(item => item.promotedTo), ['10级', '5级', '2级', '1段', '2段']);
});

test('promotion quota rounds a fractional Sichuan quota upward', () => {
  assert.equal(promotionQuota(30, 7, 'ceil'), 3);
  assert.equal(promotionQuota(47, 15, 'ceil'), 8);
});
