'use strict';

function invalid(message = 'INVALID_UPSTREAM_RESPONSE') {
  return Object.assign(new Error(message), { code: 'UPSTREAM_UNAVAILABLE', status: 502 });
}

function parseResponse(text) {
  const value = String(text).trim().replace(/^\uFEFF/, '');
  const jsonp = value.match(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(([\s\S]*)\)\s*;?$/);
  try {
    const data = JSON.parse(jsonp ? jsonp[1] : value);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid();
    return data;
  } catch (_) {
    throw invalid();
  }
}

function assertSuccess(data) {
  if (data?.error !== 0 && data?.error !== '0') throw invalid('UPSTREAM_BUSINESS_ERROR');
  return data;
}

function number(value, { integer = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') throw invalid('INVALID_UPSTREAM_NUMBER');
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) {
    throw invalid('INVALID_UPSTREAM_NUMBER');
  }
  return result;
}

function identity(value) {
  if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d{0,14}$/.test(String(value))) throw invalid('INVALID_UPSTREAM_ID');
  return String(value);
}

function eventPage(data) {
  assertSuccess(data);
  const page = data.datArr;
  if (!page || !Array.isArray(page.rows)) throw invalid('INVALID_EVENT_LIST_RESPONSE');
  const totalPages = page.TotalPage == null ? null : number(page.TotalPage, { integer: true, min: 1, max: 100000 });
  const total = page.total == null ? null : number(page.total, { integer: true });
  for (const row of page.rows) {
    identity(row.event_id);
    if (typeof row.title !== 'string' || !row.title.trim() || !/^\d{4}-\d{2}-\d{2}/.test(row.min_time || '')) {
      throw invalid('INVALID_EVENT_ROW');
    }
  }
  return { ...page, totalPages, total };
}

function participants(data, groupId) {
  assertSuccess(data);
  if (!Array.isArray(data.datArr?.rows)) throw invalid('INVALID_PARTICIPANT_RESPONSE');
  const seen = new Set();
  return data.datArr.rows.map(row => {
    const id = identity(row.participantid || row.id || row.pid);
    if (seen.has(id) || (row.group_id != null && String(row.group_id) !== String(groupId))) throw invalid('INVALID_PARTICIPANT_IDENTITY');
    seen.add(id);
    const name = row.participantname ?? row.name;
    if (typeof name !== 'string' || !name.trim()) throw invalid('INVALID_PARTICIPANT');
    const result = { ...row, participantid: id, participantname: name.trim() };
    for (const key of ['vicsum', 'faisum', 'deusum']) result[key] = number(row[key], { integer: true, max: 1000 });
    result.integral = number(row.integral);
    if (row.compositor != null && row.compositor !== '') result.compositor = number(row.compositor, { integer: true });
    return result;
  });
}

function matchRound(data, groupId) {
  assertSuccess(data);
  if (!data.datArr || !Array.isArray(data.datArr.rows)) throw invalid('INVALID_MATCH_RESPONSE');
  const round = data.datArr;
  if (round.groupid != null && String(round.groupid) !== String(groupId)) throw invalid('GROUP_IDENTITY_MISMATCH');
  const rows = round.rows.map(row => {
    const normalized = { ...row };
    for (const side of ['p1', 'p2']) {
      const hasPlayer = row[`${side}id`] != null && !['', '0', 0].includes(row[`${side}id`]);
      if (hasPlayer) identity(row[`${side}id`]);
      if (!['', '0', '1', '2', '3', '4'].includes(String(row[`${side}_result`] ?? ''))) throw invalid('UNKNOWN_RESULT_CODE');
      // A nonexistent bye/absence side has no score field in the public feed.
      normalized[`${side}_score`] = !hasPlayer && row[`${side}_score`] == null ? 0 : number(row[`${side}_score`]);
    }
    return normalized;
  });
  return { ...round, rows };
}

module.exports = { parseResponse, assertSuccess, eventPage, participants, matchRound, identity, number, invalid };
