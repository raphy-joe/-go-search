'use strict';

const { isPlayedMatch, resolveMatchResult } = require('./match-results');
const seedrandom = require('seedrandom');
const versions = require('./model-versions');
const { rankingRule, snapshotFingerprint } = require('./prediction-rules');

function validatePredictionSnapshot(snapshot) {
  const players = snapshot?.players || [];
  const rows = snapshot?.matchData?.rows || [];
  const fail = () => { throw Object.assign(new Error('历史轮次或对局数据不完整，暂不能计算概率，请刷新后重试'),
    { code: 'INCOMPLETE_PREDICTION_DATA', status: 422 }); };
  if (!players.length || players.length > 1500) fail();
  const ids = new Set(players.map(p => String(p.id)));
  if (ids.size !== players.length) fail();
  const playedCounts = new Map(), appearances = new Set(), bouts = new Map(), lastSeen = new Map();
  let lastPlayed = 0;
  for (const row of rows) {
    if (!Number.isInteger(row.bout) || row.bout < 1 || row.bout > 30) fail();
    if (!bouts.has(row.bout)) bouts.set(row.bout, []);
    bouts.get(row.bout).push(row);
    for (const id of [row.p1_id, row.p2_id]) {
      if (id === LIVE_BYE_OPPONENT_ID) continue;
      if (!ids.has(id)) fail();
      const key = `${row.bout}:${id}`;
      if (appearances.has(key)) fail();
      appearances.add(key);
      lastSeen.set(id, Math.max(lastSeen.get(id) || 0, row.bout));
      if (isPlayedMatch(row)) playedCounts.set(id, (playedCounts.get(id) || 0) + 1);
    }
    if (isPlayedMatch(row)) lastPlayed = Math.max(lastPlayed, row.bout);
  }
  for (const player of players) {
    const games = Number(player.win || 0) + Number(player.lose || 0) + Number(player.draw || 0);
    if (games > (playedCounts.get(String(player.id)) || 0)) fail();
    if (rows.length && !lastSeen.has(String(player.id))) fail();
  }
  for (const [bout, round] of bouts) {
    const previous = bouts.get(bout - 1) || (bout === 1 ? players.map(p => ({ p1_id:String(p.id) })) : []);
    for (const row of previous) {
      for (const id of [row.p1_id, row.p2_id]) {
        if (ids.has(id) && (lastSeen.get(id) || 0) >= lastPlayed - 1 && !appearances.has(`${bout}:${id}`)) fail();
      }
    }
    if (!round.length) fail();
  }
  for (let bout = 1; bout <= lastPlayed; bout++) {
    const round = bouts.get(bout);
    if (!round?.length || (bout < lastPlayed && !round.every(isPlayedMatch))) fail();
    for (const row of rows.filter(r => r.bout > bout)) {
      for (const id of [row.p1_id, row.p2_id]) {
        if (ids.has(id) && !appearances.has(`${bout}:${id}`)) fail();
      }
    }
  }
  return { lastPlayed };
}

function reconcileLivePlayers(players, matches) {
  const matchStats = new Map(players.map(player => [String(player.id), {
    score: 0,
    win: 0,
    lose: 0,
    draw: 0,
    games: 0,
    throughRound: 0,
  }]));

  for (const row of matches) {
    if (!isPlayedMatch(row)) continue;
    applyLiveMatchResult(matchStats.get(row.p1_id), row.p1_result, row.p2_result, row.p1_score, row.p2_score, row.bout);
    applyLiveMatchResult(matchStats.get(row.p2_id), row.p2_result, row.p1_result, row.p2_score, row.p1_score, row.bout);
  }

  let updatedCount = 0;
  let updatedThroughRound = 0;
  const reconciledPlayers = players.map(player => {
    const stats = matchStats.get(String(player.id));
    const cloudGames = (parseInt(player.win) || 0) + (parseInt(player.lose) || 0) + (parseInt(player.draw) || 0);
    const useRoundResults = Boolean(stats && stats.games > cloudGames);
    if (!useRoundResults) return { ...player, score_reconciled: false };

    updatedCount += 1;
    updatedThroughRound = Math.max(updatedThroughRound, stats.throughRound);
    return {
      ...player,
      score: roundNumber(stats.score),
      win: stats.win,
      lose: stats.lose,
      draw: stats.draw,
      score_reconciled: true,
    };
  });

  return {
    players: reconciledPlayers,
    updatedCount,
    updatedThroughRound,
  };
}

