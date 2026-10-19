'use strict';

const { parseResponse, assertSuccess, identity, number, invalid } = require('./yunbisai-response');
const BASE = 'https://data-center.yunbisai.com/api/competition/';
const BYE = '__live_bye__';
const labels = {
  name: '\u59d3\u540d', short: '\u7f16\u53f7', org: '\u5355\u4f4d',
  score: '\u4e2a\u4eba\u79ef\u5206', rank: '\u540d\u6b21', opponent: '\u5bf9\u624b',
  points: '\u79ef\u5206', total: '\u603b\u6210\u7ee9\u8868',
};

const decode = value => String(value).replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

function headerCell(value) {
  const [label, ...attributes] = value.split(',');
  const result = { label: label.trim() };
  for (const entry of attributes) {
    const match = entry.match(/^([FCR])=(\d+)$/);
    if (match) result[match[1]] = number(match[2], { integer: true, max: 200 });
  }
  return result;
}

function parsePublishedResults(data, groupId, entry) {
  assertSuccess(data);
  const table = data.data;
  if (!table || !Array.isArray(table.tabletop) || !Array.isArray(table.tabledata)
    || !table.tabledata.length || table.tabledata.length > 1500 || table.elsedata?.length) throw invalid('UNSUPPORTED_RESULT_TABLE');
  const top = String(table.tabletop[0]).split(';').map(headerCell);
  const sub = String(table.tabletop[1] || '').split(';').map(headerCell);
  const field = label => top.filter(cell => cell.label === label && cell.F != null).at(-1)?.F;
  const fields = Object.fromEntries(['name', 'short', 'score', 'rank'].map(key => [key, field(labels[key])]));
  const columnCount = Math.max(...[...top, ...sub].filter(cell => cell.F != null).map(cell => cell.F)) + 1;
  const orgField = field(labels.org);
  const totalField = field('\u603b\u5f97\u5206');
  if (Object.values(fields).some(value => value == null)) throw invalid('UNSUPPORTED_RESULT_COLUMNS');
  let offset = 0;
  const rounds = top.filter(cell => /^\u7b2c\d+\u8f6e$/.test(cell.label)).map((cell, index) => {
    if (cell.label !== `\u7b2c${index + 1}\u8f6e` || cell.C !== 2) throw invalid('UNSUPPORTED_RESULT_ROUNDS');
    const columns = sub.slice(offset, offset + cell.C);
    offset += cell.C;
    const opponent = columns.find(column => column.label === labels.opponent)?.F;
    const points = columns.find(column => column.label === labels.points)?.F;
    if (opponent == null || points == null) throw invalid('UNSUPPORTED_RESULT_ROUNDS');
    return { opponent, points };
  });
  if (!rounds.length || rounds.length > 30) throw invalid('INVALID_RESULT_ROUND_COUNT');
  const ids = new Set(), shortNumbers = new Set();
  const players = table.tabledata.map(value => {
    if (typeof value !== 'string') throw invalid('INVALID_RESULT_ROW');
    const cells = value.split(';').map(decode);
    if (cells.length !== columnCount) throw invalid('INVALID_RESULT_COLUMN_COUNT');
    const name = cells[fields.name]?.match(/^(.+?)&pId:([1-9]\d{0,14})$/i);
    if (!name || !name[1].trim()) throw invalid('INVALID_RESULT_PLAYER');
    const id = identity(name[2]);
    const short = identity(cells[fields.short]);
    if (ids.has(id) || shortNumbers.has(short)) throw invalid('DUPLICATE_RESULT_PLAYER');
    ids.add(id); shortNumbers.add(short);
    const score = number(cells[fields.score]);
    const inactive = score === 0 && rounds.every(round => !cells[round.opponent]);
    let previous = 0;
    const games = rounds.map(round => {
      if (inactive) return null;
      const opponent = cells[round.opponent];
      if (!opponent) throw invalid('INCOMPLETE_PUBLISHED_RESULTS');
      const unscored = cells[round.points] === '-';
      const total = unscored ? previous : number(cells[round.points]);
      const points = total - previous;
      previous = total;
      if (points < 0 || points > 2) throw invalid('UNSUPPORTED_RESULT_SCORING');
      const isBye = ['0', '-', '\u8f6e\u7a7a'].includes(opponent);
      const matched = opponent.match(/^(\*)?([1-9]\d{0,14})$/);
      if (!isBye && !matched) throw invalid('UNSUPPORTED_RESULT_OPPONENT');
      return { opponent: isBye ? null : matched[2], black: Boolean(matched?.[1]), points, unscored };
    });
    if (previous !== score && !inactive) throw invalid('INCONSISTENT_RESULT_SCORE');
    return { id, name: name[1].trim(), org: orgField == null ? '' : cells[orgField] || '', short_no: short,
      score, cloud_rank: number(cells[fields.rank], { integer: true, min: 1, max: table.tabledata.length }),
      official_total_score: totalField == null ? null : number(cells[totalField], { min: -1000000 }),
      win: 0, lose: 0, draw: 0, inactive, games };
  });
  const byShort = new Map(players.map(player => [player.short_no, player]));
  const rows = [];
  let unscoredGames = 0;
  for (let index = 0; index < rounds.length; index++) {
    const seen = new Set();
    let seat = 0;
    for (const player of players) {
      if (player.inactive || seen.has(player.id)) continue;
      const game = player.games[index];
      const opponent = game.opponent == null ? null : byShort.get(game.opponent);
      const other = opponent?.games[index];
      if (game.opponent != null && (!opponent || opponent === player || !other || other.opponent !== player.short_no
        || (game.black && other.black))) throw invalid('INCONSISTENT_RESULT_PAIRINGS');
      const noGame = Boolean(game.unscored && other?.unscored);
      if ((game.points + (other?.points || 0)) <= 0 && !noGame) throw invalid('INCOMPLETE_PUBLISHED_RESULTS');
      if (!opponent && game.points === 0) throw invalid('UNSCORED_RESULT_BYE');
      const ownResult = noGame ? '4' : !opponent || game.points > other.points ? '1' : game.points < other.points ? '2' : '3';
      const otherResult = noGame ? '4' : ownResult === '1' ? '2' : ownResult === '2' ? '1' : '3';
      const stat = result => result === '1' ? 'win' : result === '2' ? 'lose' : 'draw';
      if (!noGame) {
        player[stat(ownResult)]++;
        if (opponent) opponent[stat(otherResult)]++;
      } else unscoredGames++;
      seen.add(player.id);
      if (opponent) seen.add(opponent.id);
      const reverse = Boolean(opponent && other.black && !game.black);
      const p1 = reverse ? opponent : player, p2 = reverse ? player : opponent;
      rows.push({ group_id: String(groupId), bout: index + 1, seat: ++seat,
        p1_id: p1.id, p2_id: p2?.id || BYE, p1_name: p1.name, p2_name: p2?.name || '\u8f6e\u7a7a',
        p1_org: p1.org, p2_org: p2?.org || '',
        p1_result: reverse ? otherResult : ownResult, p2_result: reverse ? ownResult : otherResult,
        p1_score: reverse ? other.points : game.points, p2_score: reverse ? game.points : other?.points || 0,
        ...(noGame ? { published_no_game: true } : {}) });
    }
  }
  // An all-blank, zero-point report row is a nonparticipant, not a bye win.
  for (const player of players.filter(player => player.inactive)) {
    rows.push({ group_id: String(groupId), bout: 1, seat: 0, p1_id: player.id, p2_id: BYE,
      p1_name: player.name, p2_name: '', p1_org: player.org, p2_org: '',
      p1_result: '4', p2_result: '0', p1_score: 0, p2_score: 0 });
  }
  if (!rows.some(row => ['1','2','3'].includes(row.p1_result))) throw invalid('INCOMPLETE_PUBLISHED_RESULTS');
  for (let bout = 1; bout <= rounds.length; bout++) {
    if (!rows.some(row => row.bout === bout)) throw invalid('INCOMPLETE_PUBLISHED_RESULTS');
  }
  return { group_id: String(groupId), report_id: identity(entry.id), published_at: String(entry.createtime || ''),
    rounds: rounds.length, title: String(table.TableName || ''), unscored_games: unscoredGames,
    players: players.map(({ inactive, games, ...player }) => player), rows };
}

