'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const form            = document.getElementById('searchForm');
const nameInput       = document.getElementById('name');
const provinceSelect  = document.getElementById('province');
const searchBtn       = document.getElementById('searchBtn');
const stopBtn         = document.getElementById('stopBtn');
const h2hForm         = document.getElementById('h2hForm');
const h2hPlayerAInput = document.getElementById('h2hPlayerA');
const h2hPlayerBInput = document.getElementById('h2hPlayerB');
const h2hBtn          = document.getElementById('h2hBtn');
const h2hClearBtn     = document.getElementById('h2hClearBtn');
const h2hResult       = document.getElementById('h2hResult');
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
let searchSeq = 0;
let strengthRefreshTimer = null;
let strengthEvalVersion = 0;
const STRENGTH_REFRESH_DELAY_MS = 900;

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

function openHeadToHeadPage(playerA = '', playerB = '') {
  const province = currentProvince || provinceSelect?.value || '__ALL__';
  const params = new URLSearchParams({ playerA, playerB, province });
  window.open(`/head-to-head.html?${params}`, '_blank');
}

async function startHeadToHeadSearch(playerA = '', playerB = '', options = {}) {
  if (!h2hForm) {
    openHeadToHeadPage(playerA, playerB);
    return;
  }
  if (!playerA) playerA = h2hPlayerAInput.value.trim();
  if (!playerB) playerB = h2hPlayerBInput.value.trim();
  playerA = playerA.trim();
  playerB = playerB.trim();
  const shouldFocusPanel = Boolean(options.focusPanel);
  if (shouldFocusPanel) focusHeadToHeadPanel();
  if (!playerA) { h2hPlayerAInput.focus(); return; }
  if (!playerB) { h2hPlayerBInput.focus(); return; }
  if (playerA === playerB) {
    showHeadToHeadMessage('请输入两位不同棋手');
    return;
  }

  h2hPlayerAInput.value = playerA;
  h2hPlayerBInput.value = playerB;
  const province = provinceSelect.value || '__ALL__';
  const { dateFrom, dateTo } = getRecentTwoYearRange();

  h2hBtn.disabled = true;
  showHeadToHeadLoading(playerA, playerB);

  try {
    const params = new URLSearchParams({
      playerA,
      playerB,
      province,
      dateFrom,
      dateTo,
    });
    const resp = await fetch(`/api/head-to-head?${params}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '查询失败');
    renderHeadToHeadResult(data);
  } catch (err) {
    showHeadToHeadMessage(`查询失败：${esc(err.message)}`);
  } finally {
    h2hBtn.disabled = false;
  }
}

function clearHeadToHeadResult({ clearPlayers = false } = {}) {
  if (!h2hForm || !h2hResult) return;
  if (clearPlayers) {
    h2hPlayerAInput.value = '';
    h2hPlayerBInput.value = '';
  }
  h2hResult.style.display = 'none';
  h2hResult.innerHTML = '';
  h2hForm.classList.remove('h2h-card--flash');
}

function focusHeadToHeadPanel() {
  if (!h2hForm) return;
  h2hForm.classList.remove('h2h-card--flash');
  void h2hForm.offsetWidth;
  h2hForm.classList.add('h2h-card--flash');
  h2hForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showHeadToHeadLoading(playerA, playerB) {
  if (!h2hResult) return;
  h2hResult.style.display = 'block';
  h2hResult.innerHTML = `
    <div class="h2h-context">正在查询「${esc(playerA)}」与「${esc(playerB)}」的交手记录</div>
    <div class="matches-loading">查询中…</div>`;
}

function showHeadToHeadMessage(msg) {
  if (!h2hResult) return;
  h2hResult.style.display = 'block';
  h2hResult.innerHTML = `<div class="matches-empty">${msg}</div>`;
}

function renderHeadToHeadResult(data) {
  const { summary, games, players } = data;
  const winRate = summary.games ? Math.round(summary.winRate * 1000) / 10 : 0;
  if (!summary.games) {
    showHeadToHeadMessage(`未找到「${esc(players.a)}」与「${esc(players.b)}」近两年的交手记录；已检查 ${data.checkedGroups || 0} 个同组候选。`);
    return;
  }

  const rows = games.map(g => {
    const resultLabel = g.result === 'win'
      ? '<span class="m-win">胜</span>'
      : g.result === 'lose'
      ? '<span class="m-lose">负</span>'
      : '<span class="m-draw">和</span>';
    const score = (g.score > 0 || g.opp_score > 0) ? `<span class="m-score">${g.score}:${g.opp_score}</span>` : '';
    return `<tr>
      <td>${esc(g.event.date || '')}</td>
      <td><a class="h2h-event-link" href="${esc(g.event.detail_url)}" target="_blank">${esc(g.event.title)}</a><div class="opponent-org">${esc(g.group.name || '')}</div></td>
      <td>第${g.bout}轮</td>
      <td>${resultLabel} ${score}</td>
      <td>${esc(g.playerA.org || '')}</td>
      <td>${esc(g.playerB.org || '')}</td>
    </tr>`;
  }).join('');

  h2hResult.style.display = 'block';
  h2hResult.innerHTML = `
    <div class="h2h-summary">
      <span><b>${esc(players.a)}</b> 对 <b>${esc(players.b)}</b></span>
      <span class="h2h-score">${summary.win}胜 ${summary.lose}负 ${summary.draw}和</span>
      <span>胜率 ${winRate}%</span>
      <span>同组候选 ${data.candidates || 0}，已检查 ${data.checkedGroups || 0}</span>
      ${data.failedGroups ? `<span>${data.failedGroups} 组加载失败</span>` : ''}
    </div>
    <table class="h2h-table">
      <thead><tr><th>日期</th><th>赛事</th><th>轮次</th><th>结果</th><th>${esc(players.a)}单位</th><th>${esc(players.b)}单位</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ── Form submit ───────────────────────────────────────────────────────────────
form.addEventListener('submit', e => { e.preventDefault(); startSearch(); });
if (h2hForm) h2hForm.addEventListener('submit', e => { e.preventDefault(); startHeadToHeadSearch(); });
if (h2hClearBtn) h2hClearBtn.addEventListener('click', () => clearHeadToHeadResult({ clearPlayers: true }));
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

  const seq = ++searchSeq;
  strengthEvalVersion++;
  currentProvince = province;
  clearHeadToHeadResult();

  if (evtSource) { evtSource.close(); evtSource = null; }
  if (strengthRefreshTimer) {
    clearTimeout(strengthRefreshTimer);
    strengthRefreshTimer = null;
  }

  const { dateFrom, dateTo, label: dateLabel } = getRecentTwoYearRange();

  // Reset UI
  hits = 0;
  hitDates  = [];
  allHits   = [];
  resultsList.innerHTML = '';
  const oldCard = document.getElementById('strengthCard');
  if (oldCard) oldCard.remove();
  clearPromotionCard();
  resultCount.textContent = '0';
  progressBar.style.width = '0%';
  progressText.textContent = '正在连接...';
  progressCount.textContent = '';
  progressSection.style.display = 'block';
  resultsSection.style.display  = 'block';
  const provinceLabel = province === '__ALL__' ? '全国' : province;
  resultsTitle.textContent = `${esc(name)} · ${esc(provinceLabel)} · ${dateLabel}`;
  renderStrengthPending(name);
  renderPromotionPending(name);
  searchBtn.disabled = true;
  stopBtn.style.display = 'inline-block';

  const params = new URLSearchParams({
    name, province,
    eventType: '2',
    dateFrom, dateTo,
  });
  evtSource = new EventSource(`/api/search?${params}`);

  evtSource.onmessage = e => {
    if (seq !== searchSeq) return;
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
        if (hits === 1) {
          renderCurrentBasicStrength(seq, name);
        }
        scheduleStrengthRefresh(seq, name);
        break;
      }

      case 'done':
        progressBar.style.width = '100%';
        if (msg.partial) {
          progressText.textContent = '已返回已索引结果';
          progressCount.textContent = `已检索本地索引 ${msg.searched} / ${msg.queued} 场，找到 ${hits} 条记录，${msg.fallbackQueued || 0} 场正在后台补索引`;
        } else {
          progressText.textContent = '搜索完成';
          progressCount.textContent = `共搜索 ${msg.searched} 场赛事，找到 ${hits} 条记录${msg.failed ? `，${msg.failed} 场请求失败` : ''}`;
        }
        if (strengthRefreshTimer) {
          clearTimeout(strengthRefreshTimer);
          strengthRefreshTimer = null;
        }
        if (hits === 0) {
          clearStrengthCard();
          clearPromotionCard();
          showEmpty(name, province, msg.partial);
        } else {
          showStrengthEstimate([...allHits], seq, name);
          showPromotionHistory(seq, name, province, dateFrom, dateTo);
        }
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
    if (seq !== searchSeq) return;
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
        ${player.rank ? `<span class="score-tag rank">名次 ${esc(player.rank)}</span>` : ''}
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
          const h2hLink = m.opponent
            ? `<button type="button" class="h2h-link" data-opponent="${esc(m.opponent)}">交手</button>`
            : '';
          return `<tr>
            <td class="bout-num">第${m.bout}轮</td>
            <td>${resultLabel} ${scoreStr}</td>
            <td class="opponent-name">${oppLink}${h2hLink}</td>
            <td class="opponent-org">${esc(m.opponent_org || '')}</td>
          </tr>`;
        }).join('');
        panel.innerHTML = `<table class="matches-table"><tbody>${rows}</tbody></table>`;
        panel.querySelectorAll('.h2h-link').forEach(link => {
          link.addEventListener('click', () => {
            const playerA = nameInput.value.trim() || player.name;
            const playerB = link.dataset.opponent || '';
            openHeadToHeadPage(playerA, playerB);
          });
        });
      } catch (e) {
        panel.innerHTML = `<div class="matches-empty">加载失败，<a href="${esc(event.detail_url)}" target="_blank">查看对阵表 →</a></div>`;
      }
    });
  }

  return card;
}

