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
let searchSeq = 0;
let strengthRefreshTimer = null;
let strengthEvalVersion = 0;
let queryController = null;
let queryContext = null;
let identityProfiles = [];
let identityMemberships = new Map();
let identityRequestVersion = 0;
let resultFilters = {year:'',keyword:'',group:''};
let linkedIdentity = '';

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

function openHeadToHeadPage(playerA = '', playerB = '', context = {}) {
  const province = context.province || queryContext?.province || '__ALL__';
  const params = new URLSearchParams({ playerA, playerB, province });
  if (context.identityA) params.set('identity_a', context.identityA);
  if (context.identityB) params.set('identity_b', context.identityB);
  window.open(`/head-to-head.html?${params}`, '_blank', 'noopener');
}


// ── Form submit ───────────────────────────────────────────────────────────────
form.addEventListener('submit', e => { e.preventDefault(); startSearch(); });
stopBtn.addEventListener('click', () => {
  if (strengthRefreshTimer) { clearTimeout(strengthRefreshTimer); strengthRefreshTimer = null; }
  if (evtSource) { evtSource.close(); evtSource = null; }
  preservePartialResults();
  progressText.textContent = '已停止，当前为部分结果';
  stopBtn.style.display = 'none';
  searchBtn.disabled = false;
});

function preservePartialResults() {
  searchSeq++;
  identityRequestVersion++;
  strengthEvalVersion++;
  queryController?.abort();
  queryController = new AbortController();
  queryContext = Object.freeze({ ...queryContext, identity:'', seq:searchSeq });
  identityProfiles = [];
  identityMemberships = new Map();
  clearIdentityNotice();
  clearStrengthCard();
  clearPromotionCard();
  resultsList.replaceChildren(...[...allHits].sort((a,b) => (b.event.date || '').localeCompare(a.event.date || '')).map(buildCard));
  populateResultFilters();
}

// ── Main search ───────────────────────────────────────────────────────────────
function startSearch({ restore = false } = {}) {
  const name     = nameInput.value.trim();
  const province = provinceSelect.value;

  if (!name)     { nameInput.focus();     return; }
  if (!province) { provinceSelect.focus(); return; }
  if (!restore) { resultFilters={year:'',keyword:'',group:''}; linkedIdentity=''; window.PageView?.resetScroll(); }
  window.PageView?.update({name,province,year:resultFilters.year,keyword:resultFilters.keyword,group:resultFilters.group,identity:linkedIdentity});
  document.getElementById('resultFilters').hidden=true;

  const seq = ++searchSeq;
  queryController?.abort();
  queryController = new AbortController();
  identityRequestVersion++;
  identityProfiles = [];
  identityMemberships = new Map();
  strengthEvalVersion++;
  currentProvince = province;
  clearIdentityNotice();

  if (evtSource) { evtSource.close(); evtSource = null; }
  if (strengthRefreshTimer) {
    clearTimeout(strengthRefreshTimer);
    strengthRefreshTimer = null;
  }

  const { dateFrom, dateTo, label: dateLabel } = getRecentTwoYearRange();
  queryContext = Object.freeze({ name, province, dateFrom, dateTo, identity: '', seq });

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
  resultsTitle.textContent = `${name} · ${provinceLabel} · ${dateLabel}`;
  renderStrengthPending(name);
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
      case 'identities':
        identityProfiles = msg.profiles || [];
        identityMemberships = new Map((msg.memberships || []).map(item => [item.key, item.identity_id]));
        break;
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
        if (msg.partial) {
          progressText.textContent = '已返回已索引结果';
          const missing = msg.fallbackQueued || 0;
          const missingStatus = msg.backfillStarted ? `${missing} 场已启动后台补索引` : `${missing} 场尚未建立索引`;
          progressCount.textContent = `已检索本地索引 ${msg.searched} / ${msg.queued} 场，找到 ${hits} 条记录，${missingStatus}`;
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
          showEmpty(name, province, msg.partial || msg.failed > 0);
        } else {
          applyIdentitySelection(identityProfiles.some(p=>p.id===linkedIdentity) ? linkedIdentity : identityProfiles.length === 1 ? identityProfiles[0].id : '');
        }
        window.PageView?.restoreScroll();
        evtSource.close(); evtSource = null;
        searchBtn.disabled = false;
        stopBtn.style.display = 'none';
        break;

      case 'error':
        progressText.textContent = '出错：' + msg.msg;
        evtSource.close(); evtSource = null;
        preservePartialResults();
        searchBtn.disabled = false;
        stopBtn.style.display = 'none';
        break;
    }
  };

  evtSource.onerror = () => {
    if (seq !== searchSeq) return;
    progressText.textContent = '连接中断，当前结果可能不完整';
    evtSource.close(); evtSource = null;
    preservePartialResults();
    searchBtn.disabled = false;
    stopBtn.style.display = 'none';
  };
}

