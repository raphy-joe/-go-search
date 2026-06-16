'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const form            = document.getElementById('searchForm');
const nameInput       = document.getElementById('name');
const provinceSelect  = document.getElementById('province');
const searchBtn       = document.getElementById('searchBtn');
const stopBtn         = document.getElementById('stopBtn');
const progressSection = document.getElementById('progressSection');
const progressText    = document.getElementById('progressText');
const progressCount   = document.getElementById('progressCount');
const progressBar     = document.getElementById('progressBar');
const resultsSection  = document.getElementById('resultsSection');
const resultsTitle    = document.getElementById('resultsTitle');
const resultCount     = document.getElementById('resultCount');
const resultsList     = document.getElementById('resultsList');
let evtSource = null;
let hits = 0;
let currentProvince = '';
let hitDates  = [];   // parallel to resultsList children, YYYY-MM-DD strings, descending
let allHits   = [];   // all hit messages, used for strength estimation

// Cross-search cache: player name → { L, confidence }
// Populated after each search; used as opponent strength reference in future searches.
const playerStrengthCache = new Map();

// ── Fetch all match data in parallel ─────────────────────────────────────────
// Returns Map<hitIndex, matches[]>
async function fetchAllMatchData(hits) {
  const matchMap = new Map();
  await Promise.all(hits.map(async (h, i) => {
    const win   = parseInt(h.player.win)  || 0;
    const lose  = parseInt(h.player.lose) || 0;
    const draw  = parseInt(h.player.draw) || 0;
    const rounds = win + lose + draw;
    if (!rounds || !h.player.groupid || !h.player.participantid) return;
    try {
      const params = new URLSearchParams({
        group_id:  h.player.groupid,
        rounds,
        player_id: h.player.participantid,
      });
      const resp = await fetch(`/api/matches?${params}`);
      const data = await resp.json();
      if (data.matches?.length) matchMap.set(i, data.matches);
    } catch (_) {}
  }));
  return matchMap;
}

// ── Compute rolling recent two years range ───────────────────────────────────
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getRecentTwoYearRange() {
  const now = new Date();
  const from = new Date(now);
  from.setFullYear(from.getFullYear() - 2);
  return {
    dateFrom: formatDate(from),
    dateTo: formatDate(now),
    label: `${formatDate(from)}–${formatDate(now)}`,
  };
}

// ── Form submit ───────────────────────────────────────────────────────────────
form.addEventListener('submit', e => { e.preventDefault(); startSearch(); });
stopBtn.addEventListener('click', () => {
  if (evtSource) { evtSource.close(); evtSource = null; }
  progressText.textContent = '已停止';
  stopBtn.style.display = 'none';
  searchBtn.disabled = false;
});