function applyLiveMatchResult(stats, ownResult, opponentResult, ownScore, opponentScore, bout) {
  if (!stats) return;
  const result = resolveLiveMatchResult(ownResult, opponentResult, ownScore, opponentScore);
  if (!result) return;

  const fallbackScore = result === 'win' ? 2 : result === 'draw' ? 1 : 0;
  stats.score += fallbackScore;
  stats[result] += 1;
  stats.games += 1;
  stats.throughRound = Math.max(stats.throughRound, parseInt(bout) || 0);
}

function resolveLiveMatchResult(ownResult, opponentResult, ownScore, opponentScore) {
  return resolveMatchResult(ownResult, opponentResult, ownScore, opponentScore) || '';
}

function computeCurrentRanking(players, matches, totalRounds, ruleId) {
  const playerMap = new Map(players.map(p => [String(p.id), p]));
  const useComputedRanks = players.some(player => player.score_reconciled);
  const scoreMap = new Map(players.map(p => [String(p.id), parseFloat(p.score) || 0]));
  const opponentSets = buildInitialOpponentSets(players, matches);
  const rows = rankPlayersFromScores(players, scoreMap, opponentSets, Math.max(totalRounds || 0, 1), ruleId);
  return rows.map(row => ({
    ...row,
    cloud_rank: playerMap.get(row.id)?.cloud_rank || 0,
    display_rank: useComputedRanks ? row.rank : (playerMap.get(row.id)?.cloud_rank || row.rank),
    score_reconciled: Boolean(playerMap.get(row.id)?.score_reconciled),
    win: playerMap.get(row.id)?.win || 0,
    lose: playerMap.get(row.id)?.lose || 0,
    draw: playerMap.get(row.id)?.draw || 0,
  }));
}

