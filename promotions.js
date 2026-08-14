'use strict';

const fetch = require('node-fetch');
const {
  queryPromotionCandidates,
  getEventNoticeCache,
  replaceEventNoticeCache,
} = require('./db');

const EVENT_NOTICE_API = 'https://data-center.yunbisai.com/api/lswl-events';
const EVENTPART_API = 'https://api.yunbisai.com/request/Group/Eventpart';
const NOTICE_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12000;
const delay = ms => new Promise(r => setTimeout(r, ms));

async function estimatePromotionHistory({ name, province = '', dateFrom = '0000-01-01', dateTo = '9999-12-31' }) {
  const rows = await queryPromotionCandidates({ name, province, dateFrom, dateTo });
  const candidates = rows.filter(row => parseCandidateLevel(row.group_name));
  const results = [];
  const notices = new Map();
  const groupRows = new Map();

  for (const row of candidates) {
    const level = parseCandidateLevel(row.group_name);
    if (!level) continue;

    const stats = await enrichRankAndGroupSize(row, groupRows);
    const notice = await getNoticeForEvent(row.event_id, notices);
    const rule = extractPromotionRule(notice.text, row.group_name, level);
    const decision = decidePromotion({ row, stats, rule, level, hasNotice: notice.hasNotice });
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

  results.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return {
    name,
    scope: { province: province || '__ALL__', dateFrom, dateTo },
    count: results.length,
    items: results,
    scanned: rows.length,
  };
}

function parseCandidateLevel(groupName) {
  const g = String(groupName || '').trim();
  const dan = g.match(/(\d+)\s*段组/);
  if (dan) {
    const current = parseInt(dan[1], 10);
    if (current >= 1 && current <= 5) return { kind: 'dan', current, defaultTarget: current + 1 };
  }
  if (/1\s*级组|一级组|定段组/.test(g)) return { kind: 'one-grade', current: 1, defaultTarget: 1 };
  return null;
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
    return { text: cached.notice_text || '', hasNotice: Boolean(cached.notice_text) };
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
    return { text: cached?.notice_text || '', hasNotice: Boolean(cached?.notice_text) };
  }
}

function parseNoticePayload(payload) {
  if (!payload) return '';
  let raw = String(payload);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map(item => `${item.t || ''}: ${stripHtml(item.h || '')}`).join('\n').trim();
    }
  } catch (_) {}
  try {
    raw = decodeURIComponent(raw);
  } catch (_) {}
  return stripHtml(raw);
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

function extractPromotionRule(text, groupName, level) {
  if (!text) return null;
  const g = String(groupName || '').replace(/\s+/g, '');
  const normalized = text.replace(/\s+/g, '');
  const fragments = normalized
    .split(/[。；;\n]/)
    .map(x => x.trim())
    .filter(x => x && /升段|升级|晋升|段位|级位/.test(x));
  const promotionFragments = fragments.filter(x => /升段|升级|晋升/.test(x));
  const searchFragments = promotionFragments.length ? promotionFragments : fragments;

  const matches = searchFragments.filter(f => f.includes(g) || groupMentionMatches(f, g));
  if (!matches.length) return null;

  for (const fragment of matches) {
    const parsed = parseRuleFragment(fragment, level);
    if (parsed.target || parsed.fullWinTarget || /晋升/.test(fragment)) return parsed;
  }
  return parseRuleFragment(matches[0], level);
}

function parseRuleFragment(matched, level) {
  const fullWinTarget = targetFromMatch(matched.match(/全胜[^。；;]*晋升为?(\d+)\s*段/));
  const explicitTarget = targetFromMatch(matched.match(/晋升为?(\d+)\s*段/));
  const percent = numberFromMatch(matched.match(/前\s*(\d+(?:\.\d+)?)\s*%/));
  const topN = numberFromMatch(matched.match(/前\s*(\d+)\s*名/));
  const wins = numberFromMatch(matched.match(/胜\s*(\d+)\s*盘/) || matched.match(/(\d+)\s*胜/));
  const champion = /冠军/.test(matched);
  const oneLevel = /晋升(?:为)?1个(?:级别|段位)|晋升1个/.test(matched);

  return {
    text: matched,
    percent,
    topN: champion && !topN ? 1 : topN,
    wins,
    target: explicitTarget || (oneLevel ? level.defaultTarget : null),
    fullWinTarget,
  };
}