// ── Main search ───────────────────────────────────────────────────────────────
function startSearch() {
  const name     = nameInput.value.trim();
  const province = provinceSelect.value;

  if (!name)     { nameInput.focus();     return; }
  if (!province) { provinceSelect.focus(); return; }

  currentProvince = (province === '__ALL__') ? '' : province;

  if (evtSource) { evtSource.close(); evtSource = null; }

  const { dateFrom, dateTo, label: dateLabel } = getRecentTwoYearRange();

  // Reset UI
  hits = 0;
  hitDates  = [];
  allHits   = [];
  resultsList.innerHTML = '';
  const oldCard = document.getElementById('strengthCard');
  if (oldCard) oldCard.remove();
  resultCount.textContent = '0';
  progressBar.style.width = '0%';
  progressText.textContent = '正在连接...';
  progressCount.textContent = '';
  progressSection.style.display = 'block';
  resultsSection.style.display  = 'block';
  const provinceLabel = province === '__ALL__' ? '全国' : province;
  resultsTitle.textContent = `${esc(name)} · ${esc(provinceLabel)} · ${dateLabel}`;
  searchBtn.disabled = true;
  stopBtn.style.display = 'inline-block';

  const params = new URLSearchParams({
    name, province,
    eventType: '2',
    dateFrom, dateTo,
  });
  evtSource = new EventSource(`/api/search?${params}`);

  evtSource.onmessage = e => {
    const msg = JSON.parse(e.data);

    switch (msg.type) {
      case 'status':
        progressText.textContent = msg.msg;
        break;

      case 'pages': {
        const pct = msg.totalPages ? Math.round(msg.pagesLoaded / msg.totalPages * 100) : 0;
        progressBar.style.width = pct + '%';
        progressText.textContent = '正在加载赛事列表';
        progressCount.textContent = `${msg.pagesLoaded} / ${msg.totalPages} 页`;
        break;
      }

      case 'progress': {
        if (!msg.queued) break;
        const pct = Math.round(msg.searched / msg.queued * 100);
        progressBar.style.width = pct + '%';
        const pageInfo = (msg.totalPages > 1 && msg.pagesLoaded < msg.totalPages)
          ? `  （列表加载中 ${msg.pagesLoaded}/${msg.totalPages} 页）`
          : '';
        const failedInfo = msg.failed ? `，${msg.failed} 场失败` : '';
        progressText.textContent = `正在搜索${pageInfo}`;
        progressCount.textContent = `${msg.searched} / ${msg.queued} 场${failedInfo}`;
        break;
      }

      case 'hit': {
        hits++;
        allHits.push(msg);
        resultCount.textContent = hits;
        const card = buildCard(msg);
        const date = msg.event.date || '';
        // Insert in descending date order
        let idx = hitDates.findIndex(d => date > d);
        if (idx === -1) {
          hitDates.push(date);
          resultsList.appendChild(card);
        } else {
          hitDates.splice(idx, 0, date);
          resultsList.insertBefore(card, resultsList.children[idx]);
        }
        break;
      }

      case 'done':
        progressBar.style.width = '100%';
        progressText.textContent = '搜索完成';
        progressCount.textContent = `共搜索 ${msg.searched} 场赛事，找到 ${hits} 条记录${msg.failed ? `，${msg.failed} 场请求失败` : ''}`;
        if (hits === 0) showEmpty(name, province);
        else showStrengthEstimate(allHits);
        evtSource.close(); evtSource = null;
        searchBtn.disabled = false;
        stopBtn.style.display = 'none';
        break;

      case 'error':
        progressText.textContent = '出错：' + msg.msg;
        evtSource.close(); evtSource = null;
        searchBtn.disabled = false;
        stopBtn.style.display = 'none';
        break;
    }
  };

  evtSource.onerror = () => {
    progressText.textContent = '连接中断';
    evtSource.close(); evtSource = null;
    searchBtn.disabled = false;
    stopBtn.style.display = 'none';
  };
}