function predictPlayerRank({
  snapshot,
  groupId,
  participantId,
  simulations,
  requestedTotalRounds = 0,
  nextResult = '',
  rankingRuleId = '',
  seed = '',
  includeDistribution = false,
}) {
  const { lastPlayed } = validatePredictionSnapshot(snapshot);
  const rule = rankingRule(rankingRuleId);
  const fingerprint = snapshotFingerprint(snapshot);
  const usedSeed = seed || `${versions.prediction}:${fingerprint}:${rule.id}:${requestedTotalRounds}:${nextResult}`;
  const random = seedrandom(usedSeed);
  const rawPlayers = [...snapshot.players].sort((a,b) => String(a.id).localeCompare(String(b.id), 'en'));
  const matchData = {...snapshot.matchData, rows:[...snapshot.matchData.rows].sort((a,b) =>
    a.bout-b.bout || String(a.p1_id).localeCompare(String(b.p1_id), 'en') || String(a.p2_id).localeCompare(String(b.p2_id), 'en'))};
  const liveState = reconcileLivePlayers(rawPlayers, matchData.rows);
  const players = liveState.players;
  const selected = players.find(p => String(p.id) === String(participantId));
  if (!selected) throw new Error('player not found in group');

  const currentRows = computeCurrentRanking(players, matchData.rows, Math.max(matchData.completedRounds || 0, 1), rule.id);
  const current = currentRows.find(p => p.id === String(participantId));
  const minimumTotalRounds = Math.max(matchData.completedRounds || 0, matchData.knownPairingRounds || 0, 1);
  const totalRounds = requestedTotalRounds
    ? Math.max(requestedTotalRounds, minimumTotalRounds)
    : Math.max(matchData.totalRounds || 0, minimumTotalRounds);
  const rowsByBout = groupMatchesByBout(matchData.rows);
  const pairingPlayers = selectActiveSimulationPlayers(players, matchData.rows, matchData.completedRounds);
  const nextOpponent = findNextKnownOpponent({
    participantId,
    matches: matchData.rows,
    players,
    currentRows,
    completedRounds: matchData.completedRounds,
    totalRounds,
  });
  const normalizedNextResult = ['win', 'loss'].includes(nextResult) ? nextResult : '';
  const appliedNextResult = nextOpponent && !nextOpponent.is_bye ? normalizedNextResult : '';
  const playerId = String(participantId);
  const counts = new Map();

  for (let i = 0; i < simulations; i++) {
    const scoreMap = new Map(players.map(p => [String(p.id), parseFloat(p.score) || 0]));
    const opponentSets = buildInitialOpponentSets(players, matchData.rows);
    const playedKeys = new Set(matchData.rows.filter(isPlayedMatch).map(matchKey));

    for (let bout = 1; bout <= totalRounds; bout++) {
      const rows = rowsByBout.get(bout) || [];
      const unplayedRows = rows.filter(row => !playedKeys.has(matchKey(row)) && !isPlayedMatch(row));
      if (unplayedRows.length) {
        for (const row of unplayedRows) {
          const isSelectedNextMatch = appliedNextResult
            && row.bout === nextOpponent.bout
            && (row.p1_id === playerId || row.p2_id === playerId);
          if (isSelectedNextMatch) {
            simulateKnownPairingWithPlayerResult(row, playerId, appliedNextResult, scoreMap, opponentSets);
          } else {
            simulateKnownPairing(row, scoreMap, opponentSets, random);
          }
        }
        continue;
      }
      if (rows.length || bout <= lastPlayed) continue;
      const pairings = buildSwissPairings(pairingPlayers, scoreMap, opponentSets);
      for (const pairing of pairings) simulateGeneratedPairing(pairing, scoreMap, opponentSets, random);
    }

    const ranked = rankPlayersFromScores(players, scoreMap, opponentSets, totalRounds, rule.id);
    const target = ranked.find(p => p.id === playerId);
    counts.set(target.rank, (counts.get(target.rank) || 0) + 1);
  }

  const probabilities = [...counts.entries()]
    .map(([rank, count]) => ({
      rank,
      count,
      probability: count / simulations,
    }))
    .sort((a, b) => b.probability - a.probability || a.rank - b.rank)
    .slice(0, includeDistribution ? Infinity : 5);

  return {
    group_id: String(groupId),
    total_rounds: totalRounds,
    detected_total_rounds: matchData.totalRounds,
    total_rounds_source: requestedTotalRounds ? 'manual' : matchData.totalRoundsSource,
    completed_rounds: matchData.completedRounds,
    known_pairing_rounds: matchData.knownPairingRounds,
    manual_pairing_rounds: matchData.manualPairingRounds,
    score_updates_applied: liveState.updatedCount > 0,
    score_updated_players: liveState.updatedCount,
    score_updated_through_round: liveState.updatedThroughRound,
    next_bout: matchData.completedRounds < totalRounds ? matchData.completedRounds + 1 : null,
    snapshot_at: snapshot.snapshotAt,
    next_opponent: nextOpponent,
    next_result: appliedNextResult,
    simulations,
    assumptions: { ranking:rule, total_rounds:requestedTotalRounds ? 'request-override' : matchData.totalRoundsSource || 'unknown',
      note:'未核实赛事完整排名细则；按胜2分、和1分、负0分、轮空对手分0、同分并列模拟。' },
    model: {
      version: versions.prediction,
      seed: usedSeed,
      snapshot_fingerprint: fingerprint,
      pairing: 'real-pairings-then-swiss-active-roster',
      pairing_players: pairingPlayers.length,
      win_probability: appliedNextResult ? `next-match-fixed-${appliedNextResult}` : 'equal-strength-50-50',
      ranking_rule: rule.id,
    },
    player: {
      id: String(selected.id),
      name: selected.name,
      org: selected.org,
    },
    current,
    probabilities,
  };
}

function simulateKnownPairingWithPlayerResult(row, participantId, result, scoreMap, opponentSets) {
  const playerId = String(participantId);
  const opponentId = row.p1_id === playerId ? row.p2_id : row.p1_id;
  addOpponents(row.p1_id, row.p2_id, opponentSets);
  addScore(result === 'win' ? playerId : opponentId, 2, scoreMap);
}

