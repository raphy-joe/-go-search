'use strict';

const { isPlayedMatch } = require('./match-results');
const MAX_MISSING_FRACTION = 0.2;

function assessYunMatches(rows) {
  const contests = rows.filter(r => r.p1_id && r.p2_id && r.p1_id !== '0' && r.p2_id !== '0' &&
    r.p1_name !== '\u8f6e\u7a7a' && r.p2_name !== '\u8f6e\u7a7a');
  if (!contests.length) return { eligible: false, reasons: ['no_played_results'] };
  const unknown = contests.filter(r => !isPlayedMatch(r)).length;
  const rounds = new Set(rows.map(r => Number(r.bout)).filter(Boolean));
  const reasons = [];
  if (unknown / contests.length > MAX_MISSING_FRACTION) reasons.push('too_many_unknown_results');
  if (rounds.size && rounds.size < Math.max(...rounds)) reasons.push('missing_published_rounds');
  return { eligible: reasons.length === 0, reasons, unknown, contests: contests.length };
}

module.exports = { MAX_MISSING_FRACTION, assessYunMatches };