// ── Build result card ─────────────────────────────────────────────────────────
function buildCard(msg) {
  const { event, player } = msg;
  const card = document.createElement('div');
  card.className = 'result-card';
  const winNum  = parseInt(player.win)  || 0;
  const loseNum = parseInt(player.lose) || 0;
  const drawNum = parseInt(player.draw) || 0;
  const totalRounds = winNum + loseNum + drawNum;

  card.innerHTML = `
    <div class="card-main">
      <div class="card-title">${esc(event.title)}</div>
      <div class="card-meta">
        <span>📅 ${esc(event.date || '—')}</span>
        <span>📍 ${esc(event.province || '')} ${esc(event.city || '')}</span>
        <span>🏢 ${esc(event.organizer || '')}</span>
      </div>
      <div class="card-scores">
        ${player.group ? `<span class="score-tag group">${esc(player.group)}</span>` : ''}
        ${player.org   ? `<span class="score-tag org">${esc(player.org)}</span>`     : ''}
        <span class="score-tag win">胜 ${winNum}</span>
        <span class="score-tag lose">负 ${loseNum}</span>
        ${drawNum > 0 ? `<span class="score-tag draw">和 ${drawNum}</span>` : ''}
        <span class="score-tag score">积分 ${esc(player.score)}</span>
      </div>
    </div>
    <div class="card-links">
      <a href="${esc(event.detail_url)}" target="_blank">赛事详情 →</a>
      <a href="${esc(player.detail_url)}" target="_blank">个人对局 →</a>
      ${totalRounds > 0 ? `<button class="btn-expand" type="button">展开对局 ▾</button>` : ''}
    </div>
    ${totalRounds > 0 ? `<div class="matches-panel" style="display:none"></div>` : ''}`;

  if (totalRounds > 0) {
    const btn   = card.querySelector('.btn-expand');
    const panel = card.querySelector('.matches-panel');
    let loaded  = false;

    btn.addEventListener('click', async () => {
      const open = panel.style.display !== 'none';
      if (open) {
        panel.style.display = 'none';
        btn.textContent = '展开对局 ▾';
        return;
      }
      panel.style.display = 'block';
      btn.textContent = '收起对局 ▴';
      if (loaded) return;
      loaded = true;
      panel.innerHTML = '<div class="matches-loading">加载中…</div>';
      try {
        const params = new URLSearchParams({
          group_id:  player.groupid,
          rounds:    totalRounds,
          player_id: player.participantid,
        });
        const resp = await fetch(`/api/matches?${params}`);
        const data = await resp.json();
        if (!data.matches || data.matches.length === 0) {
          panel.innerHTML = `<div class="matches-empty">暂无对局数据，<a href="${esc(event.detail_url)}" target="_blank">查看对阵表 →</a></div>`;
          return;
        }
        const anyData = data.matches.some(m => m.opponent !== null);
        if (!anyData) {
          panel.innerHTML = `<div class="matches-empty">暂无对局数据，<a href="${esc(event.detail_url)}" target="_blank">查看对阵表 →</a></div>`;
          return;
        }
        const rows = data.matches.map(m => {
          if (m.opponent === null) return `<tr><td class="bout-num">第${m.bout}轮</td><td colspan="3" class="no-data">—</td></tr>`;
          const resultLabel = m.result === 'win' ? '<span class="m-win">胜</span>' : m.result === 'lose' ? '<span class="m-lose">负</span>' : '<span class="m-draw">和</span>';
          const scoreStr = (m.score > 0 || m.opp_score > 0) ? `<span class="m-score">${m.score}:${m.opp_score}</span>` : '';
          const oppLink = m.opponent
            ? `<a href="/?name=${encodeURIComponent(m.opponent)}&province=${encodeURIComponent(currentProvince)}" target="_blank" class="opp-link">${esc(m.opponent)}</a>`
            : '';
          return `<tr>
            <td class="bout-num">第${m.bout}轮</td>
            <td>${resultLabel} ${scoreStr}</td>
            <td class="opponent-name">${oppLink}</td>
            <td class="opponent-org">${esc(m.opponent_org || '')}</td>
          </tr>`;
        }).join('');
        panel.innerHTML = `<table class="matches-table"><tbody>${rows}</tbody></table>`;
      } catch (e) {
        panel.innerHTML = `<div class="matches-empty">加载失败，<a href="${esc(event.detail_url)}" target="_blank">查看对阵表 →</a></div>`;
      }
    });
  }

  return card;
}

function showEmpty(name, province) {
  resultsList.innerHTML = `
    <div class="state-msg">
      <div class="icon">🔍</div>
      <div>未找到「${esc(name)}」在${esc(province)}近两年的参赛记录</div>
      <div style="margin-top:6px;font-size:.82rem">请确认姓名是否精确，或尝试换一个省份</div>
    </div>`;
}

// ── Strength estimation ────────────────────────────────────────────────────────
// Level scale L: 25级=1, 24级=2, …, 1级=25, 1段=26, 2段=27, …, 8段=33