// ── Build result card ─────────────────────────────────────────────────────────
function buildCard(msg) {
  const { event, player } = msg;
  const cardContext = { name: player.name, province: queryContext?.province || currentProvince || '__ALL__',
    identityA: identityMemberships.get(hitIdentityKey(msg)) || `${event.event_id}:${player.groupid}:${player.participantid}` };
  const card = document.createElement('div');
  card.className = 'result-card';
  card.dataset.year = String(event.date || '').slice(0,4);
  card.dataset.title = event.title || '';
  card.dataset.group = player.group || '';
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
        ${event.organizer ? `<span>🏢 ${esc(event.organizer)}</span>` : ''}
      </div>
      <div class="card-scores">
        ${player.group ? `<span class="score-tag group">${esc(player.group)}</span>` : ''}
        ${player.org   ? `<span class="score-tag org">${esc(player.org)}</span>`     : ''}
        <span class="score-tag win">胜 ${winNum}</span>
        <span class="score-tag lose">负 ${loseNum}</span>
        ${drawNum > 0 ? `<span class="score-tag draw">和 ${drawNum}</span>` : ''}
        <span class="score-tag score">积分 ${esc(player.score === '' ? '未公布' : player.score)}</span>
        ${player.rank ? `<span class="score-tag rank">名次 ${esc(player.rank)}</span>` : ''}
      </div>
    </div>
    <div class="card-links">
      <a href="${esc(event.detail_url)}" target="_blank" rel="noopener">赛事详情 →</a>
      ${player.detail_url ? `<a href="${esc(player.detail_url)}" target="_blank" rel="noopener">个人对局 →</a>` : ''}
      ${totalRounds > 0 ? `<button class="btn-expand" type="button">展开对局 ▾</button>` : ''}
    </div>
    ${totalRounds > 0 ? `<div class="matches-panel" style="display:none"></div>` : ''}`;

  if (totalRounds > 0) {
    const btn   = card.querySelector('.btn-expand');
    const panel = card.querySelector('.matches-panel');
    let loaded  = false;

    async function loadMatches() {
      const signal = queryController?.signal;
      const seq = searchSeq;
      panel.style.display = 'block';
      btn.textContent = '收起对局 ▴';
      btn.setAttribute('aria-expanded', 'true');
      if (loaded) return;
      loaded = true;
      panel.innerHTML = '<div class="matches-loading">加载中…</div>';
      try {
        const params = new URLSearchParams({ group_id:player.groupid, rounds:totalRounds, player_id:player.participantid });
        const data = await requestJson(`/api/matches?${params}`, { signal });
        if (seq !== searchSeq || signal?.aborted || !card.isConnected) return;
        if (!data.matches?.some(m => m.opponent !== null)) {
          loaded = false;
          panel.innerHTML = '<div class="matches-empty">暂无已公布的对局数据 <button type="button" class="btn-expand" data-retry>重新查询</button></div>';
          panel.querySelector('[data-retry]').addEventListener('click', loadMatches);
          return;
        }
        const rows = data.matches.map(m => {
          if (m.opponent === null) return `<tr><td class="bout-num">第${m.bout}轮</td><td colspan="3" class="no-data">—</td></tr>`;
          const resultLabel = { win:'胜', lose:'负', draw:'和' }[m.result] || '待赛';
          const resultClass = { win:'m-win', lose:'m-lose', draw:'m-draw' }[m.result] || 'm-pending';
          const opponentUrl = `/?name=${encodeURIComponent(m.opponent)}&province=${encodeURIComponent(cardContext.province)}`;
          const score = (m.score > 0 || m.opp_score > 0) ? `<span class="m-score">${Number(m.score) || 0}:${Number(m.opp_score) || 0}</span>` : '';
          return `<tr><td class="bout-num">第${m.bout}轮</td><td><span class="${resultClass}">${resultLabel}</span> ${score}</td>
            <td>${m.bye ? esc(m.opponent) : `<a href="${opponentUrl}" target="_blank" rel="noopener" class="opp-link">${esc(m.opponent)}</a>
            <button type="button" class="h2h-link" data-opponent="${esc(m.opponent)}" data-opponent-id="${esc(m.opponent_id || '')}">交手</button>`}</td><td class="opponent-org">${esc(m.opponent_org || '')}</td></tr>`;
        }).join('');
        const freshness = data.stale ? `<div class="matches-empty">实时读取失败，显示上次成功记录${data.updated_at ? `（${esc(new Date(data.updated_at).toLocaleString())}）` : ''} <button type="button" class="btn-expand" data-retry>重试更新</button></div>` : '';
        panel.innerHTML = `${freshness}<table class="matches-table"><tbody>${rows}</tbody></table>`;
        panel.querySelector('[data-retry]')?.addEventListener('click', () => { loaded = false; loadMatches(); });
        panel.querySelectorAll('.h2h-link').forEach(link => link.addEventListener('click', () => {
          openHeadToHeadPage(cardContext.name, link.dataset.opponent, { ...cardContext,
            identityB: link.dataset.opponentId ? `${event.event_id}:${player.groupid}:${link.dataset.opponentId}` : '' });
        }));
      } catch (error) {
        loaded = false;
        if (seq !== searchSeq || error.name === 'AbortError') return;
        panel.innerHTML = `<div class="matches-empty">${esc(error.message)} <button type="button" class="btn-expand" data-retry>重试</button></div>`;
        panel.querySelector('[data-retry]').addEventListener('click', loadMatches);
      }
    }
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', () => {
      if (panel.style.display !== 'none') {
        panel.style.display = 'none';
        btn.textContent = '展开对局 ▾';
        btn.setAttribute('aria-expanded', 'false');
      } else {
        loadMatches();
      }
    });
  }

  return card;
}

function showEmpty(name, province, partial = false) {
  const provinceLabel = province === '__ALL__' ? '全国' : province;
  const hint = partial
    ? '本次未覆盖所有赛事，当前不能确认没有参赛记录，请稍后重试'
    : '请确认姓名是否精确，或尝试换一个省份';
  resultsList.innerHTML = `
    <div class="state-msg">
      <div class="icon">🔍</div>
      <div>${partial ? '已索引赛事中暂未找到' : '未找到'}「${esc(name)}」在${esc(provinceLabel)}近两年的参赛记录</div>
      <div style="margin-top:6px;font-size:.82rem">${hint}</div>
    </div>`;
}

function clearIdentityNotice() {
  document.getElementById('identityNotice')?.remove();
}

function hitIdentityKey(hit) {
  return `${hit.event.event_id}:${hit.player.groupid}:${hit.player.participantid}`;
}

function applyIdentitySelection(identity) {
  queryController?.abort();
  queryController = new AbortController();
  identityRequestVersion++;
  strengthEvalVersion++;
  queryContext = Object.freeze({ ...queryContext, identity });
  window.PageView?.update({identity});
  clearStrengthCard();
  clearPromotionCard();
  resultsList.innerHTML = '';
  const selected = identityProfiles.find(p => p.id === identity);
  const visible = selected ? allHits.filter(h => identityMemberships.get(hitIdentityKey(h)) === identity) : allHits;
  const profiles = selected ? [selected] : identityProfiles;
  for (const profile of profiles) {
    if (identityProfiles.length > 1) {
      const heading = document.createElement('h3');
      heading.className = 'identity-group-heading';
      heading.textContent = `${profile.label} · ${profile.orgs.join('、') || '单位未注明'} · ${profile.event_count} 场`;
      resultsList.appendChild(heading);
    }
    const records = visible.filter(h => identityMemberships.get(hitIdentityKey(h)) === profile.id)
      .sort((a,b) => (b.event.date || '').localeCompare(a.event.date || ''));
    for (const hit of records) resultsList.appendChild(buildCard(hit));
  }
  resultCount.textContent = String(visible.length);
  renderIdentityNotice();
  populateResultFilters();
  if (!selected) return;
  const { seq, name, province, dateFrom, dateTo } = queryContext;
  showStrengthEstimate(visible, seq, name);
  showPromotionHistory(seq, name, province, dateFrom, dateTo);
}

function populateResultFilters() {
  const section=document.getElementById('resultFilters');
  section.hidden=!allHits.length;
  for(const [key,id,values,label] of [
    ['year','resultYear',allHits.map(h=>String(h.event.date||'').slice(0,4)),'全部年份'],
    ['group','resultGroup',allHits.map(h=>h.player.group),'全部组别'],
  ]) {
    const select=document.getElementById(id);
    select.innerHTML=`<option value="">${label}</option>`+[...new Set(values.filter(Boolean))].sort().reverse()
      .map(value=>`<option value="${esc(value)}">${esc(value)}</option>`).join('');
    select.value=resultFilters[key];
    if(!select.value) resultFilters[key]='';
  }
  document.getElementById('resultKeyword').value=resultFilters.keyword;
  applyResultFilters();
}

function applyResultFilters() {
  const cards=[...resultsList.querySelectorAll('.result-card')];let shown=0;
  for(const card of cards) {
    card.hidden=Boolean((resultFilters.year && card.dataset.year!==resultFilters.year)
      || (resultFilters.group && card.dataset.group!==resultFilters.group)
      || !card.dataset.title.toLocaleLowerCase().includes(resultFilters.keyword.trim().toLocaleLowerCase()));
    if(!card.hidden) shown++;
  }
  for(const heading of resultsList.querySelectorAll('.identity-group-heading')) {
    let next=heading.nextElementSibling,visible=false;
    while(next && !next.classList.contains('identity-group-heading')) { if(!next.hidden) visible=true;next=next.nextElementSibling; }
    heading.hidden=!visible;
  }
  document.getElementById('resultDisplayed').textContent=`显示 ${shown} / ${cards.length} 场`;
  window.PageView?.update({...resultFilters});
}
for(const [id,key,event] of [['resultYear','year','change'],['resultGroup','group','change'],['resultKeyword','keyword','input']]) {
  document.getElementById(id).addEventListener(event,e=>{resultFilters[key]=e.target.value;applyResultFilters();});
}
document.getElementById('resetResultFilters').addEventListener('click',()=>{resultFilters={year:'',keyword:'',group:''};populateResultFilters();});

function renderIdentityNotice() {
  clearIdentityNotice();
  if (identityProfiles.length < 2) return;
  const notice = document.createElement('aside');
  notice.id = 'identityNotice';
  notice.className = 'identity-notice';
  notice.setAttribute('role', 'status');
  const choices = identityProfiles.map(profile => `<button type="button" data-identity="${esc(profile.id)}"
    aria-pressed="${queryContext.identity === profile.id}">${esc(profile.label)} · ${esc(profile.orgs[0] || '单位未注明')}
    · ${esc(profile.date_from)} 至 ${esc(profile.date_to)}</button>`).join('');
  notice.innerHTML = `
    <div class="identity-notice-copy">
      <strong>${identityProfiles.length} 条待区分的同名参赛轨迹</strong>
      <span>${queryContext.identity ? '当前统计仅包含选中轨迹' : '记录已分开，棋力和升段历史暂未合并计算'}</span>
    </div>
    <div class="identity-notice-actions">${choices}<button type="button" data-identity="">全部轨迹</button></div>`;
  const anchor = document.getElementById('strengthCard') || resultsList;
  anchor.before(notice);
  notice.querySelectorAll('[data-identity]').forEach(button => {
    button.addEventListener('click', () => applyIdentitySelection(button.dataset.identity));
  });
}

// ── Strength estimation ────────────────────────────────────────────────────────
// Level scale L: 25级=1, 24级=2, …, 1级=25, 1段=26, 2段=27, …, 8段=33

// ── Path A: skill-level groups (1级组, 3段组, 定段组, 公开组…) ────────────────
async function showPromotionHistory(seq, playerName, province, dateFrom, dateTo) {
  if (seq !== searchSeq) return;
  const version = identityRequestVersion;
  const signal = queryController?.signal;
  renderPromotionPending(playerName);
  try {
    const params = new URLSearchParams({ name: playerName, province, dateFrom, dateTo });
    if (queryContext?.identity) params.set('identity', queryContext.identity);
    const data = await requestJson(`/api/promotions?${params}`, { signal });
    if (seq !== searchSeq || version !== identityRequestVersion || signal?.aborted) return;
    renderPromotionCard(data);
  } catch (err) {
    if (seq !== searchSeq || version !== identityRequestVersion || err.name === 'AbortError') return;
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
      <div class="promotion-title">升级/升段路径</div>
      <div class="promotion-meta">正在等待「${esc(name)}」的参赛记录和赛事规程</div>
    </div>`;
  placePromotionCard(card);
}

