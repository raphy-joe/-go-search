'use strict';

const fetch = require('node-fetch');
const {
  queryPromotionCandidates,
  queryEventGroups,
  getEventNoticeCache,
  replaceEventNoticeCache,
} = require('./db');

const EVENT_NOTICE_API = 'https://data-center.yunbisai.com/api/lswl-events';
const EVENTPART_API = 'https://api.yunbisai.com/request/Group/Eventpart';
const NOTICE_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12000;
const delay = ms => new Promise(r => setTimeout(r, ms));
const CONFIRMED_PUBLIC_ASSOCIATION_RULE_EVENTS = new Set([
  '54734',
]);

const PROVINCIAL_ASSOCIATION_RULES = {
  '\u56db\u5ddd\u7701': {
    source: 'http://www.scwqxh.com/go-a327.htm',
    rounding: 'ceil',
    minRounds: 7,
    danRules: {
      4: { percent: 15, targetLabel: '5\u6bb5' },
      3: { percent: 20, targetLabel: '4\u6bb5' },
      2: { percent: 25, targetLabel: '3\u6bb5', fullWinTargetLabel: '4\u6bb5' },
      1: { percent: 30, targetLabel: '2\u6bb5', fullWinTargetLabel: '3\u6bb5' },
    },
    levelRules: {
      1: { percent: 35, targetLabel: '1\u6bb5', fullWinTargetLabel: '2\u6bb5' },
      2: { percent: 50, targetLabel: '1\u7ea7', fullWinTargetLabel: '1\u6bb5' },
      5: { percent: 50, targetLabel: '2\u7ea7', fullWinTargetLabel: '1\u7ea7' },
    },
  },
  '\u6cb3\u5317\u7701': {
    source: 'https://sport.hebei.gov.cn/m/view.php?aid=8392',
    rounding: 'round',
    minRounds: 7,
    danRules: {
      4: { percent: 15, targetLabel: '5\u6bb5' },
      3: { percent: 30, targetLabel: '4\u6bb5' },
      2: { percent: 50, targetLabel: '3\u6bb5' },
      1: { percent: 65, targetLabel: '2\u6bb5' },
    },
    levelRules: {
      1: { percent: 75, targetLabel: '1\u6bb5' },
      2: { percent: 75, targetLabel: '1\u7ea7' },
      3: { percent: 80, targetLabel: '2\u7ea7' },
      4: { percent: 80, targetLabel: '3\u7ea7' },
      5: { percent: 85, targetLabel: '4\u7ea7' },
      6: { percent: 85, targetLabel: '5\u7ea7' },
      7: { percent: 90, targetLabel: '6\u7ea7' },
    },
  },
};

const EXTERNAL_PROMOTION_EVIDENCE = [
  {
    name: '\u94b1\u60a6\u52c9',
    event_id: 'external-scwqxh-2025-05-neijiang-3d4d-qym',
    title: '2025\u5e74\u56db\u5ddd\u77015\u6708\u56f4\u68cb\u6bb5\u4f4d\u8d5b\uff083\u6bb5-4\u6bb5\u7ec4\uff09',
    date: '2025-05-04',
    province: '\u56db\u5ddd\u7701',
    city: '\u5185\u6c5f\u5e02',
    organizer: '\u5185\u6c5f\u5e02\u9686\u660c\u5e02\u56f4\u68cb\u534f\u4f1a',
    group: '3\u6bb5-4\u6bb5\u7ec4',
    promotedTo: '5\u6bb5',
    source: 'association-promotion-list',
    detail_url: 'http://www.scwqxh.com/',
  },
];