// ── Path A: skill-level groups (1级组, 3段组, 定段组, 公开组…) ────────────────
function parseGroupL(groupName) {
  if (!groupName) return null;
  const g = groupName.trim();
  if (/启蒙|吃子|入门|幼儿|棋趣/.test(g)) return null;
  if (/定段/.test(g)) return 25.3;

  // Range group: "1-2级" "3~5级" "1至3级"
  const rangeM = g.match(/(\d+)\s*[~\-－—至到]\s*(\d+)\s*级/);
  if (rangeM) {
    const a = 26 - parseInt(rangeM[1]);
    const b = 26 - parseInt(rangeM[2]);
    return (a + b) / 2;
  }

  // Single level: "X级"
  const lvM = g.match(/(\d+)\s*级/);
  if (lvM) {
    const lv = parseInt(lvM[1]);
    if (lv >= 1 && lv <= 25) return 26 - lv;
  }

  // Dan group: "X段"
  const danM = g.match(/(\d+)\s*段/);
  if (danM) {
    const d = parseInt(danM[1]);
    if (d >= 1 && d <= 8) return 25 + d;
  }

  if (/低段/.test(g)) return 27.5;
  if (/高段/.test(g)) return 30;
  if (isOpenGroup(g)) return 30.2;   // 公开组略强于普通5段组
  return null;
}

function isOpenGroup(groupName) {
  return /公开/.test(groupName || '');
}

// ── Path B: age/grade groups (年级组, U10组, 8岁组…) ─────────────────────────
// Returns L base value derived from event tier × grade/age, or null if not recognized.
function parseAgeGradeL(groupName, eventTitle, organizer) {
  if (!groupName) return null;
  const g = groupName.trim();

  // Must look like an age/grade group
  const isAge = /[一二三四五六]年级|低年级|高年级|小学生?组|初中|中学生?组|U\d+|\d+\s*岁|[甲乙丙丁]组/.test(g);
  if (!isAge) return null;
  if (/启蒙|吃子|入门/.test(g)) return null;

  // Event tier → base level
  const text = (eventTitle || '') + ' ' + (organizer || '');
  let tierBase;
  if (/全国|国际/.test(text))           tierBase = 31.0;  // 5段以上
  else if (/省/.test(text))             tierBase = 30.0;  // 5段
  else if (/市/.test(text))             tierBase = 30.0;  // 5段
  else if (/区|县/.test(text))          tierBase = 28.0;  // 3段
  else if (/学校|班级|校内/.test(text)) tierBase = 24.5;  // 1-2级
  else                                  tierBase = 28.0;  // default: 区县

  // Grade/age adjustment (higher grade/age → stronger baseline)
  let adj = 0;
  const gradeMap = { '一': 0, '二': 0.3, '三': 0.6, '四': 0.9, '五': 1.2, '六': 1.5 };
  for (const [ch, a] of Object.entries(gradeMap)) {
    if (g.includes(ch + '年级')) { adj = a; break; }
  }
  if (/低年级/.test(g)) adj = 0.2;
  if (/高年级/.test(g)) adj = 1.0;
  if (/初中|中学生/.test(g)) adj = 1.5;  // 初中 ≈ 六年级以上

  // 甲乙丙丁组（按年级划分，甲=高年级/初中，丁=低年级）
  // 只在没有更精确的年级信息时使用（如"男甲组"、"女子乙组"等均匹配）
  if (/甲组/.test(g) && adj === 0) adj = 1.0;   // 高年级/初中
  if (/乙组/.test(g) && adj === 0) adj = 0.6;   // 中年级
  if (/丙组/.test(g) && adj === 0) adj = 0.2;   // 低年级
  if (/丁组/.test(g) && adj === 0) adj = 0;     // 最低年级

  // U-age or 岁
  const uM = g.match(/U(\d+)/i);
  const aM = g.match(/(\d+)\s*岁/);
  const age = uM ? parseInt(uM[1]) : aM ? parseInt(aM[1]) : null;
  if (age !== null) {
    adj = age <= 7 ? 0 : age <= 9 ? 0.3 : age <= 11 ? 0.7 : age <= 13 ? 1.1 : 1.5;
  }

  return tierBase + adj;
}

function winRateAdj(win, lose, draw) {
  const total = win + lose + draw;
  if (total === 0) return 0;
  return 2 * ((win + 0.5 * draw) / total - 0.5);  // [-1, +1]
}

