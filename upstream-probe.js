'use strict';
const response = require('./yunbisai-response');
const { createPublishedResultsClient } = require('./yunbisai-results');

const DEFAULT_SAMPLES = Object.freeze([
  { eventId: '70886', groupId: '349073', formal: true },
  { eventId: '70104', groupId: '348462', formal: false },
]);

async function probeUpstream({ fetchText, samples = DEFAULT_SAMPLES, now = Date.now } = {}) {
  const findings = [], checks = [];
  const check = async (name, fn) => {
    try { checks.push({ name, ...(await fn()), ok: true }); }
    catch (error) { checks.push({ name, ok: false }); findings.push({ severity: 'critical', check: name, code: error.message }); }
  };
  const read = async url => response.parseResponse(await fetchText(url, { priority: 'background', timeout: 10000 }, 1));
  await check('event-pagination', async () => {
    const pages = [];
    for (let page = 1; page <= 2; page++) {
      const params = new URLSearchParams({ page, PageSize: 100, eventType: 2, areaNum: '\u56db\u5ddd\u7701' });
      pages.push(response.eventPage(await read(`https://data-center.yunbisai.com/api/lswl-events?${params}`)));
    }
    if (!pages[0].rows.length || !pages[1].rows.length || !pages[0].totalPages) throw new Error('MISSING_PAGE_METADATA');
    const ids = pages.flatMap(page => page.rows.map(row => String(row.event_id)));
    if (new Set(ids).size !== ids.length) throw new Error('DUPLICATE_EVENT_PAGES');
    return { page_sizes: pages.map(page => page.rows.length), total_pages: pages[0].totalPages };
  });
  for (const sample of samples) await check(`group-${sample.groupId}`, async () => {
    const groups = response.assertSuccess(await read(`https://data-center.yunbisai.com/api/lswl-groups/event/${sample.eventId}`));
    if (!Array.isArray(groups.data)) throw new Error('INVALID_GROUP_SCHEMA');
    const group = groups.data.find(group => String(group.groupid) === sample.groupId);
    if (!group || String(group.eventid) !== sample.eventId || String(group.eventtype) !== '2') throw new Error('GROUP_EVENT_MISMATCH');
    const base = 'https://api.yunbisai.com/request/Group/';
    const players = response.participants(await read(`${base}Eventpart?groupid=${sample.groupId}&callback=cb`), sample.groupId);
    if (!players.length || players.length < Number(group.pnumber)) throw new Error('INCOMPLETE_ROSTER');
    const roster = new Set(players.map(player => player.participantid));
    const first = response.matchRound(await read(`${base}Againstplan?groupid=${sample.groupId}&team=0&bout=1&callback=cb`), sample.groupId);
    const total = response.number(first.total_bout, { integer: true, min: 1, max: 30 });
    const last = total > 1 ? response.matchRound(await read(`${base}Againstplan?groupid=${sample.groupId}&team=0&bout=${total}&callback=cb`), sample.groupId) : first;
    const signature = sheet => sheet.rows.map(row => `${row.againstplanid}:${row.p1id}:${row.p2id}`).sort().join('|');
    if (total > 1 && signature(first) && signature(first) === signature(last)) {
      findings.push({ severity: 'warning', check: `group-${sample.groupId}`, code: 'ROUND_ENDPOINT_FALLBACK' });
    }
    for (const sheet of [first, last]) {
      const seen = new Set();
      for (const row of sheet.rows) for (const side of ['p1', 'p2']) {
        const id = String(row[`${side}id`] || '');
        if (!id || id === '0') continue;
        if (!roster.has(id) || seen.has(id)) throw new Error('DUPLICATE_OR_UNKNOWN_ROUND_PLAYER');
        seen.add(id);
      }
      const active = players.filter(player => Number(player.vicsum) + Number(player.faisum) + Number(player.deusum) > 0);
      if (sheet.rows.length && active.some(player => !seen.has(player.participantid))) throw new Error('INCOMPLETE_ROUND_ROSTER');
    }
    const published = createPublishedResultsClient();
    const final = await published(sample.groupId, { fetchText: (url, options, retries) => fetchText(url, { ...options, priority: 'background' }, retries),
      eventId: sample.eventId, endedAt: group.endtime,
      players: players.map(player => ({ id: player.participantid, name: player.participantname,
        win: player.vicsum, lose: player.faisum, draw: player.deusum })) });
    if (final.warning || (sample.formal && !final.report)) throw new Error('PUBLISHED_RESULTS_UNAVAILABLE_OR_INVALID');
    let differences = 0;
    if (final.report) {
      const formal = new Map(final.report.players.map(player => [player.id, player]));
      differences = players.filter(player => {
        const row = formal.get(player.participantid);
        return row && (row.score !== player.integral || row.win !== player.vicsum || row.lose !== player.faisum
          || row.draw !== player.deusum || row.cloud_rank !== Number(player.compositor));
      }).length;
      if (differences) findings.push({ severity: 'warning', check: `group-${sample.groupId}`, code: 'LEGACY_FORMAL_DIVERGENCE', count: differences });
    }
    return { participants: players.length, legacy_rounds: total, formal_rounds: final.report?.rounds || null, legacy_formal_differences: differences };
  });
  return { checked_at: now(), status: findings.some(item => item.severity === 'critical') ? 'failed'
    : findings.length ? 'degraded' : 'ok', checks, findings };
}
module.exports = { probeUpstream, DEFAULT_SAMPLES };
