'use strict';

const liveProvinceSelect = document.getElementById('liveProvince');
const loadLiveEventsBtn = document.getElementById('loadLiveEventsBtn');
const liveEventsSection = document.getElementById('liveEventsSection');
const liveEventCount = document.getElementById('liveEventCount');
const liveEventsList = document.getElementById('liveEventsList');
const liveGroupSection = document.getElementById('liveGroupSection');
const selectedEventTitle = document.getElementById('selectedEventTitle');
const selectedEventMeta = document.getElementById('selectedEventMeta');
const selectedEventLink = document.getElementById('selectedEventLink');
const liveGroupSelect = document.getElementById('liveGroupSelect');
const refreshLiveGroupBtn = document.getElementById('refreshLiveGroupBtn');
const livePlayersPanel = document.getElementById('livePlayersPanel');
const livePredictionSection = document.getElementById('livePredictionSection');
const livePredictionPanel = document.getElementById('livePredictionPanel');
const backToLiveList = document.getElementById('backToLiveList');
const liveToolbar = document.querySelector('.live-toolbar');

let selectedEvent = null;
let selectedGroup = null;
let groupRequestSeq = 0;
let predictionRequestSeq = 0;
let predictionOnlyPage = false;

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pct(value) {
  return `${Math.round((Number(value) || 0) * 1000) / 10}%`;
}

function showMessage(target, message) {
  target.innerHTML = `<div class="state-msg">${esc(message)}</div>`;
}

async function loadLiveEvents() {
  const province = liveProvinceSelect.value || '四川省';
  selectedEvent = null;
  selectedGroup = null;
  liveGroupSection.style.display = 'none';
  livePredictionSection.style.display = 'none';
  liveEventsSection.style.display = 'block';
  liveEventCount.textContent = '...';
  showMessage(liveEventsList, '正在同步查询正在进行的比赛');
  loadLiveEventsBtn.disabled = true;

  try {
    const params = new URLSearchParams({ province });
    const resp = await fetch(`/api/live-events?${params}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '查询失败');
    renderLiveEvents(data.events || []);
  } catch (err) {
    liveEventCount.textContent = '0';
    showMessage(liveEventsList, `查询失败：${err.message}`);
  } finally {
    loadLiveEventsBtn.disabled = false;
  }
}

function renderLiveEvents(events) {
  liveEventCount.textContent = String(events.length);
  if (!events.length) {
    showMessage(liveEventsList, '当前省份暂未发现可预测比赛');
    return;
  }

  liveEventsList.innerHTML = events.map(event => `
    <button type="button" class="live-event-item" data-event-id="${esc(event.event_id)}">
      <span class="live-event-main">
        <b><span class="live-status live-status-${esc(event.status || 'unknown')}">${esc(event.status_label || '可查询')}</span>${esc(event.title)}</b>
        <span>${esc(event.date || '')} · ${esc(event.province || '')} ${esc(event.city || '')} · ${esc(event.organizer || '')}</span>
      </span>
      <span class="live-event-side">${event.live_group_count || 0}/${event.group_count || 0} 组进行中</span>
    </button>
  `).join('');

  liveEventsList.querySelectorAll('.live-event-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const event = events.find(e => String(e.event_id) === btn.dataset.eventId);
      if (event) window.open(buildEventDetailUrl(event), '_blank', 'noopener');
    });
  });
}

function buildEventDetailUrl(event) {
  const params = new URLSearchParams({
    event_id: event.event_id,
    title: event.title || '',
    date: event.date || '',
    province: event.province || '',
    city: event.city || '',
    organizer: event.organizer || '',
    detail_url: event.detail_url || '',
  });
  return `live-prediction.html?${params}`;
}

async function selectEvent(event, options = {}) {
  selectedEvent = event;
  selectedGroup = null;
  livePredictionSection.style.display = 'none';
  liveGroupSection.style.display = 'block';
  selectedEventTitle.textContent = event.title || '';
  selectedEventMeta.textContent = `${event.date || ''} · ${event.province || ''} ${event.city || ''}`;
  selectedEventLink.href = event.detail_url || '#';
  liveGroupSelect.innerHTML = '<option>正在同步组别...</option>';
  showMessage(livePlayersPanel, '请选择组别后查看选手');

  try {
    const params = new URLSearchParams({ event_id: event.event_id });
    const resp = await fetch(`/api/live-event?${params}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '组别加载失败');
    renderGroups(data.groups || [], options);
  } catch (err) {
    liveGroupSelect.innerHTML = '<option>组别加载失败</option>';
    showMessage(livePlayersPanel, `组别加载失败：${err.message}`);
  }
}