function timeWeight(dateStr) {
  if (!dateStr) return 0;
  const days = (Date.now() - new Date(dateStr).getTime()) / 86400000;
  if (days <= 90)  return 1.00;
  if (days <= 180) return 0.40;
  return 0;
}

function eventLevelWeight(title, organizer) {
  const text = title + ' ' + (organizer || '');
  if (/全国|国际|中国围棋协会/.test(text))             return 1.60;
  if (/省级|省赛|省锦标|全省|省围棋/.test(text))       return 1.40;
  if (/市级|市锦标|全市|市围棋/.test(text))             return 1.20;
  return 1.00;
}

function lToLabel(L) {
  L = Math.max(0.5, Math.min(33.99, L));
  const base = Math.floor(L);
  const frac = L - base;
  const tier = frac < 0.34 ? '弱' : frac < 0.67 ? '普通' : '强';
  if (base >= 1 && base <= 25) return `${tier}${26 - base}级`;
  if (base >= 26 && base <= 33) return `${tier}${base - 25}段`;
  return null;
}

function estimateStrength(hits, matchMap = null) {
  // ── Pass 1: collect all event data ───────────────────────────────────────
  const collected = [];

  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const L_skill = parseGroupL(h.player.group);
    const L_age   = L_skill === null
      ? parseAgeGradeL(h.player.group, h.event.title, h.event.organizer)
      : null;
    const isAgeGroup = L_skill === null && L_age !== null;
    const L_group = L_skill ?? L_age;
    if (L_group === null) continue;
    const isOpen = !isAgeGroup && isOpenGroup(h.player.group);

    const win   = parseInt(h.player.win)  || 0;
    const lose  = parseInt(h.player.lose) || 0;
    const draw  = parseInt(h.player.draw) || 0;
    const totalRounds = win + lose + draw;
    if (totalRounds === 0) continue;

    const tw = timeWeight(h.event.date);
    if (tw === 0) continue;

    // ── Match data analysis ────────────────────────────────────────────────
    const matches = matchMap?.get(i) ?? null;
    let effectiveRounds = totalRounds;
    let oppAdj = 0;
    let hasMatchData = false;
    let knownOppCount = 0;

    if (matches?.length) {
      const realMatches = matches.filter(m => m.opponent !== null);
      effectiveRounds = realMatches.length || totalRounds;
      hasMatchData = true;

      const oppLs = [];
      for (const m of realMatches) {
        if (!m.opponent) continue;
        const cached = playerStrengthCache.get(m.opponent);
        if (cached && (cached.confidence === '高' || cached.confidence === '中')) {
          oppLs.push(cached.L);
          knownOppCount++;
        }
      }
      if (oppLs.length > 0) {
        const oppLAvg = oppLs.reduce((s, v) => s + v, 0) / oppLs.length;
        oppAdj = 0.4 * (oppLAvg - L_group);
        oppAdj = Math.max(-1.5, Math.min(1.5, oppAdj));
      }
    }

    let wrAdj = winRateAdj(win, lose, draw);
    if (isOpen && wrAdj < 0) wrAdj *= 0.75;
    const T_raw = L_group + (isAgeGroup ? 0 : 0.5) + wrAdj + oppAdj;
    const ew = eventLevelWeight(h.event.title, h.event.organizer || '');

    let dq;
    if (isAgeGroup)              dq = 0.60;
    else if (knownOppCount >= 2) dq = 1.00;
    else if (hasMatchData)       dq = 0.85;
    else                         dq = 0.75;

    const w = effectiveRounds * tw * ew * dq;
    collected.push({ h, L_group, wrAdj, oppAdj, T_raw, w, rounds: effectiveRounds, tw, ew, isAgeGroup, isOpen, hasMatchData, knownOppCount });
  }

  if (collected.length === 0) return null;

  // ── Pass 2: compute skill-group baseline L ───────────────────────────────
  // Age-group events can never be stronger evidence than skill-group events.
  // A player who dominates a low-tier age group is AT LEAST as strong as
  // the skill-group estimate — so floor age-group T at the skill-group L.
  const skillOnly = collected.filter(e => !e.isAgeGroup);
  let L_base = null;
  if (skillOnly.length > 0) {
    const sw  = skillOnly.reduce((s, e) => s + e.w, 0);
    const sws = skillOnly.reduce((s, e) => s + e.T_raw * e.w, 0);
    if (sw > 0) L_base = sws / sw;
  }

  // ── Pass 3: apply floor and compute final weighted average ───────────────
  const usedEvents = [];
  let weightedSum = 0;
  let totalWeight = 0;

  for (const e of collected) {
    // For age groups with ≥50% win rate, T must be at least max(L_group, L_base).
    // This ensures a player who dominates a lower-tier age group is never
    // dragged below their skill-group estimate.
    let T = e.T_raw;
    if (e.isAgeGroup && e.wrAdj >= 0) {
      const floor = L_base !== null ? Math.max(e.L_group, L_base) : e.L_group;
      T = Math.max(T, floor);
    }
    if (e.isOpen) T = Math.max(T, 30.0);

    weightedSum += T * e.w;
    totalWeight += e.w;
    usedEvents.push({ ...e, T });
  }

  if (totalWeight === 0) return null;

  const L = weightedSum / totalWeight;

  const recent3 = usedEvents.filter(e => e.tw === 1.00);
  const recentRounds = recent3.reduce((s, e) => s + e.rounds, 0);
  const allAge = usedEvents.every(e => e.isAgeGroup);
  const conf = (!allAge && recentRounds >= 15 && recent3.length >= 2) ? '高'
             : (recentRounds >= 8  || usedEvents.length >= 1)         ? '中'
             : '低';

  return { L, label: lToLabel(L), confidence: conf, events: usedEvents };
}

