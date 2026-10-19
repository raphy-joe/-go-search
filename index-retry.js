'use strict';

function classifyIndexFailure(error) {
  const message = String(error || '');
  if (/429|503|502|504|timeout|ECONN|EAI_AGAIN|COOLDOWN|\bwait\b/i.test(message)) return { reason: 'transient', baseMs: 300000 };
  if (/HTTP (404|410)|EMPTY_GROUPS/i.test(message)) return { reason: 'unavailable', baseMs: 86400000 };
  if (/INVALID_|MISMATCH|DUPLICATE|UNSUPPORTED/i.test(message)) return { reason: 'schema', baseMs: 86400000 };
  if (/MISSING_|COVERAGE|REGRESSION|INCOMPLETE|EMPTY_PARTICIPANTS/i.test(message)) return { reason: 'incomplete', baseMs: 21600000 };
  return { reason: 'upstream', baseMs: 3600000 };
}

function retrySchedule(error, attempts, now = Date.now(), random = Math.random) {
  const { reason, baseMs } = classifyIndexFailure(error);
  const delay = Math.min(3 * 86400000, baseMs * 2 ** Math.min(8, Math.max(0, attempts - 1)));
  return { reason, nextAttemptAt: now + delay + Math.floor(random() * Math.min(60000, delay / 10)) };
}
module.exports = { classifyIndexFailure, retrySchedule };
