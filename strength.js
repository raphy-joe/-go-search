'use strict';

const {
  queryParticipants,
  queryParticipantsForGroups,
} = require('./db');

const STRENGTH_WINDOW_DAYS = envPositiveInt('STRENGTH_WINDOW_DAYS', 180);
const MATCH_FETCH_CONCURRENCY = envPositiveInt('STRENGTH_MATCH_FETCH_CONCURRENCY', 4);
const RATING_ITERATIONS = envPositiveInt('STRENGTH_RATING_ITERATIONS', 8);
const MAX_TARGET_EVENTS = envPositiveInt('STRENGTH_MAX_TARGET_EVENTS', 80);
const PRIOR_WEIGHT = parseFloat(process.env.STRENGTH_PRIOR_WEIGHT || '5');
const AGE_PRIOR_WEIGHT = parseFloat(process.env.STRENGTH_AGE_PRIOR_WEIGHT || '3.5');
const AGE_GROUP_RATING_CAP = parseFloat(process.env.STRENGTH_AGE_GROUP_RATING_CAP || '31.05');
const OUTCOME_SPAN = parseFloat(process.env.STRENGTH_OUTCOME_SPAN || '1.15');

function envPositiveInt(name, fallback) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d, days) {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function parseGroupL(groupName) {
  if (!groupName) return null;
  const g = groupName.trim();
  if (/启蒙|吃子|入门|幼儿|棋趣/.test(g)) return null;
  if (/定段/.test(g)) return 25.3;

  const rangeM = g.match(/(\d+)\s*[~\-－—至到]\s*(\d+)\s*级/);
  if (rangeM) {
    const a = 26 - parseInt(rangeM[1], 10);
    const b = 26 - parseInt(rangeM[2], 10);
    return (a + b) / 2;
  }

  const lvM = g.match(/(\d+)\s*级/);
  if (lvM) {
    const lv = parseInt(lvM[1], 10);
    if (lv >= 1 && lv <= 25) return 26 - lv;
  }

  const danM = g.match(/(\d+)\s*段/);
  if (danM) {
    const d = parseInt(danM[1], 10);
    if (d >= 1 && d <= 8) return 25 + d;
  }

  if (/低段/.test(g)) return 27.5;
  if (/高段/.test(g)) return 30;
  if (isOpenGroup(g)) return 30.15;
  return null;
}

function isOpenGroup(groupName) {
  return /公开/.test(groupName || '');
}

function parseAgeGradeL(groupName, eventTitle, organizer) {
  if (!groupName) return null;
  const g = groupName.trim();
  const isAge = /[一二三四五六]年级|低年级|高年级|小学.*组|儿童.*组|少儿.*组|初中|中学生?组|U\d+|\d+\s*岁|[甲乙丙丁ABCDＡＢＣＤ]组/.test(g);
  if (!isAge) return null;
  if (/启蒙|吃子|入门/.test(g)) return null;

  const text = `${eventTitle || ''} ${organizer || ''}`;
  let tierBase;
  if (/全国|国际/.test(text)) tierBase = 29.85;
  else if (/省/.test(text)) tierBase = 29.35;
  else if (/市/.test(text)) tierBase = 28.85;
  else if (/区|县/.test(text)) tierBase = 27.5;
  else if (/学校|班级|校内/.test(text)) tierBase = 24.0;
  else tierBase = 27.5;

  let adj = 0;
  const gradeMap = { '一': 0, '二': 0.25, '三': 0.5, '四': 0.75, '五': 1.0, '六': 1.25 };
  for (const [ch, a] of Object.entries(gradeMap)) {
    if (g.includes(`${ch}年级`)) { adj = a; break; }
  }
  if (/低年级/.test(g)) adj = 0.2;
  if (/高年级/.test(g)) adj = 0.9;
  if (/初中|中学生/.test(g)) adj = 1.35;
  if (/甲组/.test(g) && adj === 0) adj = 0.9;
  if (/乙组/.test(g) && adj === 0) adj = 0.55;
  if (/丙组/.test(g) && adj === 0) adj = 0.2;
  if (/丁组/.test(g) && adj === 0) adj = 0;
  if (/[AＡ]组/.test(g) && adj === 0) adj = 0.85;
  if (/[BＢ]组/.test(g) && adj === 0) adj = 0.45;
  if (/[CＣ]组/.test(g) && adj === 0) adj = 0.15;
  if (/[DＤ]组/.test(g) && adj === 0) adj = 0;

  const uM = g.match(/U(\d+)/i);
  const aM = g.match(/(\d+)\s*岁/);
  const age = uM ? parseInt(uM[1], 10) : aM ? parseInt(aM[1], 10) : null;
  if (age !== null) {
    adj = age <= 7 ? 0 : age <= 9 ? 0.25 : age <= 11 ? 0.6 : age <= 13 ? 1.0 : 1.35;
  }

  return tierBase + adj;
}

function winRateAdj(win, lose, draw) {
  const total = win + lose + draw;
  if (total === 0) return 0;
  return 1.5 * ((win + 0.5 * draw) / total - 0.5);
}

function timeWeight(dateStr, dateTo) {
  if (!dateStr) return 0;
  const end = dateTo ? new Date(dateTo).getTime() : Date.now();
  const days = (end - new Date(dateStr).getTime()) / 86400000;
  if (days < 0 || days > STRENGTH_WINDOW_DAYS) return 0;
  if (days <= 60) return 1.0;
  if (days <= 120) return 0.7;
  return 0.45;
}

function eventLevelWeight(title, organizer) {
  const text = `${title || ''} ${organizer || ''}`;
  if (/全国|国际|中国围棋协会/.test(text)) return 1.45;
  if (/省级|省赛|省锦标|全省|省围棋|省青少年/.test(text)) return 1.30;
  if (/市级|市锦标|全市|市围棋/.test(text)) return 1.15;
  return 1.0;
}

function lToLabel(L) {
  L = clamp(L, 0.5, 33.99);
  const base = Math.floor(L);
  const frac = L - base;
  const tier = frac < 0.34 ? '弱' : frac < 0.67 ? '普通' : '强';
  if (base >= 1 && base <= 25) return `${tier}${26 - base}级`;
  if (base >= 26 && base <= 33) return `${tier}${base - 25}段`;
  return null;
}

function rowKey(row) {
  return `${row.group_id}:${row.participant_id}`;
}

function recordRounds(row) {
  return (parseInt(row.win, 10) || 0) + (parseInt(row.lose, 10) || 0) + (parseInt(row.draw, 10) || 0);
}

function recordScore(record) {
  const total = (record.win || 0) + (record.lose || 0) + (record.draw || 0);
  return total ? ((record.win || 0) + 0.5 * (record.draw || 0)) / total : 0;
}

function rowBase(row) {
  const skillL = parseGroupL(row.group_name);
  const ageL = skillL === null ? parseAgeGradeL(row.group_name, row.title, row.cname) : null;
  const LGroup = skillL ?? ageL;
  if (LGroup === null) return null;

  const win = parseInt(row.win, 10) || 0;
  const lose = parseInt(row.lose, 10) || 0;
  const draw = parseInt(row.draw, 10) || 0;
  const total = win + lose + draw;
  if (total === 0) return null;

  const isAgeGroup = skillL === null;
  const isOpen = !isAgeGroup && isOpenGroup(row.group_name);
  let wrAdj = winRateAdj(win, lose, draw);
  if (isOpen && wrAdj > 0) wrAdj *= 0.75;
  if (isOpen && wrAdj < 0) wrAdj *= 0.6;

  const base = LGroup + (isAgeGroup ? 0 : 0.35) + wrAdj;
  return {
    base: isOpen ? Math.max(base, 29.2) : base,
    groupL: LGroup,
    wrAdj,
    isAgeGroup,
    isOpen,
  };
}

function selectLikelySamePlayerRows(rows, province) {
  if (province || rows.length <= 1) {
    return { rows, removed: [] };
  }

  const enriched = rows
    .map(row => ({ row, baseInfo: rowBase(row) }))
    .filter(item => item.baseInfo);
  if (enriched.length <= 1) {
    return { rows, removed: [] };
  }

  const highRows = enriched.filter(item => item.baseInfo.base >= 29.7);
  const lowRows = enriched.filter(item => item.baseInfo.base <= 27.8);
  const provinces = new Set(rows.map(r => r.provincename || '').filter(Boolean));
  if (highRows.length < 2 || lowRows.length === 0 || provinces.size < 2) {
    return { rows, removed: [] };
  }

  const highProvinces = new Set(highRows.map(item => item.row.provincename || '').filter(Boolean));
  const filtered = rows.filter(row => {
    const info = rowBase(row);
    if (!info) return true;
    if (info.base > 27.8) return true;
    return highProvinces.has(row.provincename || '');
  });
  const keptKeys = new Set(filtered.map(row => `${row.event_id}:${row.group_id}:${row.participant_id}`));
  const removed = rows.filter(row => !keptKeys.has(`${row.event_id}:${row.group_id}:${row.participant_id}`));
  return { rows: filtered, removed };
}

function normalizeMatchRows(rows) {
  return (rows || []).map(r => ({
    group_id: String(r.group_id || ''),
    bout: parseInt(r.bout, 10) || 0,
    p1_id: String(r.p1_id || ''),
    p2_id: String(r.p2_id || ''),
    p1_result: String(r.p1_result ?? ''),
    p2_result: String(r.p2_result ?? ''),
  })).filter(r => r.group_id && r.p1_id && r.p2_id);
}

function resultFor(raw) {
  if (raw === '1') return 1;
  if (raw === '2') return 0;
  return 0.5;
}

async function fetchGroupMatchesForStrength(groupInfos, getOrFetchGroupMatches) {
  const matchMap = new Map();
  const queue = [...groupInfos];

  async function worker() {
    while (queue.length) {
      const group = queue.shift();
      try {
        const rows = await getOrFetchGroupMatches(group.groupId, group.rounds);
        matchMap.set(group.groupId, normalizeMatchRows(rows));
      } catch (_) {
        matchMap.set(group.groupId, []);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(MATCH_FETCH_CONCURRENCY, queue.length || 1) }, worker));
  return matchMap;
}

function buildRatingGraph({ groupRows, matchMap, dateTo }) {
  const players = new Map();
  const groups = new Map();

  for (const row of groupRows) {
    const baseInfo = rowBase(row);
    if (!baseInfo) continue;
    const key = rowKey(row);
    const tw = timeWeight((row.min_time || '').substring(0, 10), dateTo);
    const ew = eventLevelWeight(row.title, row.cname);
    if (tw === 0) continue;
    players.set(key, {
      key,
      row,
      ...baseInfo,
      priorWeight: baseInfo.isAgeGroup ? AGE_PRIOR_WEIGHT : PRIOR_WEIGHT,
      eventWeight: tw * ew,
      rating: baseInfo.base,
    });
    if (!groups.has(row.group_id)) groups.set(String(row.group_id), new Set());
    groups.get(row.group_id).add(key);
  }

  const games = [];
  for (const [groupId, rows] of matchMap.entries()) {
    for (const m of rows) {
      const k1 = `${groupId}:${m.p1_id}`;
      const k2 = `${groupId}:${m.p2_id}`;
      if (!players.has(k1) || !players.has(k2)) continue;
      const p1 = players.get(k1);
      const p2 = players.get(k2);
      const weight = Math.min(p1.eventWeight, p2.eventWeight);
      if (weight <= 0) continue;
      games.push({
        groupId,
        p1: k1,
        p2: k2,
        p1Score: resultFor(m.p1_result),
        p2Score: resultFor(m.p2_result),
        weight,
      });
    }
  }

  for (let i = 0; i < RATING_ITERATIONS; i++) {
    const next = new Map();
    for (const [key, p] of players.entries()) {
      next.set(key, {
        sum: p.base * p.priorWeight,
        weight: p.priorWeight,
      });
    }

    for (const g of games) {
      const p1 = players.get(g.p1);
      const p2 = players.get(g.p2);
      const perf1 = p2.rating + OUTCOME_SPAN * (g.p1Score - 0.5) * 2;
      const perf2 = p1.rating + OUTCOME_SPAN * (g.p2Score - 0.5) * 2;
      const n1 = next.get(g.p1);
      const n2 = next.get(g.p2);
      n1.sum += perf1 * g.weight;
      n1.weight += g.weight;
      n2.sum += perf2 * g.weight;
      n2.weight += g.weight;
    }

    for (const [key, p] of players.entries()) {
      const n = next.get(key);
      p.rating = clamp(n.sum / n.weight, 1, p.isAgeGroup ? AGE_GROUP_RATING_CAP : 33.5);
    }
  }

  return { players, games };
}

function aggregateTarget({ name, targetRows, graph, matchMap, dateFrom, dateTo, province }) {
  const used = [];
  let totalWeight = 0;
  let weightedSum = 0;
  let totalRounds = 0;
  let matchGames = 0;
  const opponentNames = new Set();
  const orgs = new Set();
  const provinces = new Set();
  const groups = new Set();

  for (const row of targetRows) {
    const key = rowKey(row);
    const p = graph.players.get(key);
    const baseInfo = rowBase(row);
    if (!baseInfo) continue;
    orgs.add(row.org || '');
    provinces.add(row.provincename || '');
    groups.add(row.group_name || '');

    const date = (row.min_time || '').substring(0, 10);
    const tw = timeWeight(date, dateTo);
    if (tw === 0) continue;
    const ew = eventLevelWeight(row.title, row.cname);
    const rounds = recordRounds(row);
    const groupMatches = matchMap.get(String(row.group_id)) || [];
    const ownMatches = groupMatches.filter(m => m.p1_id === String(row.participant_id) || m.p2_id === String(row.participant_id));
    const dataQuality = ownMatches.length ? 1.15 : 0.75;
    const weight = Math.max(1, rounds) * tw * ew * dataQuality;
    const rating = baseInfo.isAgeGroup
      ? Math.min(p ? p.rating : baseInfo.base, AGE_GROUP_RATING_CAP)
      : (p ? p.rating : baseInfo.base);

    for (const m of ownMatches) {
      const oppId = m.p1_id === String(row.participant_id) ? m.p2_id : m.p1_id;
      const opp = graph.players.get(`${row.group_id}:${oppId}`);
      if (opp?.row?.participant_name) opponentNames.add(opp.row.participant_name);
    }

    matchGames += ownMatches.length;
    totalRounds += rounds;
    used.push({
      event_id: String(row.event_id),
      title: row.title,
      date,
      province: row.provincename,
      city: row.city_name,
      organizer: row.cname,
      group: row.group_name,
      org: row.org,
      record: {
        win: parseInt(row.win, 10) || 0,
        lose: parseInt(row.lose, 10) || 0,
        draw: parseInt(row.draw, 10) || 0,
      },
      base: baseInfo.base,
      rating,
      matchGames: ownMatches.length,
      weight,
      isAgeGroup: baseInfo.isAgeGroup,
      isOpen: baseInfo.isOpen,
    });
  }

  if (used.length === 0) {
    return {
      available: false,
      reason: '近180天内缺少可用棋力样本',
      name,
      scope: { province: province || '__ALL__', dateFrom, dateTo },
      groups: [...groups].filter(Boolean),
    };
  }

  const skillAnchorEvents = used.filter(e => !e.isAgeGroup);
  let skillAnchor = null;
  if (skillAnchorEvents.length > 0) {
    const skillWeight = skillAnchorEvents.reduce((sum, e) => sum + e.weight, 0);
    if (skillWeight > 0) {
      skillAnchor = skillAnchorEvents.reduce((sum, e) => sum + e.rating * e.weight, 0) / skillWeight;
    }
  }

  if (skillAnchor !== null) {
    for (const e of used) {
      if (!e.isAgeGroup || recordScore(e.record) < 0.5) continue;
      e.rating = Math.max(e.rating, Math.min(AGE_GROUP_RATING_CAP, skillAnchor - 0.05));
    }
  }

  for (const e of used) {
    totalWeight += e.weight;
    weightedSum += e.rating * e.weight;
  }

  let L = weightedSum / totalWeight;
  const hasFiveDanEvidence = used.some(e => e.isOpen || e.rating >= 30.1 || /5\s*段/.test(e.org || ''));
  if (L >= 29.85 && L < 30 && hasFiveDanEvidence && totalRounds >= 12) {
    L = 30.02;
  }
  const eventCount = used.length;
  const confidence = matchGames >= 14 && eventCount >= 2 ? '高'
    : matchGames >= 5 || totalRounds >= 8 ? '中'
    : '低';
  const uncertainty = confidence === '高' ? 0.45 : confidence === '中' ? 0.75 : 1.15;
  const warnings = [];
  const cleanOrgs = [...orgs].filter(Boolean);
  const cleanProvinces = [...provinces].filter(Boolean);
  if (!matchGames) warnings.push('未取得对局明细，主要依据组别与胜负估算');
  if (cleanOrgs.length >= 4 && !province) warnings.push('同名棋手可能来自多个机构，建议结合省份或机构判断');

  used.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.weight - a.weight);

  return {
    available: true,
    model: 'opponent-graph-v1',
    name,
    scope: { province: province || '__ALL__', dateFrom, dateTo, windowDays: STRENGTH_WINDOW_DAYS },
    L,
    label: lToLabel(L),
    confidence,
    range: {
      low: clamp(L - uncertainty, 0.5, 33.99),
      high: clamp(L + uncertainty, 0.5, 33.99),
      lowLabel: lToLabel(L - uncertainty),
      highLabel: lToLabel(L + uncertainty),
    },
    stats: {
      events: eventCount,
      rounds: totalRounds,
      matchGames,
      opponents: opponentNames.size,
      groups: groups.size,
      orgs: cleanOrgs,
      provinces: cleanProvinces,
      graphPlayers: graph.players.size,
      graphGames: graph.games.length,
    },
    events: used,
    warnings,
  };
}