async function showStrengthEstimate(hits) {
  const old = document.getElementById('strengthCard');
  if (old) old.remove();

  const allGroups = [...new Set(hits.map(h => h.player.group).filter(Boolean))];
  const hasRecent = hits.some(h => timeWeight(h.event.date) > 0);

  // Phase 1: show basic estimate immediately (synchronous, no match data)
  const basicResult = estimateStrength(hits, null);
  renderStrengthCard(basicResult, hits, allGroups, hasRecent, '（正在加载对局数据…）');

  // Phase 2: fetch all match data in parallel, re-render enhanced estimate
  const matchMap = await fetchAllMatchData(hits);
  if (matchMap.size === 0) {
    // No match data could be fetched — re-render without loading note
    renderStrengthCard(basicResult, hits, allGroups, hasRecent, null);
    if (basicResult) {
      playerStrengthCache.set(
        nameInput.value.trim(),
        { L: basicResult.L, confidence: basicResult.confidence }
      );
    }
    return;
  }

  const enhancedResult = estimateStrength(hits, matchMap);
  renderStrengthCard(enhancedResult, hits, allGroups, hasRecent, null);
  if (enhancedResult) {
    playerStrengthCache.set(
      nameInput.value.trim(),
      { L: enhancedResult.L, confidence: enhancedResult.confidence }
    );
  }
}