function validateRoster(report, players = []) {
  if (!report) return;
  const incoming = new Map(report.players.map(player => [String(player.id), player]));
  if (players.length && players.length !== incoming.size) throw invalid('INCOMPLETE_RESULT_ROSTER');
  for (const player of players) {
    const result = incoming.get(String(player.id));
    if (!result || result.name.normalize('NFKC') !== player.name.trim().normalize('NFKC')
      || result.win + result.lose + result.draw < Number(player.win) + Number(player.lose) + Number(player.draw)) {
      throw invalid('STALE_OR_MISMATCHED_RESULT_ROSTER');
    }
  }
}

function mergePublishedMatches(rows, published) {
  const key = row => `${row.bout}:${[row.p1_id, row.p2_id].sort().join(':')}`;
  const old = new Map(rows.map(row => [key(row), row]));
  return published.map(row => {
    const previous = old.get(key(row));
    if (!previous || previous.p1_id === row.p1_id) return { ...previous, ...row };
    return { ...previous, ...row, p1_id: row.p2_id, p2_id: row.p1_id,
      p1_name: row.p2_name, p2_name: row.p1_name, p1_org: row.p2_org, p2_org: row.p1_org,
      p1_result: row.p2_result, p2_result: row.p1_result, p1_score: row.p2_score, p2_score: row.p1_score };
  });
}