async function estimatePromotionHistory({ name, province = '', dateFrom = '0000-01-01', dateTo = '9999-12-31' }) {
  const rows = await queryPromotionCandidates({ name, province, dateFrom, dateTo });
  const candidates = rows
    .map(row => ({ row, level: parseCandidateLevel(row.group_name) }))
    .filter(item => item.level);
  const chronological = [...candidates].sort((a, b) => {
    return (a.row.min_time || '').localeCompare(b.row.min_time || '')
      || String(a.row.event_id).localeCompare(String(b.row.event_id));
  });
  const results = [];
  const notices = new Map();
  const groupRows = new Map();
  const eventGroups = new Map();

  for (const item of candidates) {
    const { row, level } = item;
    const stats = await enrichRankAndGroupSize(row, groupRows);
    const notice = await getNoticeForEvent(row.event_id, notices);
    const groups = await getGroupsForEvent(row.event_id, eventGroups);
    const context = {
      province: row.provincename,
      eventGroups: groups,
    };
    const rule = extractPromotionRule(notice.text, row.group_name, level, context)
      || confirmedEventRule(row)
      || genericAssociationRule(row, level);
    let decision = decidePromotion({ row, stats, rule, level });
    if (!decision?.promoted) {
      decision = await inferPromotionFromLaterGroups({ item, stats, rule, chronological, eventGroups });
    }
    if (!decision.promoted) continue;

    results.push({
      event_id: String(row.event_id),
      title: row.title,
      date: (row.min_time || '').substring(0, 10),
      province: row.provincename,
      city: row.city_name,
      organizer: row.cname,
      group: row.group_name,
      rank: stats.rank,
      groupSize: stats.groupSize,
      record: {
        win: parseInt(row.win, 10) || 0,
        lose: parseInt(row.lose, 10) || 0,
        draw: parseInt(row.draw, 10) || 0,
      },
      score: row.score,
      promotedTo: decision.promotedTo,
      confidence: decision.confidence,
      basis: decision.basis,
      ruleText: decision.ruleText,
      source: decision.source,
      detail_url: `https://www.yunbisai.com/tpl/eventFeatures/eventDetail-${row.event_id}.html#groupID=${row.group_id}`,
    });
  }

  results.push(...getExternalPromotionRecords({ name, province, dateFrom, dateTo }));
  const uniqueResults = normalizePromotionSequence(dedupePromotionResults(results));
  uniqueResults.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  return {
    name,
    scope: { province: province || '__ALL__', dateFrom, dateTo },
    count: uniqueResults.length,
    items: uniqueResults,
    scanned: rows.length,
  };
}

function getExternalPromotionRecords({ name, province, dateFrom, dateTo }) {
  const start = normalizeDateOnly(dateFrom) || '0000-01-01';
  const end = normalizeDateOnly(dateTo) || '9999-12-31';
  return EXTERNAL_PROMOTION_EVIDENCE
    .filter(item => item.name === name)
    .filter(item => !province || item.province === province)
    .filter(item => item.date >= start && item.date <= end)
    .map(item => ({
      event_id: item.event_id,
      title: item.title,
      date: item.date,
      province: item.province,
      city: item.city,
      organizer: item.organizer,
      group: item.group,
      rank: 0,
      groupSize: 0,
      record: null,
      score: '',
      promotedTo: item.promotedTo,
      confidence: '\u9ad8',
      basis: '',
      ruleText: '',
      source: item.source,
      detail_url: item.detail_url,
    }));
}

function normalizeDateOnly(value) {
  const m = String(value || '').match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : '';
}