function renderStrengthCard(result, hits, allGroups, hasRecent, loadingMsg) {
  const old = document.getElementById('strengthCard');
  if (old) old.remove();

  if (!result) {
    if (allGroups.length === 0) return;
    const reason = hasRecent
      ? '组别信息无法映射到段级位，暂不估算'
      : '近180天内缺少可用棋力样本，暂不估算';
    const note = hasRecent
      ? `识别到的组别：${allGroups.map(g => `<b>${esc(g)}</b>`).join('、')}。如需支持这些组别，请反馈给开发者。`
      : `识别到的组别：${allGroups.map(g => `<b>${esc(g)}</b>`).join('、')}。当前棋力评测只采纳近180天内的比赛。`;
    const card = document.createElement('div');
    card.id = 'strengthCard';
    card.className = 'strength-card strength-card--unknown';
    card.innerHTML = `
      <div class="strength-header">
        <div class="strength-label strength-label--unknown">棋力待估</div>
        <div class="strength-meta">${reason}</div>
      </div>
      <div class="strength-note">${note}</div>`;
    resultsList.before(card);
    return;
  }

  const { L, label, confidence, events } = result;
  const confColor = confidence === '高' ? '#2e7d32' : confidence === '中' ? '#e65100' : '#c62828';

  // Build basis list (up to 4 events, sorted by time weight desc)
  const sorted = [...events].sort((a, b) => b.tw - a.tw);
  const basisItems = sorted.slice(0, 4).map(({ h, L_group, wrAdj, oppAdj, T, rounds, isAgeGroup, hasMatchData, knownOppCount }) => {
    const win  = parseInt(h.player.win)  || 0;
    const lose = parseInt(h.player.lose) || 0;
    const draw = parseInt(h.player.draw) || 0;
    const groupLabel = h.player.group || '?';
    const adjStr = (wrAdj >= 0 ? '+' : '') + wrAdj.toFixed(2);
    const title = h.event.title.length > 22 ? h.event.title.slice(0, 22) + '…' : h.event.title;
    const baseNote = isAgeGroup
      ? `年龄/年级组估算基准${L_group.toFixed(1)}`
      : `基准${L_group}+0.5`;
    const oppAdjStr = oppAdj && Math.abs(oppAdj) >= 0.01
      ? `，对手调整${(oppAdj >= 0 ? '+' : '') + oppAdj.toFixed(2)}`
      : '';
    const matchTag = knownOppCount >= 2
      ? ` <span class="tag-opp">对手数据</span>`
      : hasMatchData
      ? ` <span class="tag-match">对局已获取</span>`
      : '';
    return `<li><b>${esc(title)}</b> · ${esc(groupLabel)} · ${win}胜${lose}负${draw > 0 ? draw + '和' : ''}（${rounds}轮）→ <b>T=${T.toFixed(2)}</b>（${baseNote}，胜率调整${adjStr}${oppAdjStr}）${isAgeGroup ? ' <span class="tag-age">年龄组</span>' : ''}${matchTag}</li>`;
  }).join('');

  const skipped = hits.length - events.length;
  const ageCount = events.filter(e => e.isAgeGroup).length;
  const oppCount = events.filter(e => e.knownOppCount >= 2).length;

  const skipNote = skipped > 0
    ? `<div class="strength-note">另有 ${skipped} 场赛事因组别无法识别未纳入计算。</div>`
    : '';
  const ageNote = ageCount > 0
    ? `<div class="strength-note">含 ${ageCount} 场年龄/年级组比赛，以赛事级别+年级估算基准，置信度偏低。</div>`
    : '';
  const oppNote = oppCount > 0
    ? `<div class="strength-note strength-note--good">已通过对手强度数据（${oppCount} 场赛事）增强估算精度。</div>`
    : '';
  const loadingNote = loadingMsg
    ? `<div class="strength-note strength-note--loading">${loadingMsg}</div>`
    : '';

  const card = document.createElement('div');
  card.id = 'strengthCard';
  card.className = 'strength-card';
  card.innerHTML = `
    <div class="strength-header">
      <div class="strength-label">${esc(label)}</div>
      <div class="strength-meta">
        L值 <b>${L.toFixed(2)}</b>
        &nbsp;·&nbsp; 置信度 <span style="color:${confColor};font-weight:700">${confidence}</span>
        &nbsp;·&nbsp; 依据 ${events.length} 场赛事 / ${events.reduce((s,e)=>s+e.rounds,0)} 轮
      </div>
    </div>
    <ul class="strength-basis">${basisItems}</ul>
    ${ageNote}${oppNote}${skipNote}${loadingNote}`;

  resultsList.before(card);
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Auto-search from URL params (e.g. /?name=X&province=Y) ───────────────────
(function initFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const name     = params.get('name');
  const province = params.get('province');
  if (!name || !province) return;
  nameInput.value = name;
  provinceSelect.value = province;
  if (provinceSelect.value === province) startSearch();
})();