function renderPromotionError(err) {
  clearPromotionCard();
  const card = document.createElement('div');
  card.id = 'promotionCard';
  card.className = 'promotion-card promotion-card--unknown';
  card.innerHTML = `
    <div class="promotion-header">
      <div class="promotion-title">升级/升段路径</div>
      <div class="promotion-meta">分析失败：${esc(err.message || err)}</div>
    </div>`;
  placePromotionCard(card);
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
        <div class="promotion-title">升级/升段路径</div>
        <div class="promotion-meta">暂未发现明确升级/升段记录</div>
      </div>`;
    placePromotionCard(card);
    return;
  }

  const rows = items.map(item => {
    const record = item.record || {};
    const title = (item.title || '').length > 28 ? item.title.slice(0, 28) + '…' : item.title;
    const rank = item.rank && item.groupSize
      ? `第${item.rank}名 / ${item.groupSize}人`
      : item.rank ? `第${item.rank}名` : '名次待确认';
    const meta = [item.date || '', item.group || '', rank].filter(Boolean);
    if (record && (record.win || record.lose || record.draw)) {
      meta.push(`${record.win || 0}胜${record.lose || 0}负${record.draw ? record.draw + '和' : ''}`);
    }
    return `
      <li class="promotion-item">
        <div class="promotion-item-main">
          <div class="promotion-item-title">
            <span class="promotion-target">升至 ${esc(item.promotedTo)}</span>
            <a href="${esc(item.detail_url)}" target="_blank">${esc(title)}</a>
          </div>
          <div class="promotion-item-meta">
            ${esc(meta.join(' · '))}
          </div>
        </div>
      </li>`;
  }).join('');

  card.innerHTML = `
    <div class="promotion-header">
      <div class="promotion-title">升级/升段路径</div>
      <div class="promotion-meta">${items.length} 条记录</div>
    </div>
    <ul class="promotion-list">${rows}</ul>`;
  placePromotionCard(card);
}

function clearPromotionCard() {
  const old = document.getElementById('promotionCard');
  if (old) old.remove();
}

function placePromotionCard(card) {
  resultsList.after(card);
}


async function fetchBackendStrength(playerName) {
  const { dateTo } = getRecentTwoYearRange();
  const params = new URLSearchParams({
    name: playerName,
    province: queryContext?.province || '__ALL__',
    dateFrom: queryContext?.dateFrom || getRecentTwoYearRange().dateFrom,
    dateTo,
  });
  if (queryContext?.identity) params.set('identity', queryContext.identity);
  return requestJson(`/api/strength?${params}`, { signal: queryController?.signal });
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
    <details class="strength-details">
      <summary>查看计算依据</summary>
      <div class="strength-details-body">
        <ul class="strength-basis">${basisItems}</ul>
        ${graphNote}${warnings}
        ${result.model?.version ? `<div class="strength-note">模型 ${esc(result.model.version)} · ${esc(result.model.window_days)} 天</div>` : ''}
      </div>
    </details>`;

  resultsList.before(card);
}