function dedupePromotionResults(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = [
      item.date || '',
      item.title || '',
      item.group || '',
      item.promotedTo || '',
    ].join('\u0001');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function normalizePromotionSequence(items) {
  const chronological = [...items].sort((a, b) => {
    return (a.date || '').localeCompare(b.date || '')
      || String(a.event_id || '').localeCompare(String(b.event_id || ''));
  });
  const out = [];
  const seenDanTargets = new Set();
  let highestDan = 0;

  for (const item of chronological) {
    const targetDan = parseDanLabel(item.promotedTo);
    if (targetDan) {
      if (seenDanTargets.has(targetDan) || targetDan <= highestDan) continue;
      seenDanTargets.add(targetDan);
      highestDan = targetDan;
    }
    out.push(item);
  }

  return out;
}

function parseDanLabel(label) {
  const m = String(label || '').match(/^(\d+)\s*段$/);
  return m ? parseInt(m[1], 10) || 0 : 0;
}

function parseCandidateLevel(groupName) {
  const g = String(groupName || '').replace(/\s+/g, '').trim();
  if (!g || !/组/.test(g)) return null;
  const fixedDan = g.match(/^定(\d+)段.*组/);
  if (fixedDan) {
    const target = parseInt(fixedDan[1], 10) || 0;
    if (target === 1) return { kind: 'level', current: 1 };
    if (target >= 2 && target <= 6) return { kind: 'dan', current: target - 1 };
  }
  const upgradeToDan = g.match(/^(\d+)级升\d+段.*组/);
  if (upgradeToDan) return { kind: 'level', current: parseInt(upgradeToDan[1], 10) };
  if (isMixedLevelGroup(g)) return null;

  const mentions = parseGroupLevelMentions(g);
  if (mentions.length === 1) {
    const [{ kind, current }] = mentions;
    if (kind === 'dan' && current >= 1 && current <= 5) return { kind, current };
    if (kind === 'level') return { kind, current };
  }

  const dan = g.match(/^(\d+)段.*组/);
  if (dan) {
    const current = parseInt(dan[1], 10);
    if (current >= 1 && current <= 5) return { kind: 'dan', current };
  }
  const level = g.match(/^(\d+)级.*组/);
  if (level) return { kind: 'level', current: parseInt(level[1], 10) };
  if (/一级组|定段组/.test(g)) return { kind: 'level', current: 1 };
  return null;
}

function isMixedLevelGroup(groupName) {
  const g = String(groupName || '');
  if (/^\d+级升\d+段.*组/.test(g)) return false;
  if (/\d+\s*[段级]?\s*[-—－~～至到]\s*\d+\s*[段级]/.test(g)) return true;
  if (/\d+\s*[段级]\s*[-—－~～至到]\s*\d+\s*[段级]?/.test(g)) return true;
  return parseGroupLevelMentions(g).length > 1;
}

function parseGroupLevelMentions(groupName) {
  const g = String(groupName || '');
  return [...g.matchAll(/(\d+)\s*(段|级)/g)]
    .map(match => ({
      kind: match[2] === '段' ? 'dan' : 'level',
      current: parseInt(match[1], 10) || 0,
    }))
    .filter(item => item.current > 0);
}

async function getGroupsForEvent(eventId, cache) {
  const key = String(eventId);
  if (!cache.has(key)) cache.set(key, queryEventGroups(key).catch(() => []));
  return cache.get(key);
}

async function enrichRankAndGroupSize(row, groupRows) {
  let rank = parseInt(row.rank, 10) || 0;
  let groupSize = parseInt(row.group_size, 10) || parseInt(row.indexed_group_size, 10) || 0;
  if (rank && groupSize) return { rank, groupSize };

  const groupId = String(row.group_id || '');
  if (!groupId) return { rank, groupSize };
  if (!groupRows.has(groupId)) groupRows.set(groupId, fetchGroupParticipants(groupId).catch(() => []));

  const rows = await groupRows.get(groupId);
  if (!groupSize && rows.length) groupSize = rows.length;
  const match = rows.find(r => {
    const id = String(r.participantid || r.id || r.pid || '');
    return id && id === String(row.participant_id);
  });
  if (!rank && match) rank = parseInt(match.compositor, 10) || 0;
  return { rank, groupSize };
}

async function getNoticeForEvent(eventId, cache) {
  const key = String(eventId);
  if (cache.has(key)) return cache.get(key);
  const value = await getOrFetchEventNotice(key);
  cache.set(key, value);
  return value;
}

async function getOrFetchEventNotice(eventId) {
  const cached = await getEventNoticeCache(eventId);
  const fresh = cached && cached.updated_at && Date.now() - cached.updated_at < NOTICE_CACHE_TTL_MS;
  if (fresh && !cached.last_error) {
    const cachedText = normalizeNoticeText(cached.notice_text || '');
    return { text: cachedText, hasNotice: Boolean(cachedText) };
  }

  try {
    const url = `${EVENT_NOTICE_API}/${encodeURIComponent(eventId)}/event-notice`;
    const text = await fetchText(url, {
      headers: {
        Referer: `https://www.yunbisai.com/tpl/eventFeatures/eventDetail-${eventId}.html`,
        'User-Agent': 'Mozilla/5.0',
      },
      timeout: REQUEST_TIMEOUT_MS,
    });
    const data = JSON.parse(text);
    const noticeText = parseNoticePayload(data?.data?.eventNotice);
    await replaceEventNoticeCache({ event_id: eventId, notice_text: noticeText, last_error: '' });
    return { text: noticeText, hasNotice: Boolean(noticeText) };
  } catch (err) {
    await replaceEventNoticeCache({ event_id: eventId, notice_text: cached?.notice_text || '', last_error: err.message });
    const cachedText = normalizeNoticeText(cached?.notice_text || '');
    return { text: cachedText, hasNotice: Boolean(cachedText) };
  }
}

function parseNoticePayload(payload) {
  if (!payload) return '';
  let raw = String(payload);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map(item => {
        const html = decodeUriComponentSafe(item.h || '');
        return `${item.t || ''}: ${stripHtml(html)}`;
      }).join('\n').trim();
    }
  } catch (_) {}
  return stripHtml(decodeUriComponentSafe(raw));
}