function createPublishedResultsClient({ getCached, saveCached, ttlMs = 60000 } = {}) {
  const cache = new Map();
  let cacheBytes = 0;
  function remember(key, value) {
    if (cache.has(key)) { cacheBytes -= cache.get(key).bytes; cache.delete(key); }
    const bytes = Buffer.byteLength(JSON.stringify(value.report || null)) + 512;
    const budget = 16 * 1024 * 1024;
    while (cache.size && (cache.size >= 32 || cacheBytes + bytes > budget)) {
      const oldest = cache.keys().next().value;
      cacheBytes -= cache.get(oldest).bytes;
      cache.delete(oldest);
    }
    if (bytes <= budget) { cache.set(key, { ...value, bytes }); cacheBytes += bytes; }
  }
  return async function getPublishedResults(groupId, { fetchText, players = [], eventId, endedAt }) {
    identity(groupId);
    const contextKey = `${eventId || ''}:${endedAt || ''}`;
    const current = cache.get(String(groupId));
    if (current?.expiresAt > Date.now() && (current.report || current.contextKey === contextKey)) {
      try {
        validateRoster(current.report, players);
        return { report: current.report, warning: current.warning || '' };
      } catch (_) { /* A newer live roster must trigger another source check. */ }
    }
    let previous = current?.report;
    if (!previous && typeof getCached === 'function') previous = await getCached(groupId);
    try {
      const options = { headers: { Referer: 'https://www.yunbisai.com/' }, timeout: 8000 };
      const list = assertSuccess(parseResponse(await fetchText(`${BASE}results/group/${groupId}`, options, 0)));
      if (!Array.isArray(list.datArr)) throw invalid('INVALID_PUBLISHED_RESULT_LIST');
      const entries = list.datArr.filter(entry => entry.title?.trim() === labels.total);
      for (const entry of entries) {
        if (String(entry.group_id) !== String(groupId)) throw invalid('PUBLISHED_RESULT_GROUP_MISMATCH');
        identity(entry.id);
      }
      entries.sort((a, b) => String(b.createtime || '').localeCompare(String(a.createtime || '')) || Number(b.id) - Number(a.id));
      let report = previous || null;
      if (entries.length) {
        const entry = entries[0];
        if (!previous || String(entry.createtime || '') > previous.published_at
          || (String(entry.createtime || '') === previous.published_at && Number(entry.id) >= Number(previous.report_id))) {
          report = parsePublishedResults(parseResponse(await fetchText(`${BASE}group/results/${entry.id}`, options, 0)), groupId, entry);
          if (report.unscored_games || endedAt) {
            let end = endedAt;
            if (!end && eventId) {
              identity(eventId);
              const groups = assertSuccess(parseResponse(await fetchText(`https://data-center.yunbisai.com/api/lswl-groups/event/${eventId}`, options, 0)));
              if (!Array.isArray(groups.data)) throw invalid('INVALID_RESULT_EVENT_METADATA');
              end = groups.data.find(group => String(group.groupid) === String(groupId) && String(group.eventid) === String(eventId))?.endtime;
            }
            const timestamp = value => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value || '')
              ? Date.parse(value.replace(' ', 'T').replace(/\.\d+$/, '') + '+08:00') : NaN;
            if (Number.isFinite(timestamp(end)) && Number.isFinite(timestamp(report.published_at))
              && timestamp(end) <= timestamp(report.published_at)) report.ended_at = end;
            else if (report.unscored_games) throw invalid('UNCONFIRMED_UNSCORED_PUBLISHED_RESULTS');
          }
          validateRoster(report, players);
          if (previous && report.rounds < previous.rounds) throw invalid('PUBLISHED_RESULT_ROUND_REGRESSION');
          if (typeof saveCached === 'function' && await saveCached(report) === false && typeof getCached === 'function') {
            report = await getCached(groupId);
            validateRoster(report, players);
          }
        }
      }
      validateRoster(report, players);
      remember(String(groupId), { report, contextKey, expiresAt: Date.now() + ttlMs });
      return { report, warning: '' };
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      try { validateRoster(previous, players); } catch (_) { previous = null; }
      const warning = previous ? '\u6b63\u5f0f\u6210\u7ee9\u6682\u65f6\u65e0\u6cd5\u5237\u65b0\uff0c\u4f7f\u7528\u5df2\u6821\u9a8c\u7248\u672c'
        : '\u6b63\u5f0f\u6210\u7ee9\u6682\u65f6\u65e0\u6cd5\u6821\u9a8c';
      remember(String(groupId), { report: previous || null, contextKey, warning, expiresAt: Date.now() + 10000 });
      return { report: previous || null, warning };
    }
  };
}

module.exports = { parsePublishedResults, validateRoster, mergePublishedMatches, createPublishedResultsClient };
