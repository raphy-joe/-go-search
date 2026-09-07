'use strict';

const GO = '\u56f4\u68cb';
const OTHER_SPORTS = ['\u8c61\u68cb', '\u56fd\u8c61', '\u4e94\u5b50\u68cb', '\u56fd\u9645\u8df3\u68cb', '\u56fd\u8df3', '\u6865\u724c', '\u8df3\u68cb', '\u519b\u68cb', '\u8c61\u68ca', '\u8db3\u7403', '\u7bee\u7403', '\u7fbd\u6bdb\u7403', '\u4e52\u4e53\u7403'];
const MULTI = ['\u4e09\u68cb', '\u56db\u68cb', '\u68cb\u7c7b'];
const text = value => String(value || '').normalize('NFKC');
const containsOther = value => OTHER_SPORTS.some(word => text(value).includes(word));
const ambiguous = value => containsOther(value) || MULTI.some(word => text(value).includes(word));

function isGoEvent(event, expectedType = '2') {
  const type = event.event_value ?? event.category_id;
  if (type !== undefined && String(type) !== String(expectedType)) return false;
  return !containsOther(event.title) || text(event.title).includes(GO);
}

function isGoGroup(eventTitle, groupName) {
  if (containsOther(groupName)) return false;
  // General multi-sport events require explicit Go labels, not rank-name guesses.
  return !ambiguous(eventTitle) || text(groupName).includes(GO) ||
    (text(eventTitle).includes(GO) && !containsOther(eventTitle));
}

// SQL uses the same literal vocabulary as the ingestion guard. No user SQL is accepted.
function sportSql(title = 'title', group = null) {
  const other = column => '(' + OTHER_SPORTS.map(word => `${column} LIKE '%${word}%'`).join(' OR ') + ')';
  const multi = column => '(' + MULTI.map(word => `${column} LIKE '%${word}%'`).join(' OR ') + ')';
  const event = `(NOT ${other(title)} OR ${title} LIKE '%${GO}%')`;
  if (!group) return event;
  return `${event} AND NOT ${other(group)} AND
    ((NOT ${other(title)} AND NOT ${multi(title)}) OR ${group} LIKE '%${GO}%'
      OR (${title} LIKE '%${GO}%' AND NOT ${other(title)}))`;
}

module.exports = { isGoEvent, isGoGroup, sportSql };