function normalizeNoticeText(text) {
  return stripHtml(decodeUriComponentSafe(text || ''));
}

function decodeUriComponentSafe(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch (_) {
    return String(value || '');
  }
}

function stripHtml(html) {
  return decodeHtml(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractPromotionRule(text, groupName, level, context = {}) {
  if (!text) return null;
  const g = String(groupName || '').replace(/\s+/g, '');
  const normalized = text.replace(/\s+/g, '');
  const fragments = normalized
    .split(/[。；;\n]/)
    .map(x => x.trim())
    .filter(x => x && /升段|升级|晋升|升为|升至|升\d+[段级]|申请\d+级|段位|级位/.test(x));
  const promotionFragments = fragments.filter(x => /升段|升级|晋升|升为|升至|升\d+[段级]|申请\d+级/.test(x));
  const searchFragments = promotionFragments.length ? promotionFragments : fragments;

  const matches = searchFragments
    .filter(f => fragmentMentionsGroup(f, g, level))
    .map(f => narrowFragmentToGroup(f, g, level));
  if (!matches.length) return null;

  for (const fragment of matches) {
    const parsed = parseRuleFragment(fragment, level, context);
    if (parsed.targetLabel || parsed.fullWinTargetLabel || /晋升|升|申请/.test(fragment)) return parsed;
  }
  return parseRuleFragment(matches[0], level, context);
}

function confirmedEventRule(row) {
  const eventId = String(row.event_id || '');
  const groupName = String(row.group_name || '').replace(/\s+/g, '');
  if (eventId === '63516' && groupName === '5级组') {
    return {
      text: '2026年“阿尔法蛋杯”乐山市首届少儿围棋公开赛暨2026年四川省青少年围棋争霸赛乐山分站赛：5级组全胜升1级',
      percent: null,
      topN: null,
      wins: null,
      targetLabel: null,
      fullWinTargetLabel: '1级',
      source: 'user-confirmed-rule',
    };
  }
  return null;
}

function genericAssociationRule(row, level) {
  const isRankEvent = isProvincialAssociationRankEvent(row);
  if (!isRankEvent && !canUseAssociationRuleForBackedPublicEvent(row, level)) return null;
  const config = PROVINCIAL_ASSOCIATION_RULES[String(row.provincename || '')];
  if (!config) return null;
  const rule = level.kind === 'dan'
    ? config.danRules?.[level.current]
    : config.levelRules?.[level.current];
  if (!rule) return null;
  return {
    text: `${row.provincename}围棋段级位赛通用晋升标准（来源：${config.source}）`,
    percent: rule.percent,
    topN: null,
    wins: null,
    targetLabel: rule.targetLabel,
    fullWinTargetLabel: rule.fullWinTargetLabel || null,
    rounding: rule.rounding || config.rounding || 'ceil',
    minRounds: rule.minRounds || config.minRounds || 0,
    source: 'association-general-rule',
  };
}

function isProvincialAssociationRankEvent(row) {
  if (!PROVINCIAL_ASSOCIATION_RULES[String(row.provincename || '')]) return false;
  const text = [
    row.title || '',
    row.cname || '',
    row.city_name || '',
  ].join(' ');
  if (!/围棋/.test(text) || !/段级位赛|段位赛/.test(text)) return false;
  if (/公开赛|网赛|公益|争霸赛|邀请赛|联赛/.test(text)) return false;
  return /省|围棋协会|棋院|段位赛|段级位赛|级位赛/.test(text);
}

function parseRuleFragment(matched, level, context) {
  const fullWinExplicit = targetLabelFromMatch(matched.match(/(?:全胜|\d+连胜)[^。；;]*(?:跳升|晋升|升)(?:为|至)?(\d+)\s*(段|级)/));
  const fullWinSteps = promotionStepCountFromMatch(matched.match(/(?:全胜|\d+连胜)[^。；;]*(?:跳升|晋升|升)([一二两三\d]+)个级别/));
  const topNTarget = topNTargetFromMatch(matched.match(/(?:第\s*(\d+)\s*名|前\s*(\d+)\s*名)[^。；;]*(?:晋升|升)(?:为|至)?(\d+)\s*(段|级)/));
  const topNSteps = topNStepsFromMatch(matched.match(/(?:各组)?(?:第\s*(\d+)\s*名|第([一二三四五六七八九十]+)名|第一)[^。；;]*(?:晋升|升)([一二两三\d]+)个(?:级别|段位)/));
  const explicitTarget = targetLabelFromMatch(matched.match(/(?:晋升|升)(?:为|至)?(\d+)\s*(段|级)/));
  const applyTarget = targetLabelFromMatch(matched.match(/申请(\d+)\s*(级)/));
  const percent = numberFromMatch(matched.match(/(?:前|按|按照)?\s*(\d+(?:\.\d+)?)\s*%\s*(?:的)?(?:比例)?/));
  const topN = topNTarget?.topN || topNSteps?.topN || numberFromMatch(matched.match(/前\s*(\d+)\s*名/));
  const wins = numberFromMatch(matched.match(/胜\s*(\d+)\s*盘/) || matched.match(/(\d+)\s*胜/));
  const champion = /冠军/.test(matched);
  const stepMatch = matched.match(/(?:晋升|升)([一二两三\d]+)个(?:级别|段位)/);
  const oneLevel = /(?:晋升|升)(?:为)?(?:1|一)个(?:级别|段位)|(?:晋升|升)(?:1|一)个/.test(matched);
  const steps = promotionStepCountFromMatch(stepMatch) || (oneLevel ? 1 : null);

  return {
    text: matched,
    percent,
    topN: champion && !topN ? 1 : topN,
    wins,
    topNTargetLabel: topNTarget?.targetLabel || (topNSteps ? targetLabelBySteps(level, topNSteps.steps, context) : null),
    targetLabel: explicitTarget || applyTarget || (steps ? targetLabelBySteps(level, steps, context) : null),
    fullWinTargetLabel: fullWinExplicit || (fullWinSteps ? targetLabelBySteps(level, fullWinSteps, context) : null),
  };
}

function narrowFragmentToGroup(fragment, groupName, level) {
  const labels = candidateGroupLabels(groupName, level);
  const starts = labels
    .map(label => ({ label, start: fragment.indexOf(label) }))
    .filter(item => item.start >= 0)
    .sort((a, b) => a.start - b.start || b.label.length - a.label.length);
  if (!starts.length) return fragment;

  const { label, start } = starts[0];
  if (start < 0) return fragment;

  const minEnd = start + label.length;
  const tail = fragment.slice(minEnd);
  for (const match of tail.matchAll(/\d+\s*[段级]组/g)) {
    const idx = minEnd + match.index;
    const beforeNextGroup = fragment.slice(start, idx);
    if (/%|晋升|升为|升至|申请|前\d+名|第\d+名|\d+胜/.test(beforeNextGroup)) {
      return beforeNextGroup;
    }
  }
  return fragment.slice(start);
}

function fragmentMentionsGroup(fragment, groupName, level) {
  return candidateGroupLabels(groupName, level).some(label => fragment.includes(label));
}

function candidateGroupLabels(groupName, level) {
  const labels = [];
  const rawGroup = String(groupName || '').replace(/\s+/g, '');
  if (rawGroup) labels.push(rawGroup);

  const fixedDan = rawGroup.match(/^定(\d+)段/);
  if (fixedDan) {
    labels.push(`定${fixedDan[1]}段组`, `定${fixedDan[1]}段`);
  } else if (level) {
    labels.push(`${level.current}${level.kind === 'dan' ? '段' : '级'}组`);
  }

  return [...new Set(labels.filter(Boolean))];
}

function groupMentionMatches(fragment, groupName) {
  const level = parseCandidateLevel(groupName);
  if (!level) return false;
  return fragmentMentionsGroup(fragment, String(groupName || '').replace(/\s+/g, ''), level);
}

function targetFromMatch(match) {
  return match ? parseInt(match[1], 10) || null : null;
}

function targetLabelFromMatch(match) {
  return match ? `${parseInt(match[1], 10)}${match[2]}` : null;
}

function topNTargetFromMatch(match) {
  if (!match) return null;
  const topN = parseInt(match[1] || match[2], 10) || 0;
  const target = parseInt(match[3], 10) || 0;
  if (!topN || !target) return null;
  return {
    topN,
    targetLabel: `${target}${match[4]}`,
  };
}

function topNStepsFromMatch(match) {
  if (!match) return null;
  const topN = match[0].includes('第一')
    ? 1
    : (parseInt(match[1], 10) || chineseNumber(match[2]));
  const steps = promotionStepCount(match[3]);
  if (!topN || !steps) return null;
  return { topN, steps };
}

function promotionStepCountFromMatch(match) {
  return match ? promotionStepCount(match[1]) : null;
}

function promotionStepCount(value) {
  const s = String(value || '').trim();
  const digit = parseInt(s, 10);
  if (Number.isFinite(digit) && digit > 0) return digit;
  return chineseNumber(s);
}

function chineseNumber(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const map = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  return map[s] || null;
}

function numberFromMatch(match) {
  return match ? parseFloat(match[1]) || null : null;
}

function targetLabelBySteps(level, steps, context = {}) {
  const n = parseInt(steps, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (level.kind === 'dan') return `${level.current + n}段`;

  const ladder = inferLevelLadder(context.eventGroups);
  if (!ladder || !ladder.length) return null;
  const idx = ladder.indexOf(level.current);
  if (idx < 0) return null;
  const targetIdx = idx + n;
  if (targetIdx < ladder.length) return `${ladder[targetIdx]}级`;
  return `${targetIdx - ladder.length + 1}段`;
}

function inferLevelLadder(eventGroups) {
  const levels = [...new Set((eventGroups || []).map(g => {
    const m = String(g.group_name || '').match(/(\d+)\s*级组/);
    return m ? parseInt(m[1], 10) : null;
  }).filter(n => Number.isFinite(n)))];
  if (levels.length < 2) return null;
  return levels.sort((a, b) => b - a);
}

async function inferPromotionFromLaterGroups({ item, stats, rule, chronological, eventGroups }) {
  const currentDate = item.row.min_time || '';
  if (!canInferPromotionFromLaterGroups(item.row, rule)) return { promoted: false };

  const currentGroups = await getGroupsForEvent(item.row.event_id, eventGroups);
  const currentLadder = inferLevelLadder(currentGroups);

  for (const later of chronological) {
    if ((later.row.min_time || '') <= currentDate) continue;
    if (!canUseLaterGroupAsPromotionEvidence(later.row)) continue;
    const step = promotionStep(item.level, later.level, currentLadder);
    if (step === null) continue;
    if (step < 1) return { promoted: false };
    if (step > 2) return { promoted: false };
    if (!hasSubsequentPromotionRecord(item.row, stats, step)) return { promoted: false };
    return {
      promoted: true,
      promotedTo: levelLabel(later.level),
      confidence: '中',
      basis: '',
      ruleText: '',
      source: 'subsequent-group',
    };
  }

  return { promoted: false };
}

function canUseLaterGroupAsPromotionEvidence(row) {
  const text = [
    row.title || '',
    row.cname || '',
    row.city_name || '',
  ].join(' ');
  return !/公益|慈善|网赛|网络赛|线上|邀请赛|交流赛|联谊/.test(text);
}

function hasSubsequentPromotionRecord(row, stats, step) {
  if (hasPromotionLikeRecord(row, stats)) return true;
  const win = parseInt(row.win, 10) || 0;
  const lose = parseInt(row.lose, 10) || 0;
  const draw = parseInt(row.draw, 10) || 0;
  const rounds = win + lose + draw;
  if (step !== 1 || rounds < 5) return false;
  const rate = (win + 0.5 * draw) / rounds;
  return win > lose && rate >= 2 / 3;
}

function canInferPromotionFromLaterGroups(row, rule = null) {
  const text = [
    row.title || '',
    row.cname || '',
    row.city_name || '',
  ].join(' ');
  if (/公益|慈善|网赛|网络赛|线上|邀请赛|交流赛|联谊/.test(text)) return false;
  return /段级位赛|段位赛|级位赛|定级|定段/.test(text)
    || isAssociationBackedPublicRankEvent(row)
    || hasExplicitPromotionRule(rule);
}

function hasExplicitPromotionRule(rule) {
  return Boolean(rule && (
    rule.percent
    || rule.topN
    || rule.wins
    || rule.targetLabel
    || rule.fullWinTargetLabel
    || rule.topNTargetLabel
  ));
}

function isAssociationBackedPublicRankEvent(row) {
  if (!PROVINCIAL_ASSOCIATION_RULES[String(row.provincename || '')]) return false;
  const title = String(row.title || '');
  const text = [
    title,
    row.cname || '',
    row.city_name || '',
  ].join(' ');
  if (!/围棋/.test(text)) return false;
  if (!/公开赛|冠军赛|大奖赛|争霸赛/.test(title)) return false;
  return /围棋(?:爱好者)?协会|棋类协会|棋院|智力运动中心|体育局/.test(text);
}

function canUseAssociationRuleForBackedPublicEvent(row, level) {
  if (!isAssociationBackedPublicRankEvent(row)) return false;
  if (!CONFIRMED_PUBLIC_ASSOCIATION_RULE_EVENTS.has(String(row.event_id || ''))) return false;
  return level?.kind === 'dan' && level.current >= 3;
}

function hasPromotionLikeRecord(row, stats = {}) {
  const win = parseInt(row.win, 10) || 0;
  const lose = parseInt(row.lose, 10) || 0;
  const draw = parseInt(row.draw, 10) || 0;
  const rounds = win + lose + draw;
  if (rounds < 5) return false;
  const rate = (win + 0.5 * draw) / rounds;
  const rank = parseInt(stats.rank, 10) || 0;
  const groupSize = parseInt(stats.groupSize, 10) || 0;
  const rankLooksPromotable = rank && groupSize && rank <= Math.ceil(groupSize * 0.35);
  return rate >= 0.75 || rankLooksPromotable;
}

function promotionStep(from, to, ladder) {
  if (!from || !to) return null;
  if (from.kind === 'dan' && to.kind === 'dan') return to.current - from.current;
  if (from.kind === 'level' && to.kind === 'level') {
    if (!ladder || !ladder.length) return null;
    const fromIdx = ladder.indexOf(from.current);
    const toIdx = ladder.indexOf(to.current);
    if (fromIdx < 0 || toIdx < 0) return null;
    return toIdx - fromIdx;
  }
  if (from.kind === 'level' && to.kind === 'dan') {
    if (!ladder || !ladder.length) return null;
    const fromIdx = ladder.indexOf(from.current);
    if (fromIdx < 0) return null;
    return (ladder.length - fromIdx) + (to.current - 1);
  }
  return null;
}

function levelLabel(level) {
  return level.kind === 'dan' ? `${level.current}段` : `${level.current}级`;
}

function decidePromotion({ row, stats, rule, level }) {
  const win = parseInt(row.win, 10) || 0;
  const lose = parseInt(row.lose, 10) || 0;
  const draw = parseInt(row.draw, 10) || 0;
  const rounds = win + lose + draw;
  const rank = stats.rank || 0;
  const groupSize = stats.groupSize || 0;
  const targetFromFullWin = rule?.fullWinTargetLabel && rounds > 0 && win === rounds ? rule.fullWinTargetLabel : null;

  if (!rule) return null;

  let promoted = false;
  let basis = '';
  let target = targetFromFullWin || rule.targetLabel;
  if (rule.minRounds && rounds < rule.minRounds) return { promoted: false };
  if (targetFromFullWin) {
    promoted = true;
    basis = `规程写明全胜特殊晋升；选手${win}胜全胜`;
  } else if (rule.topNTargetLabel && rule.topN && rank && rank <= rule.topN) {
    promoted = true;
    target = rule.topNTargetLabel;
    basis = `规程写明${row.group_name}前${rule.topN}名晋升至${target}；选手第${rank}名`;
  } else if (rule.percent && rank && groupSize) {
    const quota = promotionQuota(groupSize, rule.percent, rule.rounding);
    promoted = rank <= quota;
    basis = `规程写明${row.group_name}前${rule.percent}%晋升；本组${groupSize}人，${roundingLabel(rule.rounding)}为${quota}个名额，选手第${rank}名`;
  } else if (rule.topN && rank) {
    promoted = rank <= rule.topN;
    basis = `规程写明${row.group_name}前${rule.topN}名晋升；选手第${rank}名`;
  } else if (rule.wins) {
    promoted = win >= rule.wins;
    basis = `规程写明达到${rule.wins}胜晋升；选手${win}胜${lose}负${draw ? draw + '和' : ''}`;
  }

  if (!promoted || !target) return { promoted: false };

  return {
    promoted: true,
    promotedTo: target,
    confidence: '高',
    basis,
    ruleText: rule.text,
    source: rule.source || 'notice',
  };
}

function promotionQuota(groupSize, percent, rounding = 'ceil') {
  const raw = groupSize * percent / 100;
  if (rounding === 'round') return Math.max(1, Math.round(raw));
  if (rounding === 'floor') return Math.max(1, Math.floor(raw));
  return Math.max(1, Math.ceil(raw));
}

function roundingLabel(rounding = 'ceil') {
  if (rounding === 'round') return '按比例四舍五入';
  if (rounding === 'floor') return '按比例向下取整';
  return '按比例向上取整';
}

async function fetchGroupParticipants(groupId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const params = new URLSearchParams({ groupid: String(groupId), callback: 'cb' });
    const text = await fetchText(`${EVENTPART_API}?${params}`, {
      headers: { Referer: 'https://www.yunbisai.com/' },
      timeout: REQUEST_TIMEOUT_MS,
    });
    const data = parseJsonp(text);
    if (data.datArr === 'wait') {
      await delay(700);
      continue;
    }
    if (data.error !== 0) throw new Error(data.msg || 'Eventpart API error');
    return data.datArr?.rows || [];
  }
  return [];
}

async function fetchText(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonp(text) {
  const s = text.trim()
    .replace(/^[^(]+\(/, '')
    .replace(/\);\s*$/, '')
    .replace(/\)\s*$/, '');
  return JSON.parse(s);
}

module.exports = {
  estimatePromotionHistory,
  parseCandidateLevel,
  extractPromotionRule,
};