function renderGroups(groups, options = {}) {
  if (!groups.length) {
    liveGroupSelect.innerHTML = '<option>暂无组别</option>';
    showMessage(livePlayersPanel, '这个比赛暂未读到组别');
    return;
  }

  const ordered = [...groups].sort((a, b) => Number(b.live) - Number(a.live) || String(a.group_name).localeCompare(String(b.group_name), 'zh-CN'));
  liveGroupSelect.innerHTML = ordered.map(g => `
    <option value="${esc(g.group_id)}">${esc(g.group_name || g.group_id)} · ${g.pnumber || 0}人${g.live ? '' : ' · 非进行中'}</option>
  `).join('');
  selectedGroup = ordered.find(g => String(g.group_id) === String(options.groupId)) || ordered[0];
  liveGroupSelect.value = selectedGroup.group_id;
  loadGroup(selectedGroup.group_id, {
    autoPredictId: options.participantId,
    predictionOnly: Boolean(options.participantId),
  });
}

async function loadGroup(groupId = liveGroupSelect.value, options = {}) {
  if (!groupId) return;
  const seq = ++groupRequestSeq;
  livePredictionSection.style.display = 'none';
  selectedGroup = { group_id: groupId, group_name: liveGroupSelect.options[liveGroupSelect.selectedIndex]?.textContent || '' };
  livePlayersPanel.style.display = options.predictionOnly ? 'none' : 'block';
  if (!options.predictionOnly) showMessage(livePlayersPanel, '正在同步本组选手和对阵表');
  refreshLiveGroupBtn.disabled = true;

  try {
    const params = new URLSearchParams({ group_id: groupId });
    const resp = await fetch(`/api/live-group?${params}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '本组加载失败');
    if (seq !== groupRequestSeq) return;
    renderGroupPlayers(data, options);
  } catch (err) {
    if (seq === groupRequestSeq) {
      livePlayersPanel.style.display = 'block';
      showMessage(livePlayersPanel, `本组加载失败：${err.message}`);
    }
  } finally {
    if (seq === groupRequestSeq) refreshLiveGroupBtn.disabled = false;
  }
}

function renderGroupPlayers(data, options = {}) {
  const players = data.players || [];
  if (!players.length) {
    livePlayersPanel.style.display = 'block';
    showMessage(livePlayersPanel, '本组暂未读到选手');
    return;
  }

  if (options.predictionOnly && options.autoPredictId) {
    startPrediction(options.autoPredictId);
    return;
  }

  const rows = players.map(p => `
    <tr>
      <td>${p.cloud_rank || p.rank || ''}</td>
      <td><button type="button" class="live-player-link" data-player-id="${esc(p.id)}" data-player-name="${esc(p.name)}">${esc(p.name)}</button><div class="opponent-org">${esc(p.org || '')}</div></td>
      <td>${p.score}</td>
      <td>${p.opponent_score}</td>
      <td>${p.total_score}</td>
      <td>${p.win || 0}-${p.lose || 0}${p.draw ? `-${p.draw}` : ''}</td>
    </tr>
  `).join('');

  livePlayersPanel.innerHTML = `
    <div class="live-panel-heading">
      <div>
        <div class="live-panel-title">当前名次</div>
        <div class="live-muted">已完成 ${data.completed_rounds || 0}/${data.total_rounds || 0} 轮，已知对阵至第 ${data.known_pairing_rounds || 0} 轮</div>
      </div>
    </div>
    <table class="live-table">
      <thead><tr><th>名次</th><th>选手</th><th>大分</th><th>小分</th><th>总得分</th><th>胜负</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  livePlayersPanel.querySelectorAll('.live-player-link').forEach(btn => {
    btn.addEventListener('click', () => {
      window.open(buildPredictionUrl(btn.dataset.playerId, btn.dataset.playerName || ''), '_blank', 'noopener');
    });
  });
}

function buildPredictionUrl(participantId, playerName = '') {
  const params = new URLSearchParams({
    event_id: selectedEvent?.event_id || '',
    title: selectedEvent?.title || '',
    date: selectedEvent?.date || '',
    province: selectedEvent?.province || '',
    city: selectedEvent?.city || '',
    organizer: selectedEvent?.organizer || '',
    detail_url: selectedEvent?.detail_url || '',
    group_id: liveGroupSelect.value || selectedGroup?.group_id || '',
    participant_id: participantId,
    player_name: playerName,
  });
  return `live-prediction.html?${params}`;
}

async function startPrediction(participantId) {
  const seq = ++predictionRequestSeq;
  livePredictionSection.style.display = 'block';
  showMessage(livePredictionPanel, '正在同步计算名次概率');

  try {
    const params = new URLSearchParams({
      group_id: liveGroupSelect.value,
      participant_id: participantId,
      simulations: '3000',
    });
    const resp = await fetch(`/api/live-prediction?${params}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '预测失败');
    if (seq !== predictionRequestSeq) return;
    renderPrediction(data);
  } catch (err) {
    if (seq === predictionRequestSeq) showMessage(livePredictionPanel, `预测失败：${err.message}`);
  }
}

function renderPrediction(data) {
  const items = data.probabilities || [];
  const rows = items.map(item => `
    <tr>
      <td>第 ${item.rank} 名</td>
      <td>${pct(item.probability)}</td>
      <td>${item.count}/${data.simulations}</td>
    </tr>
  `).join('');
  const current = data.current || {};

  livePredictionPanel.innerHTML = `
    <div class="live-panel-heading">
      <div>
        <div class="live-panel-title">${esc(data.player?.name || '')} 的最终名次概率</div>
        <div class="live-muted">当前第 ${current.cloud_rank || current.rank || '-'} 名 · 大分 ${current.score ?? '-'} · 小分 ${current.opponent_score ?? '-'} · 总得分 ${current.total_score ?? '-'}</div>
      </div>
    </div>
    <table class="live-table live-prob-table">
      <thead><tr><th>可能名次</th><th>概率</th><th>模拟次数</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="live-note">模型：已公布对阵按真实对阵模拟，未公布轮次按简化瑞士制配对；单盘按等强 50/50 估计。</div>`;
}

loadLiveEventsBtn.addEventListener('click', loadLiveEvents);
liveGroupSelect.addEventListener('change', () => loadGroup(liveGroupSelect.value));
refreshLiveGroupBtn.addEventListener('click', () => loadGroup(liveGroupSelect.value));

function initFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const eventId = params.get('event_id');
  if (!eventId) {
    liveEventsSection.style.display = 'none';
    return;
  }

  if (liveToolbar) liveToolbar.style.display = 'none';
  liveEventsSection.style.display = 'none';
  if (backToLiveList) backToLiveList.style.display = 'inline-flex';
  const groupId = params.get('group_id') || '';
  const participantId = params.get('participant_id') || '';
  predictionOnlyPage = Boolean(groupId && participantId);
  const event = {
    event_id: eventId,
    title: params.get('title') || `比赛 ${eventId}`,
    date: params.get('date') || '',
    province: params.get('province') || '',
    city: params.get('city') || '',
    organizer: params.get('organizer') || '',
    detail_url: params.get('detail_url') || `https://www.yunbisai.com/tpl/eventFeatures/eventDetail-${eventId}.html`,
  };
  if (predictionOnlyPage) {
    document.title = `${params.get('player_name') || '选手'} · 名次概率预测`;
  }
  selectEvent(event, { groupId, participantId });
}

initFromUrl();
