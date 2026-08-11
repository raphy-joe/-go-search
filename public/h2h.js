'use strict';

const h2hForm = document.getElementById('h2hForm');
const h2hPlayerAInput = document.getElementById('h2hPlayerA');
const h2hPlayerBInput = document.getElementById('h2hPlayerB');
const h2hProvinceSelect = document.getElementById('h2hProvince');
const h2hBtn = document.getElementById('h2hBtn');
const h2hClearBtn = document.getElementById('h2hClearBtn');
const h2hResult = document.getElementById('h2hResult');

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

async function startHeadToHeadSearch(playerA = h2hPlayerAInput.value.trim(), playerB = h2hPlayerBInput.value.trim()) {
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
  const province = h2hProvinceSelect.value || '__ALL__';
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
  if (playerA && playerB) startHeadToHeadSearch(playerA, playerB);
})();