function showEmpty(name, province, partial = false) {
  const hint = partial
    ? '部分赛事正在后台补索引，稍后再查会更完整'
    : '请确认姓名是否精确，或尝试换一个省份';
  resultsList.innerHTML = `
    <div class="state-msg">
      <div class="icon">🔍</div>
      <div>${partial ? '已索引赛事中暂未找到' : '未找到'}「${esc(name)}」在${esc(province)}近两年的参赛记录</div>
      <div style="margin-top:6px;font-size:.82rem">${hint}</div>
    </div>`;
}

// ── Strength estimation ────────────────────────────────────────────────────────
// Level scale L: 25级=1, 24级=2, …, 1级=25, 1段=26, 2段=27, …, 8段=33

// ── Path A: skill-level groups (1级组, 3段组, 定段组, 公开组…) ────────────────
async function showPromotionHistory(seq, playerName, province, dateFrom, dateTo) {
  if (seq !== searchSeq) return;
  renderPromotionPending(playerName);
  try {
    const params = new URLSearchParams({ name: playerName, province, dateFrom, dateTo });
    const resp = await fetch(`/api/promotions?${params}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '升段历史查询失败');
    if (seq !== searchSeq) return;
    renderPromotionCard(data);
  } catch (err) {
    if (seq !== searchSeq) return;
    renderPromotionError(err);
  }
}

function renderPromotionPending(name) {
  clearPromotionCard();
  const card = document.createElement('div');
  card.id = 'promotionCard';
  card.className = 'promotion-card promotion-card--unknown';
  card.innerHTML = `
    <div class="promotion-header">
      <div class="promotion-title">可能升段历史</div>
      <div class="promotion-meta">正在等待「${esc(name)}」的参赛记录和赛事规程</div>
    </div>`;
  resultsList.before(card);
}

function renderPromotionError(err) {
  clearPromotionCard();
  const card = document.createElement('div');
  card.id = 'promotionCard';
  card.className = 'promotion-card promotion-card--unknown';
  card.innerHTML = `
    <div class="promotion-header">
      <div class="promotion-title">可能升段历史</div>
      <div class="promotion-meta">分析失败：${esc(err.message || err)}</div>
    </div>`;
  resultsList.before(card);
}

function renderPromotionCard(data) {
  clearPromotionCard();
  const card = document.createElement('div');
  card.id = 'promotionCard';
  card.className = 'promotion-card';

  const items = data.items || [];
  if (!items.length) {
    card.classList.add('promotion-card--unknown');
    card.innerHTML = `
      <div class="promotion-header">
        <div class="promotion-title">可能升段历史</div>
        <div class="promotion-meta">已检查 ${data.scanned || 0} 条参赛记录，暂未发现明确或高概率升段记录</div>
      </div>
      <div class="promotion-note">只有能识别到段位组/1级组，并且成绩满足规程或常见升段条件的记录才会显示。</div>`;
    resultsList.before(card);
    return;
  }

  const rows = items.map(item => {
    const record = item.record || {};
    const confClass = item.confidence === '高' ? 'promotion-conf--high'
      : item.confidence === '中' ? 'promotion-conf--mid'
      : 'promotion-conf--low';
    const title = (item.title || '').length > 28 ? item.title.slice(0, 28) + '…' : item.title;
    const rule = item.ruleText
      ? `<div class="promotion-rule">${esc(item.ruleText)}</div>`
      : '';
    const rank = item.rank && item.groupSize
      ? `第${item.rank}名 / ${item.groupSize}人`
      : item.rank ? `第${item.rank}名` : '名次待确认';
    return `
      <li class="promotion-item">
        <div class="promotion-item-main">
          <div class="promotion-item-title">
            <span class="promotion-target">升至 ${esc(item.promotedTo)}</span>
            <a href="${esc(item.detail_url)}" target="_blank">${esc(title)}</a>
          </div>
          <div class="promotion-item-meta">
            ${esc(item.date || '')} · ${esc(item.group || '')} · ${rank} · ${record.win || 0}胜${record.lose || 0}负${record.draw ? record.draw + '和' : ''}
          </div>
          <div class="promotion-basis">${esc(item.basis || '')}</div>
          ${rule}
        </div>
        <span class="promotion-conf ${confClass}">${esc(item.confidence || '低')}置信</span>
      </li>`;
  }).join('');

  card.innerHTML = `
    <div class="promotion-header">
      <div class="promotion-title">可能升段历史</div>
      <div class="promotion-meta">识别到 ${items.length} 条可能升段记录</div>
    </div>
    <ul class="promotion-list">${rows}</ul>
    <div class="promotion-note">说明：优先依据赛事规程判断；未发布或未解析到规程时，只显示高成绩的低/中置信推测。</div>`;
  resultsList.before(card);
}

function clearPromotionCard() {
  const old = document.getElementById('promotionCard');
  if (old) old.remove();
}

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

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function buildHeadToHeadStats(hits, matchMap) {
  const stats = new Map();
  if (!matchMap) return stats;

  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    if (timeWeight(h.event.date) === 0) continue;
    const matches = matchMap.get(i) || [];
    for (const m of matches) {
      if (!m.opponent) continue;
      const key = m.opponent.trim();
      if (!key) continue;
      const rec = stats.get(key) || { games: 0, win: 0, lose: 0, draw: 0 };
      rec.games++;
      if (m.result === 'win') rec.win++;
      else if (m.result === 'lose') rec.lose++;
      else rec.draw++;
      stats.set(key, rec);
    }
  }

  return stats;
}

function calcHeadToHeadAdj(matches, h2hStats) {
  if (!matches?.length || !h2hStats?.size) {
    return { h2hAdj: 0, h2hGameCount: 0, h2hOpponentCount: 0 };
  }

  let weightedScore = 0;
  let totalWeight = 0;
  let h2hGameCount = 0;
  const repeatedOpponents = new Set();

  for (const m of matches) {
    if (!m.opponent) continue;
    const rec = h2hStats.get(m.opponent.trim());
    if (!rec || rec.games < 2) continue;
    const score = (rec.win + 0.5 * rec.draw) / rec.games - 0.5;
    const reliability = Math.min(1, rec.games / 4);
    weightedScore += score * reliability * rec.games;
    totalWeight += reliability * rec.games;
    h2hGameCount += rec.games;
    repeatedOpponents.add(m.opponent.trim());
  }

  if (totalWeight === 0) {
    return { h2hAdj: 0, h2hGameCount: 0, h2hOpponentCount: 0 };
  }

  return {
    h2hAdj: clamp(1.6 * (weightedScore / totalWeight), -0.8, 0.8),
    h2hGameCount,
    h2hOpponentCount: repeatedOpponents.size,
  };
}

function estimateStrength(hits, matchMap = null) {
  // ── Pass 1: collect all event data ───────────────────────────────────────
  const collected = [];
  const h2hStats = buildHeadToHeadStats(hits, matchMap);

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
    let h2hAdj = 0;
    let h2hGameCount = 0;
    let h2hOpponentCount = 0;
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

      const h2h = calcHeadToHeadAdj(realMatches, h2hStats);
      h2hAdj = h2h.h2hAdj;
      h2hGameCount = h2h.h2hGameCount;
      h2hOpponentCount = h2h.h2hOpponentCount;
    }

    let wrAdj = winRateAdj(win, lose, draw);
    if (isOpen && wrAdj < 0) wrAdj *= 0.75;
    const T_raw = L_group + (isAgeGroup ? 0 : 0.5) + wrAdj + oppAdj + h2hAdj;
    const ew = eventLevelWeight(h.event.title, h.event.organizer || '');

    let dq;
    if (isAgeGroup)              dq = h2hGameCount >= 4 ? 0.72 : 0.60;
    else if (h2hGameCount >= 4)  dq = 1.08;
    else if (knownOppCount >= 2) dq = 1.00;
    else if (hasMatchData)       dq = 0.85;
    else                         dq = 0.75;

    const w = effectiveRounds * tw * ew * dq;
    collected.push({ h, L_group, wrAdj, oppAdj, h2hAdj, h2hGameCount, h2hOpponentCount, T_raw, w, rounds: effectiveRounds, tw, ew, isAgeGroup, isOpen, hasMatchData, knownOppCount });
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

function scheduleStrengthRefresh(seq, playerName) {
  if (seq !== searchSeq || allHits.length === 0) return;
  if (strengthRefreshTimer) clearTimeout(strengthRefreshTimer);
  strengthRefreshTimer = setTimeout(() => {
    strengthRefreshTimer = null;
    showStrengthEstimate([...allHits], seq, playerName);
  }, STRENGTH_REFRESH_DELAY_MS);
}

function renderCurrentBasicStrength(seq, playerName) {
  if (seq !== searchSeq || allHits.length === 0) return;
  const snapshot = [...allHits];
  const allGroups = [...new Set(snapshot.map(h => h.player.group).filter(Boolean))];
  const hasRecent = snapshot.some(h => timeWeight(h.event.date) > 0);
  const basicResult = estimateStrength(snapshot, null);
  renderStrengthCard(
    basicResult,
    snapshot,
    allGroups,
    hasRecent,
    '（搜索仍在继续，棋力会随新增结果自动刷新…）'
  );
  if (basicResult) {
    playerStrengthCache.set(
      playerName,
      { L: basicResult.L, confidence: basicResult.confidence }
    );
  }
}

async function fetchBackendStrength(playerName) {
  const { dateTo } = getRecentTwoYearRange();
  const params = new URLSearchParams({
    name: playerName,
    province: currentProvince || provinceSelect.value || '__ALL__',
    dateTo,
  });
  const resp = await fetch(`/api/strength?${params}`);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'strength estimate failed');
  return data;
}

function renderBackendStrengthCard(result) {
  clearStrengthCard();

  if (!result?.available) {
    const card = document.createElement('div');
    card.id = 'strengthCard';
    card.className = 'strength-card strength-card--unknown';
    const groups = (result?.groups || []).filter(Boolean);
    card.innerHTML = `
      <div class="strength-header">
        <div class="strength-label strength-label--unknown">棋力待估</div>
        <div class="strength-meta">${esc(result?.reason || '近180天内缺少可用棋力样本')}</div>
      </div>
      ${groups.length ? `<div class="strength-note">识别到的组别：${groups.map(g => `<b>${esc(g)}</b>`).join('、')}</div>` : ''}`;
    resultsList.before(card);
    return;
  }

  const confColor = result.confidence === '高' ? '#2e7d32' : result.confidence === '中' ? '#e65100' : '#c62828';
  const basisItems = (result.events || []).slice(0, 5).map(e => {
    const record = e.record || {};
    const diff = (Number(e.rating || 0) - Number(e.base || 0));
    const diffStr = `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}`;
    const title = (e.title || '').length > 24 ? e.title.slice(0, 24) + '…' : e.title;
    const tags = [
      e.matchGames ? `<span class="tag-match">对局${e.matchGames}盘</span>` : '',
      e.isAgeGroup ? '<span class="tag-age">年龄组</span>' : '',
      e.isOpen ? '<span class="tag-opp">公开组</span>' : '',
    ].filter(Boolean).join(' ');
    return `<li><b>${esc(title)}</b> · ${esc(e.group || '?')} · ${record.win || 0}胜${record.lose || 0}负${record.draw ? record.draw + '和' : ''} → <b>L=${Number(e.rating || 0).toFixed(2)}</b>（组别先验${Number(e.base || 0).toFixed(2)}，对手图谱修正${diffStr}）${tags ? ' ' + tags : ''}</li>`;
  }).join('');

  const range = result.range || {};
  const stats = result.stats || {};
  const warnings = (result.warnings || []).map(w => `<div class="strength-note">${esc(w)}</div>`).join('');
  const graphNote = stats.matchGames
    ? `<div class="strength-note strength-note--good">已纳入 ${stats.matchGames} 盘对局、${stats.opponents || 0} 位对手，并在 ${stats.graphPlayers || 0} 名同组棋手图谱中迭代评估。</div>`
    : '<div class="strength-note">暂未取得对局明细，当前为后端组别/胜负模型估算。</div>';

  const card = document.createElement('div');
  card.id = 'strengthCard';
  card.className = 'strength-card';
  card.innerHTML = `
    <div class="strength-header">
      <div class="strength-label">${esc(result.label || '棋力待估')}</div>
      <div class="strength-meta">
        L值 <b>${Number(result.L || 0).toFixed(2)}</b>
        &nbsp;·&nbsp; 范围 <b>${esc(range.lowLabel || '')} - ${esc(range.highLabel || '')}</b>
        &nbsp;·&nbsp; 置信度 <span style="color:${confColor};font-weight:700">${esc(result.confidence || '低')}</span>
        &nbsp;·&nbsp; 依据 ${stats.events || 0} 场赛事 / ${stats.rounds || 0} 轮
      </div>
    </div>
    <ul class="strength-basis">${basisItems}</ul>
    ${graphNote}${warnings}`;

  resultsList.before(card);
}

async function showStrengthEstimate(hits, seq, playerName) {
  if (seq !== searchSeq) return;
  const evalVersion = ++strengthEvalVersion;
  const old = document.getElementById('strengthCard');
  if (old) old.remove();

  const allGroups = [...new Set(hits.map(h => h.player.group).filter(Boolean))];
  const hasRecent = hits.some(h => timeWeight(h.event.date) > 0);

  // Phase 1: show basic estimate immediately (synchronous, no match data)
  const basicResult = estimateStrength(hits, null);
  if (seq !== searchSeq || evalVersion !== strengthEvalVersion) return;
  renderStrengthCard(basicResult, hits, allGroups, hasRecent, '（正在加载对局数据…）');

  try {
    const backendResult = await fetchBackendStrength(playerName);
    if (seq !== searchSeq || evalVersion !== strengthEvalVersion) return;
    renderBackendStrengthCard(backendResult);
    if (backendResult?.available) {
      playerStrengthCache.set(
        playerName,
        { L: backendResult.L, confidence: backendResult.confidence }
      );
      return;
    }
  } catch (_) {
    // Keep the previous browser-side estimator as a fallback.
  }

  // Phase 2: fetch all match data in parallel, re-render enhanced estimate
  const matchMap = await fetchAllMatchData(hits);
  if (seq !== searchSeq || evalVersion !== strengthEvalVersion) return;
  if (matchMap.size === 0) {
    // No match data could be fetched — re-render without loading note
    renderStrengthCard(basicResult, hits, allGroups, hasRecent, null);
    if (basicResult) {
      playerStrengthCache.set(
        playerName,
        { L: basicResult.L, confidence: basicResult.confidence }
      );
    }
    return;
  }

  const enhancedResult = estimateStrength(hits, matchMap);
  if (seq !== searchSeq || evalVersion !== strengthEvalVersion) return;
  renderStrengthCard(enhancedResult, hits, allGroups, hasRecent, null);
  if (enhancedResult) {
    playerStrengthCache.set(
      playerName,
      { L: enhancedResult.L, confidence: enhancedResult.confidence }
    );
  }
}

function renderStrengthPending(name) {
  clearStrengthCard();
  const card = document.createElement('div');
  card.id = 'strengthCard';
  card.className = 'strength-card strength-card--unknown';
  card.innerHTML = `
    <div class="strength-header">
      <div class="strength-label strength-label--unknown">棋力评估中</div>
      <div class="strength-meta">正在等待「${esc(name)}」的搜索结果</div>
    </div>`;
  resultsList.before(card);
}

function clearStrengthCard() {
  const old = document.getElementById('strengthCard');
  if (old) old.remove();
}

function renderStrengthCard(result, hits, allGroups, hasRecent, loadingMsg) {
  clearStrengthCard();

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
  const basisItems = sorted.slice(0, 4).map(({ h, L_group, wrAdj, oppAdj, h2hAdj, h2hGameCount, h2hOpponentCount, T, rounds, isAgeGroup, hasMatchData, knownOppCount }) => {
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
    const h2hAdjStr = h2hAdj && Math.abs(h2hAdj) >= 0.01
      ? `，交手修正${(h2hAdj >= 0 ? '+' : '') + h2hAdj.toFixed(2)}`
      : '';
    const matchTag = h2hGameCount >= 4
      ? ` <span class="tag-opp">同对手${h2hOpponentCount}人/${h2hGameCount}盘</span>`
      : knownOppCount >= 2
      ? ` <span class="tag-opp">对手数据</span>`
      : hasMatchData
      ? ` <span class="tag-match">对局已获取</span>`
      : '';
    return `<li><b>${esc(title)}</b> · ${esc(groupLabel)} · ${win}胜${lose}负${draw > 0 ? draw + '和' : ''}（${rounds}轮）→ <b>T=${T.toFixed(2)}</b>（${baseNote}，胜率调整${adjStr}${oppAdjStr}${h2hAdjStr}）${isAgeGroup ? ' <span class="tag-age">年龄组</span>' : ''}${matchTag}</li>`;
  }).join('');

  const skipped = hits.length - events.length;
  const ageCount = events.filter(e => e.isAgeGroup).length;
  const oppCount = events.filter(e => e.knownOppCount >= 2).length;
  const h2hEvents = events.filter(e => e.h2hGameCount >= 4).length;
  const h2hGames = events.reduce((s, e) => s + (e.h2hGameCount || 0), 0);

  const skipNote = skipped > 0
    ? `<div class="strength-note">另有 ${skipped} 场赛事因组别无法识别未纳入计算。</div>`
    : '';
  const ageNote = ageCount > 0
    ? `<div class="strength-note">含 ${ageCount} 场年龄/年级组比赛，以赛事级别+年级估算基准，置信度偏低。</div>`
    : '';
  const oppNote = oppCount > 0
    ? `<div class="strength-note strength-note--good">已通过对手强度数据（${oppCount} 场赛事）增强估算精度。</div>`
    : '';
  const h2hNote = h2hEvents > 0
    ? `<div class="strength-note strength-note--good">已纳入同对手交手记录：${h2hEvents} 场赛事中识别到 ${h2hGames} 盘重复对手交手，作为重要修正因素。</div>`
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
    ${ageNote}${h2hNote}${oppNote}${skipNote}${loadingNote}`;

  resultsList.before(card);
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Auto-search from URL params (e.g. /?name=X&province=Y) ───────────────────
(function initFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const name     = params.get('name');
  const province = params.get('province') || '__ALL__';
  if (!name) return;
  nameInput.value = name;
  provinceSelect.value = province;
  if (provinceSelect.value === province) startSearch();
})();