function findNextKnownOpponent({ participantId, matches, players, currentRows, completedRounds, totalRounds }) {
  const playerId = String(participantId);
  const nextMatch = matches
    .filter(row => (
      row.bout > completedRounds
      && row.bout <= totalRounds
      && !isPlayedMatch(row)
      && (row.p1_id === playerId || row.p2_id === playerId)
    ))
    .sort((a, b) => a.bout - b.bout || a.seat - b.seat)[0];
  if (!nextMatch) return null;

  const isPlayerOne = nextMatch.p1_id === playerId;
  const opponentId = isPlayerOne ? nextMatch.p2_id : nextMatch.p1_id;
  const fallbackName = isPlayerOne ? nextMatch.p2_name : nextMatch.p1_name;
  const fallbackOrg = isPlayerOne ? nextMatch.p2_org : nextMatch.p1_org;
  const isBye = String(opponentId) === LIVE_BYE_OPPONENT_ID;
  const opponent = players.find(player => String(player.id) === String(opponentId));
  const opponentCurrent = currentRows.find(player => String(player.id) === String(opponentId));

  return {
    bout: nextMatch.bout,
    seat: nextMatch.seat,
    id: String(opponentId),
    name: isBye ? '轮空' : (opponent?.name || fallbackName || ''),
    org: isBye ? '' : (opponent?.org || fallbackOrg || ''),
    is_bye: isBye,
    current_rank: isBye ? null : (opponentCurrent?.display_rank || opponentCurrent?.cloud_rank || opponentCurrent?.rank || null),
    score: isBye ? null : (opponentCurrent?.score ?? opponent?.score ?? null),
    opponent_score: isBye ? null : (opponentCurrent?.opponent_score ?? null),
    win: isBye ? 0 : (opponent?.win || 0),
    lose: isBye ? 0 : (opponent?.lose || 0),
    draw: isBye ? 0 : (opponent?.draw || 0),
  };
}

const LIVE_BYE_OPPONENT_ID = '__live_bye__';

function selectActiveSimulationPlayers(players, matches, completedRounds) {
  const round = parseInt(completedRounds) || 0;
  if (!round) return players;

  const playerIds = new Set(players.map(player => String(player.id)));
  const activeIds = new Set();
  for (const row of matches) {
    if (row.bout !== round) continue;
    if (playerIds.has(row.p1_id)) activeIds.add(row.p1_id);
    if (playerIds.has(row.p2_id)) activeIds.add(row.p2_id);
  }
  if (activeIds.size < 2) return players;
  return players.filter(player => activeIds.has(String(player.id)));
}

function groupMatchesByBout(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.bout)) map.set(row.bout, []);
    map.get(row.bout).push(row);
  }
  return map;
}

function buildInitialOpponentSets(players, rows) {
  const sets = new Map(players.map(p => [String(p.id), new Set()]));
  for (const row of rows) {
    if (!isPlayedMatch(row)) continue;
    const hasP1 = sets.has(row.p1_id);
    const hasP2 = sets.has(row.p2_id);
    if (hasP1 && !hasP2) {
      sets.get(row.p1_id).add(LIVE_BYE_OPPONENT_ID);
      continue;
    }
    if (!hasP1 && hasP2) {
      sets.get(row.p2_id).add(LIVE_BYE_OPPONENT_ID);
      continue;
    }
    if (!hasP1 || !hasP2) continue;
    sets.get(row.p1_id).add(row.p2_id);
    sets.get(row.p2_id).add(row.p1_id);
  }
  return sets;
}

function matchKey(row) {
  return `${row.bout}:${row.p1_id}:${row.p2_id}`;
}

function simulateKnownPairing(row, scoreMap, opponentSets, random) {
  const hasP1 = scoreMap.has(row.p1_id);
  const hasP2 = scoreMap.has(row.p2_id);
  if (hasP1 !== hasP2) {
    const byePlayer = hasP1 ? row.p1_id : row.p2_id;
    addScore(byePlayer, 2, scoreMap);
    opponentSets.get(byePlayer)?.add(LIVE_BYE_OPPONENT_ID);
    return;
  }

  addOpponents(row.p1_id, row.p2_id, opponentSets);
  if (random() < 0.5) {
    addScore(row.p1_id, 2, scoreMap);
  } else {
    addScore(row.p2_id, 2, scoreMap);
  }
}

function simulateGeneratedPairing(pairing, scoreMap, opponentSets, random) {
  if (pairing.bye) {
    addScore(pairing.bye, 2, scoreMap);
    opponentSets.get(String(pairing.bye))?.add(LIVE_BYE_OPPONENT_ID);
    return;
  }
  addOpponents(pairing.p1, pairing.p2, opponentSets);
  if (random() < 0.5) {
    addScore(pairing.p1, 2, scoreMap);
  } else {
    addScore(pairing.p2, 2, scoreMap);
  }
}

