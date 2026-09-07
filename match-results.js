'use strict';

const VALID_RESULT_CODES = new Set(['1', '2', '3']);

function resultFromCode(value) {
  const code = String(value ?? '');
  if (code === '1') return 'win';
  if (code === '2') return 'lose';
  if (code === '3') return 'draw';
  return null;
}

function oppositeResult(result) {
  if (result === 'win') return 'lose';
  if (result === 'lose') return 'win';
  return result === 'draw' ? 'draw' : null;
}

function resolveMatchResult(ownResult, opponentResult, ownScore, opponentScore) {
  const direct = resultFromCode(ownResult);
  if (direct) return direct;

  const inverse = oppositeResult(resultFromCode(opponentResult));
  if (inverse) return inverse;

  const own = Number.parseFloat(ownScore);
  const opponent = Number.parseFloat(opponentScore);
  if (!Number.isFinite(own) || !Number.isFinite(opponent)) return null;
  if (own === 0 && opponent === 0) return null;
  if (own > opponent) return 'win';
  if (own < opponent) return 'lose';
  return 'draw';
}

function matchResultForSide(row, side = 'p1') {
  const isP1 = side === 'p1';
  return resolveMatchResult(
    isP1 ? row.p1_result : row.p2_result,
    isP1 ? row.p2_result : row.p1_result,
    isP1 ? row.p1_score : row.p2_score,
    isP1 ? row.p2_score : row.p1_score,
  );
}

function matchScoreForSide(row, side = 'p1') {
  const result = matchResultForSide(row, side);
  if (result === 'win') return 1;
  if (result === 'lose') return 0;
  if (result === 'draw') return 0.5;
  return null;
}

function isPlayedMatch(row) {
  if (!row) return false;
  return matchResultForSide(row, 'p1') !== null;
}

function isCompleteMatchCache(rows, rounds) {
  if (!rows.length || !rows.every(isPlayedMatch)) return false;
  const completedBouts = new Set(rows.map(row => parseInt(row.bout, 10) || 0).filter(Boolean));
  return completedBouts.size >= Math.max(parseInt(rounds, 10) || 0, 1);
}

function hasValidResultCode(value) {
  return VALID_RESULT_CODES.has(String(value ?? ''));
}

module.exports = {
  hasValidResultCode,
  isCompleteMatchCache,
  isPlayedMatch,
  matchResultForSide,
  matchScoreForSide,
  resolveMatchResult,
};
