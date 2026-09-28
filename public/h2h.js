'use strict';

const h2hForm = document.getElementById('h2hForm');
const h2hPlayerAInput = document.getElementById('h2hPlayerA');
const h2hPlayerBInput = document.getElementById('h2hPlayerB');
const h2hProvinceSelect = document.getElementById('h2hProvince');
const h2hBtn = document.getElementById('h2hBtn');
const h2hClearBtn = document.getElementById('h2hClearBtn');
const h2hResult = document.getElementById('h2hResult');
let h2hRequestVersion = 0;
let h2hController = null;
let identityQueryKey = '';
let selectedIdentities = { a:'', b:'' };
let currentQuery = null;

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
  };
}

async function startHeadToHeadSearch(playerA = h2hPlayerAInput.value.trim(), playerB = h2hPlayerBInput.value.trim(), province = h2hProvinceSelect.value || '__ALL__') {
  playerA = playerA.trim();
  playerB = playerB.trim();
  if (!playerA) { h2hPlayerAInput.focus(); return; }
  if (!playerB) { h2hPlayerBInput.focus(); return; }
  if (playerA === playerB) {
    showHeadToHeadMessage('请输入两位不同棋手');
    return;
  }

  h2hPlayerAInput.value = playerA;
  h2hPlayerBInput.value = playerB;
  h2hProvinceSelect.value = province;
  if(currentQuery && (currentQuery.playerA!==playerA || currentQuery.playerB!==playerB || currentQuery.province!==province)) window.PageView?.resetScroll();
  currentQuery = Object.freeze({ playerA, playerB, province });
  window.PageView?.update({playerA,playerB,province});
  const { dateFrom, dateTo } = getRecentTwoYearRange();
  const queryKey = JSON.stringify([playerA, playerB, province]);
  if (queryKey !== identityQueryKey) selectedIdentities = { a:'', b:'' };
  identityQueryKey = queryKey;
  const version = ++h2hRequestVersion;
  h2hController?.abort();
  const controller = new AbortController();
  h2hController = controller;

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
    if (selectedIdentities.a) params.set('identity_a', selectedIdentities.a);
    if (selectedIdentities.b) params.set('identity_b', selectedIdentities.b);
    window.PageView?.update({identity_a:selectedIdentities.a,identity_b:selectedIdentities.b});
    const data = await requestJson(`/api/head-to-head?${params}`, { signal: controller.signal });
    if (version !== h2hRequestVersion || controller.signal.aborted) return;
    if (data.selected_identities) selectedIdentities = data.selected_identities;
    if (data.identity_required) { renderIdentityChoices(data); return; }
    renderHeadToHeadResult(data);
    window.PageView?.restoreScroll();
  } catch (err) {
    if (version !== h2hRequestVersion || err.name === 'AbortError') return;
    showHeadToHeadMessage(`查询失败：${esc(err.message)}`);
    appendRetry(playerA, playerB);
  } finally {
    if (version === h2hRequestVersion) h2hBtn.disabled = false;
  }
}

function clearHeadToHeadResult({ clearPlayers = false } = {}) {
  h2hRequestVersion++;
  h2hController?.abort();
  h2hController = null;
  h2hBtn.disabled = false;
  selectedIdentities = { a:'', b:'' };
  identityQueryKey = '';
  window.PageView?.update({playerA:'',playerB:'',identity_a:'',identity_b:''});
  if (clearPlayers) {
    h2hPlayerAInput.value = '';
    h2hPlayerBInput.value = '';
  }
  h2hResult.style.display = 'none';
  h2hResult.innerHTML = '';
}

function showHeadToHeadLoading(playerA, playerB) {
  h2hResult.style.display = 'block';
  h2hResult.innerHTML = `
    <div class="h2h-context">正在查询「${esc(playerA)}」与「${esc(playerB)}」的交手记录</div>
    <div class="matches-loading">查询中...</div>`;
}

function showHeadToHeadMessage(msg) {
  h2hResult.style.display = 'block';
  h2hResult.innerHTML = `<div class="matches-empty">${msg}</div>`;
}