function addScore(id, score, scoreMap) {
  scoreMap.set(String(id), (scoreMap.get(String(id)) || 0) + score);
}

function addOpponents(a, b, opponentSets) {
  if (!opponentSets.has(String(a)) || !opponentSets.has(String(b))) return;
  opponentSets.get(String(a)).add(String(b));
  opponentSets.get(String(b)).add(String(a));
}

function buildSwissPairings(players, scoreMap, opponentSets) {
  const queue = players
    .map(player => {
      const id = String(player.id);
      const opponentScore = [...(opponentSets.get(id) || [])]
        .filter(opponentId => opponentId !== LIVE_BYE_OPPONENT_ID)
        .reduce((sum, opponentId) => sum + (scoreMap.get(String(opponentId)) || 0), 0);
      return {
        id,
        score: scoreMap.get(id) || 0,
        opponentScore,
        short: parseInt(player.short_no) || 9999,
      };
    })
    .sort((a, b) => b.score - a.score || b.opponentScore - a.opponentScore || a.short - b.short);
  const pairings = [];
  let byePlayer = null;

  if (queue.length % 2 === 1) {
    let byeIndex = -1;
    for (let index = queue.length - 1; index >= 0; index--) {
      if (!opponentSets.get(queue[index].id)?.has(LIVE_BYE_OPPONENT_ID)) {
        byeIndex = index;
        break;
      }
    }
    if (byeIndex < 0) byeIndex = queue.length - 1;
    byePlayer = queue.splice(byeIndex, 1)[0];
  }

  while (queue.length > 1) {
    const player = queue.shift();
    let bestIndex = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let index = 0; index < queue.length; index++) {
      const opponent = queue[index];
      if (opponentSets.get(player.id)?.has(opponent.id)) continue;
      const cost = Math.abs(player.score - opponent.score) * 100000
        + Math.abs(player.opponentScore - opponent.opponentScore) * 100
        + index;
      if (cost < bestCost) {
        bestCost = cost;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) bestIndex = 0;
    const opponent = queue.splice(bestIndex, 1)[0];
    pairings.push({ p1: player.id, p2: opponent.id });
  }

  if (byePlayer) pairings.push({ bye: byePlayer.id });
  return pairings;
}

function rankPlayersFromScores(players, scoreMap, opponentSets, roundsForFormula, ruleId = 'cloud-total-score') {
  rankingRule(ruleId);
  const maxScore = Math.max(1, ...players.map(p => scoreMap.get(String(p.id)) || 0));
  const rows = players.map(p => {
    const id = String(p.id);
    const score = scoreMap.get(id) || 0;
    const opponentScore = [...(opponentSets.get(id) || [])].reduce((sum, oppId) => sum + (scoreMap.get(String(oppId)) || 0), 0);
    const totalScore = score + (opponentScore * 2 / maxScore - roundsForFormula);
    return {
      id,
      name: p.name,
      org: p.org,
      short_no: p.short_no,
      score: roundNumber(score),
      opponent_score: roundNumber(opponentScore),
      total_score: roundNumber(totalScore, 5),
    };
  });

  rows.sort((a, b) =>
    (ruleId === 'score-opponent-score' ? b.score - a.score || b.opponent_score - a.opponent_score : b.total_score - a.total_score) ||
    b.score - a.score ||
    (parseInt(a.short_no) || 9999) - (parseInt(b.short_no) || 9999) ||
    a.name.localeCompare(b.name, 'zh-CN')
  );

  let last = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (last && nearlyEqual(row.score, last.score) && (ruleId === 'score-opponent-score'
      ? nearlyEqual(row.opponent_score,last.opponent_score) : nearlyEqual(row.total_score,last.total_score))) {
      row.rank = last.rank;
    } else {
      row.rank = i + 1;
    }
    last = row;
  }
  return rows;
}

function nearlyEqual(a, b) {
  return Math.abs((a || 0) - (b || 0)) < 0.00001;
}

function roundNumber(value, digits = 2) {
  const base = Math.pow(10, digits);
  return Math.round((parseFloat(value) || 0) * base) / base;
}


module.exports = { predictPlayerRank, validatePredictionSnapshot, reconcileLivePlayers, computeCurrentRanking, LIVE_BYE_OPPONENT_ID };