async function showStrengthEstimate(hits, seq, playerName) {
  if (seq !== searchSeq) return;
  const evalVersion = ++strengthEvalVersion;
  renderStrengthPending(playerName);
  try {
    const result = await fetchBackendStrength(playerName);
    if (seq !== searchSeq || evalVersion !== strengthEvalVersion) return;
    renderBackendStrengthCard(result);
  } catch (error) {
    if (seq !== searchSeq || evalVersion !== strengthEvalVersion || error.name === 'AbortError') return;
    clearStrengthCard();
    const card = document.createElement('div');
    card.id = 'strengthCard';
    card.className = 'strength-card strength-card--unknown';
    card.innerHTML = `<div class="strength-label strength-label--unknown">评估暂不可用</div><div class="strength-note">${esc(error.message)}</div>`;
    const retry = document.createElement('button');
    retry.type = 'button'; retry.className = 'btn-secondary'; retry.textContent = '重试';
    retry.addEventListener('click', () => showStrengthEstimate(hits, seq, playerName));
    card.appendChild(retry);
    resultsList.before(card);
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


function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Auto-search from URL params (e.g. /?name=X&province=Y) ───────────────────
(function initFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const name     = params.get('name');
  const province = params.get('province') || '__ALL__';
  if (!name) return;
  resultFilters={year:params.get('year')||'',keyword:params.get('keyword')||'',group:params.get('group')||''};
  linkedIdentity=params.get('identity')||'';
  nameInput.value = name;
  provinceSelect.value = province;
  if (provinceSelect.value === province) startSearch({restore:true});
})();