function groupMentionMatches(fragment, groupName) {
  const m = groupName.match(/(\d+)(段|级)组/);
  if (!m) return false;
  const n = m[1];
  const unit = m[2];
  return fragment.includes(`${n}${unit}组`);
}

function targetFromMatch(match) {
  return match ? parseInt(match[1], 10) || null : null;
}

function numberFromMatch(match) {
  return match ? parseFloat(match[1]) || null : null;
}

function decidePromotion({ row, stats, rule, level, hasNotice }) {
  const win = parseInt(row.win, 10) || 0;
  const lose = parseInt(row.lose, 10) || 0;
  const draw = parseInt(row.draw, 10) || 0;
  const rounds = win + lose + draw;
  const rank = stats.rank || 0;
  const groupSize = stats.groupSize || 0;
  const targetFromFullWin = rule?.fullWinTarget && rounds > 0 && win === rounds ? rule.fullWinTarget : null;
  const target = targetFromFullWin || rule?.target || level.defaultTarget;

  if (rule) {
    let promoted = false;
    let basis = '';
    let ruleWasEvaluated = false;
    if (rule.percent && rank && groupSize) {
      const quota = Math.max(1, Math.ceil(groupSize * rule.percent / 100));
      promoted = rank <= quota;
      basis = `规程写明${row.group_name}前${rule.percent}%晋升；本组${groupSize}人，按比例向上取整为${quota}个名额，选手第${rank}名`;
      ruleWasEvaluated = true;
    } else if (rule.topN && rank) {
      promoted = rank <= rule.topN;
      basis = `规程写明${row.group_name}前${rule.topN}名晋升；选手第${rank}名`;
      ruleWasEvaluated = true;
    } else if (rule.wins) {
      promoted = win >= rule.wins;
      basis = `规程写明达到${rule.wins}胜晋升；选手${win}胜${lose}负${draw ? draw + '和' : ''}`;
      ruleWasEvaluated = true;
    } else if (targetFromFullWin) {
      promoted = true;
      basis = `规程写明全胜特殊晋升；选手${win}胜全胜`;
      ruleWasEvaluated = true;
    }

    if (promoted && target >= 1) {
      return {
        promoted: true,
        promotedTo: `${target}段`,
        confidence: '高',
        basis,
        ruleText: rule.text,
        source: 'notice',
      };
    }
    if (ruleWasEvaluated) return { promoted: false };
  }

  const fallback = fallbackPromotion({ row, stats, level, hasNotice });
  if (fallback.promoted) return fallback;
  return { promoted: false };
}

function fallbackPromotion({ row, stats, level, hasNotice }) {
  const win = parseInt(row.win, 10) || 0;
  const lose = parseInt(row.lose, 10) || 0;
  const draw = parseInt(row.draw, 10) || 0;
  const rounds = win + lose + draw;
  const rank = stats.rank || 0;
  const groupSize = stats.groupSize || 0;
  if (!rounds) return { promoted: false };

  const likelyByWins = rounds >= 6 && win >= Math.ceil(rounds * 0.8);
  const likelyByRank = rank && groupSize && rank <= Math.max(1, Math.ceil(groupSize * 0.1));
  if (!likelyByWins && !likelyByRank) return { promoted: false };

  const target = level.defaultTarget;
  const basisParts = [];
  if (rank && groupSize) basisParts.push(`第${rank}名/共${groupSize}人`);
  basisParts.push(`${win}胜${lose}负${draw ? draw + '和' : ''}`);
  return {
    promoted: true,
    promotedTo: `${target}段`,
    confidence: hasNotice ? '中' : '低',
    basis: `未解析到明确升段条款，按常见段位赛规则推测：${basisParts.join('，')}`,
    ruleText: '',
    source: hasNotice ? 'fallback-notice' : 'fallback',
  };
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