function renderHeadToHeadResult(data) {
  const { summary, games, players } = data;
  const winRate = summary.games ? Math.round(summary.winRate * 1000) / 10 : 0;
  if (!games.length) {
    showHeadToHeadMessage(data.failedGroups
      ? `有 ${data.failedGroups} 组对局读取失败，目前无法确认是否存在交手记录。`
      : `未找到「${esc(players.a)}」与「${esc(players.b)}」近两年的交手记录；已检查 ${data.checkedGroups || 0} 个同组候选。${data.truncated ? '候选数量超出本次查询上限，结果可能不完整。' : ''}`);
    if (data.failedGroups) appendRetry(players.a, players.b);
    return;
  }

  const rows = games.map(g => {
    const resultLabel = g.result === 'win'
      ? '<span class="m-win">胜</span>'
      : g.result === 'lose'
      ? '<span class="m-lose">负</span>'
      : g.result === 'draw' ? '<span class="m-draw">和</span>' : '<span class="m-pending">待赛</span>';
    const score = (g.score > 0 || g.opp_score > 0) ? `<span class="m-score">${g.score}:${g.opp_score}</span>` : '';
    return `<tr>
      <td>${esc(g.event.date || '')}</td>
      <td><a class="h2h-event-link" href="${esc(g.event.detail_url)}" target="_blank" rel="noopener">${esc(g.event.title)}</a><div class="opponent-org">${esc(g.group.name || '')}</div><details class="mobile-only"><summary>单位</summary><div>${esc(players.a)}：${esc(g.playerA.org || '--')}</div><div>${esc(players.b)}：${esc(g.playerB.org || '--')}</div></details></td>
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
      ${data.partial ? '<span>当前为部分结果</span>' : ''}
    </div>
    <table class="h2h-table">
      <thead><tr><th>日期</th><th>赛事</th><th>轮次</th><th>结果</th><th>${esc(players.a)}单位</th><th>${esc(players.b)}单位</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  if (data.failedGroups) appendRetry(players.a, players.b);
}

function appendRetry(playerA, playerB) {
  const province = currentQuery.province;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-secondary';
  button.textContent = '重试';
  button.addEventListener('click', () => startHeadToHeadSearch(playerA, playerB, province));
  h2hResult.appendChild(button);
}

function renderIdentityChoices(data) {
  const province = currentQuery.province;
  h2hResult.style.display = 'block';
  h2hResult.innerHTML = `<div class="h2h-title">请确认棋手的参赛轨迹</div><div class="form-row">${['a','b'].map(side => {
    const choices = data.identities[side] || [];
    const options = choices.map(p => `<option value="${esc(p.id)}" ${selectedIdentities[side] === p.id ? 'selected' : ''}>${esc(p.label)} · ${esc(p.orgs.join('、') || '单位未注明')} · ${esc(p.date_from)} 至 ${esc(p.date_to)}</option>`).join('');
    return `<div class="form-group"><label for="identity-${side}">${esc(data.players[side])}</label><select id="identity-${side}"><option value="">请选择轨迹</option>${options}</select></div>`;
  }).join('')}<button type="button" id="confirmIdentities" class="btn-primary">确定</button></div>`;
  document.getElementById('confirmIdentities').addEventListener('click', () => {
    const a = document.getElementById('identity-a');
    const b = document.getElementById('identity-b');
    if (!a.value) { a.focus(); return; }
    if (!b.value) { b.focus(); return; }
    selectedIdentities = { a:a.value, b:b.value };
    startHeadToHeadSearch(data.players.a, data.players.b, province);
  });
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

h2hForm.addEventListener('submit', e => {
  e.preventDefault();
  startHeadToHeadSearch();
});
h2hClearBtn.addEventListener('click', () => clearHeadToHeadResult({ clearPlayers: true }));

(function initFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const playerA = params.get('playerA') || params.get('a') || '';
  const playerB = params.get('playerB') || params.get('b') || '';
  const province = params.get('province') || '__ALL__';
  if (province) h2hProvinceSelect.value = province;
  if (playerA) h2hPlayerAInput.value = playerA;
  if (playerB) h2hPlayerBInput.value = playerB;
  selectedIdentities = { a:params.get('identity_a') || '', b:params.get('identity_b') || '' };
  identityQueryKey = JSON.stringify([playerA,playerB,province]);
  if (playerA && playerB) startHeadToHeadSearch(playerA, playerB);
})();