async function estimatePlayerStrength({ name, province = '', dateTo, getOrFetchGroupMatches }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('missing player name');
  const cleanProvince = province === '__ALL__' ? '' : String(province || '');
  const end = dateTo ? new Date(dateTo) : new Date();
  const safeDateTo = Number.isNaN(end.getTime()) ? formatDate(new Date()) : formatDate(end);
  const dateFrom = formatDate(addDays(new Date(`${safeDateTo}T00:00:00`), -STRENGTH_WINDOW_DAYS));

  const allTargetRows = await queryParticipants({
    name: cleanName,
    province: cleanProvince,
    dateFrom,
    dateTo: `${safeDateTo} 23:59:59`,
  });
  const selected = selectLikelySamePlayerRows(allTargetRows, cleanProvince);
  const targetRows = selected.rows.slice(0, MAX_TARGET_EVENTS);
  if (!targetRows.length) {
    return {
      available: false,
      reason: '近180天内没有找到该棋手的索引记录',
      name: cleanName,
      scope: { province: cleanProvince || '__ALL__', dateFrom, dateTo: safeDateTo, windowDays: STRENGTH_WINDOW_DAYS },
      groups: [],
    };
  }

  const groupIds = [...new Set(targetRows.map(r => String(r.group_id)).filter(Boolean))];
  const groupRows = await queryParticipantsForGroups(groupIds);
  const maxRoundsByGroup = new Map();
  for (const row of groupRows) {
    const gid = String(row.group_id);
    maxRoundsByGroup.set(gid, Math.max(maxRoundsByGroup.get(gid) || 0, recordRounds(row)));
  }
  const groupInfos = groupIds
    .map(groupId => ({ groupId, rounds: maxRoundsByGroup.get(groupId) || 0 }))
    .filter(g => g.rounds > 0);
  const matchMap = getOrFetchGroupMatches
    ? await fetchGroupMatchesForStrength(groupInfos, getOrFetchGroupMatches)
    : new Map();

  const graph = buildRatingGraph({ groupRows, matchMap, dateTo: safeDateTo });
  const result = aggregateTarget({
    name: cleanName,
    targetRows,
    graph,
    matchMap,
    dateFrom,
    dateTo: safeDateTo,
    province: cleanProvince,
  });
  if (selected.rows.length > targetRows.length) {
    result.warnings = result.warnings || [];
    result.warnings.push(`同名记录较多，已优先采用最近 ${targetRows.length} 场比赛估算`);
  }
  if (selected.removed.length > 0) {
    result.warnings = result.warnings || [];
    result.warnings.push(`已排除 ${selected.removed.length} 场疑似同名但级别/地区不一致的记录`);
  }
  return result;
}

module.exports = {
  estimatePlayerStrength,
  parseGroupL,
  lToLabel,
};
