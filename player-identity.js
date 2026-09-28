'use strict';

const { rowBase } = require('./strength-baseline');
const COMPARISON_DAYS = 180;
const SIMILAR_GAP = 1.25;
const CONFLICT_GAP = 2;
const recordKey = row => `${row.event_id}:${row.group_id}:${row.participant_id}`;
const median = values => { const sorted = [...values].sort((a,b) => a-b); return sorted[Math.floor(sorted.length / 2)]; };

function isNationalOpen(row, notices = new Map()) {
  const title = String(row.title || '');
  const notice = String(notices.get(String(row.event_id)) || '').replace(/<[^>]*>/g, ' ');
  if (/(仅限|限于).{0,20}(本省|本市|本县|本区|户籍)|不面向全国/.test(notice)) return false;
  return /公开赛/.test(title) && (/全国|国际/.test(title)
    || /面向全国|全国各地.{0,25}(均可|皆可|均能|报名)|全国.{0,12}围棋爱好者/.test(notice));
}

function compareStrength(row, references) {
  const value = rowBase(row)?.base;
  const date = Date.parse(String(row.min_time || '').slice(0,10));
  if (!Number.isFinite(value) || !Number.isFinite(date)) return 'unknown';
  const comparable = references.filter(other => Math.abs(Date.parse(String(other.min_time || '').slice(0,10)) - date)
    <= COMPARISON_DAYS * 86400000).map(other => rowBase(other)?.base).filter(Number.isFinite);
  if (!comparable.length) return 'unknown';
  const gap = Math.abs(value - median(comparable));
  return gap >= CONFLICT_GAP ? 'conflict' : gap <= SIMILAR_GAP ? 'similar' : 'unknown';
}

function sameGroupCollision(rows, incoming) {
  return rows.some(a => incoming.some(b => String(a.event_id) === String(b.event_id)
    && String(a.group_id) === String(b.group_id) && String(a.participant_id) !== String(b.participant_id)));
}

function partitionPlayerRows(input, notices = new Map()) {
  const rows = [...new Map(input.map(row => [recordKey(row), row])).values()]
    .sort((a,b) => String(a.min_time).localeCompare(String(b.min_time)) || recordKey(a).localeCompare(recordKey(b)));
  const regions = [];
  for (const row of rows) {
    const region = row.provincename || '地区未注明';
    let profile = regions.find(p => p.region === region && !sameGroupCollision(p.rows, [row]));
    if (!profile) { profile = { region, rows: [] }; regions.push(profile); }
    profile.rows.push(row);
  }
  regions.sort((a,b) => b.rows.filter(r => !isNationalOpen(r, notices)).length - a.rows.filter(r => !isNationalOpen(r, notices)).length
    || b.rows.length - a.rows.length || a.region.localeCompare(b.region));
  const primary = regions[0];
  if (!primary) return [];
  const profiles = [primary];
  // Travel is not a conflicting identity. Compare contemporaneous performances,
  // and require affirmative nationwide-entry evidence for every away event.
  const homeRows = [...primary.rows];
  for (const candidate of regions.slice(1)) {
    const comparisons = candidate.rows.map(row => compareStrength(row, homeRows));
    if (candidate.rows.every(row => isNationalOpen(row, notices))
      && comparisons.every(value => value === 'similar') && !sameGroupCollision(primary.rows, candidate.rows)) {
      primary.rows.push(...candidate.rows);
    } else {
      candidate.reason = comparisons.includes('conflict') ? '不同地区的同期棋力表现存在明显差异'
        : '尚不能确认与主要参赛地记录属于同一位棋手';
      profiles.push(candidate);
    }
  }
  return profiles.map(profile => {
    const sorted = [...profile.rows].sort((a,b) => String(a.min_time).localeCompare(String(b.min_time)) || recordKey(a).localeCompare(recordKey(b)));
    return { id: recordKey(sorted[0]), rows: sorted,
      label: profile.region, reason: profile.reason || '',
      provinces: [...new Set(sorted.map(r => r.provincename).filter(Boolean))],
      orgs: [...new Set(sorted.map(r => r.org).filter(s => s && !/^(个人|--|无)$/.test(s)))].slice(0,5),
      event_count: new Set(sorted.map(r => r.event_id)).size,
      date_from: String(sorted[0].min_time || '').slice(0,10), date_to: String(sorted.at(-1).min_time || '').slice(0,10),
    };
  });
}

function selectIdentity(profiles, key) {
  if (key) {
    const profile = profiles.find(p => p.id === key || p.rows.some(row => recordKey(row) === key));
    if (!profile) throw Object.assign(new Error('这条参赛轨迹已变化，请重新选择棋手'), { code: 'INVALID_IDENTITY', status: 409 });
    return profile;
  }
  return profiles.length === 1 ? profiles[0] : null;
}

function identityChoices(profiles) {
  return profiles.map(({ rows, ...profile }) => profile);
}

module.exports = { partitionPlayerRows, selectIdentity, identityChoices, recordKey, isNationalOpen, compareStrength };
