const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const {
  initPromise,
  replaceLivePairingOverrides,
} = require('../db');

const EVENTPART_API = 'https://api.yunbisai.com/request/Group/Eventpart';
const LIVE_BYE_OPPONENT_ID = '__live_bye__';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseJsonp(text) {
  const value = text.trim()
    .replace(/^[^(]+\(/, '')
    .replace(/\);\s*$/, '')
    .replace(/\)\s*$/, '');
  return JSON.parse(value);
}

async function fetchParticipants(groupId) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const params = new URLSearchParams({ groupid: String(groupId), callback: 'cb' });
    const response = await fetch(`${EVENTPART_API}?${params}`, {
      headers: {
        Referer: 'https://www.yunbisai.com/',
        'User-Agent': 'Mozilla/5.0',
      },
      timeout: 15000,
    });
    if (!response.ok) throw new Error(`participant API HTTP ${response.status}`);
    const data = parseJsonp(await response.text());
    if (data.datArr === 'wait') {
      await delay(800);
      continue;
    }
    if (data.error !== 0) throw new Error(data.msg || 'participant API error');
    return (data.datArr?.rows || []).map(row => ({
      id: String(row.participantid || row.id || row.pid || ''),
      name: row.participantname || row.name || '',
      org: row.teamname || row.othername || '',
      short_no: String(row.short || ''),
    })).filter(player => player.id && player.name && player.short_no);
  }
  throw new Error(`participants wait timeout for group ${groupId}`);
}

function buildOverrideRows(group, bout, participants, source) {
  if (participants.length !== group.expected_participants) {
    throw new Error(
      `${group.group_name}: expected ${group.expected_participants} participants, received ${participants.length}`
    );
  }

  const byShortNo = new Map();
  for (const player of participants) {
    if (byShortNo.has(player.short_no)) {
      throw new Error(`${group.group_name}: duplicate participant number ${player.short_no}`);
    }
    byShortNo.set(player.short_no, player);
  }

  const seen = new Set();
  const rows = group.pairings.map((pairing, index) => {
    if (!Array.isArray(pairing) || pairing.length !== 2) {
      throw new Error(`${group.group_name}: invalid pairing at seat ${index + 1}`);
    }

    const [p1ShortRaw, p2ShortRaw] = pairing;
    const p1Short = String(p1ShortRaw || '');
    const p2Short = p2ShortRaw === null ? '' : String(p2ShortRaw || '');
    const p1 = byShortNo.get(p1Short);
    const p2 = p2Short ? byShortNo.get(p2Short) : null;
    if (!p1) throw new Error(`${group.group_name}: unknown black number ${p1Short}`);
    if (p2Short && !p2) throw new Error(`${group.group_name}: unknown white number ${p2Short}`);

    for (const shortNo of [p1Short, p2Short].filter(Boolean)) {
      if (seen.has(shortNo)) {
        throw new Error(`${group.group_name}: participant number ${shortNo} appears more than once`);
      }
      seen.add(shortNo);
    }

    return {
      seat: index + 1,
      p1_id: p1.id,
      p2_id: p2?.id || LIVE_BYE_OPPONENT_ID,
      p1_name: p1.name,
      p2_name: p2?.name || '轮空',
      p1_org: p1.org,
      p2_org: p2?.org || '',
      p1_short_no: p1.short_no,
      p2_short_no: p2?.short_no || '',
      source,
    };
  });

  if (seen.size !== group.expected_active_players) {
    throw new Error(
      `${group.group_name}: expected ${group.expected_active_players} active players, received ${seen.size}`
    );
  }
  return rows;
}

async function main() {
  const inputArg = process.argv.find(arg => arg.endsWith('.json'));
  if (!inputArg) {
    throw new Error('usage: node scripts/import-live-pairings.js <pairings.json> [--dry-run]');
  }

  const inputPath = path.resolve(inputArg);
  const config = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const dryRun = process.argv.includes('--dry-run');
  const bout = parseInt(config.bout) || 0;
  if (!bout || !Array.isArray(config.groups) || !config.groups.length) {
    throw new Error('pairing file is missing bout or groups');
  }

  await initPromise;
  for (const group of config.groups) {
    const participants = await fetchParticipants(group.group_id);
    const source = config.source || path.basename(inputPath);
    const rows = buildOverrideRows(group, bout, participants, source);
    if (!dryRun) {
      await replaceLivePairingOverrides({
        group_id: group.group_id,
        bout,
        rows,
        source,
      });
    }

    const first = rows[0];
    const last = rows[rows.length - 1];
    console.log(
      `${group.group_name} (${group.group_id}): ${rows.length} seats, ${group.expected_active_players} players; `
      + `first ${first.p1_name}-${first.p2_name}; last ${last.p1_name}-${last.p2_name}; `
      + (dryRun ? 'validated only' : 'saved')
    );
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
