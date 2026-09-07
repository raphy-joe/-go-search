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
let selectedTotalRounds = 0;
let hasManualTotalRounds = false;
let selectedNextResult = '';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pct(value) {
  return `${Math.round((Number(value) || 0) * 1000) / 10}%`;
}

function formatSnapshotTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function normalizeTotalRounds(value) {
  const parsed = parseInt(value, 10);
  return parsed > 0 ? Math.min(parsed, 30) : 0;
}

function eventTotalRoundsStorageKey(eventId) {
  return eventId ? `goSearch.liveTotalRounds.${eventId}` : '';
}

function readStoredEventTotalRounds(eventId) {
  const key = eventTotalRoundsStorageKey(eventId);
  if (!key) return 0;
  try {
    return normalizeTotalRounds(window.localStorage.getItem(key));
  } catch (_) {
    return 0;
  }
}

function persistEventTotalRounds(value) {
  const key = eventTotalRoundsStorageKey(selectedEvent?.event_id);
  if (!key) return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch (_) {
    // The URL still carries the setting when browser storage is unavailable.
  }
}

function syncTotalRoundsInCurrentUrl(value) {
  const params = new URLSearchParams(window.location.search);
  if (!params.get('event_id')) return;
  params.set('total_rounds', String(value));
  window.history.replaceState(null, '', `${window.location.pathname}?${params}${window.location.hash}`);
}

function initializeEventTotalRounds(event) {
  const linkedRounds = normalizeTotalRounds(event?.total_rounds);
  const storedRounds = readStoredEventTotalRounds(event?.event_id);
  selectedTotalRounds = Math.max(linkedRounds, storedRounds);
  hasManualTotalRounds = selectedTotalRounds > 0;
  if (selectedEvent && selectedTotalRounds) selectedEvent.total_rounds = selectedTotalRounds;
}

function applyConfiguredEventTotalRounds(value) {
  const configuredRounds = normalizeTotalRounds(value);
  if (!configuredRounds || configuredRounds <= selectedTotalRounds) return;
  selectedTotalRounds = configuredRounds;
  hasManualTotalRounds = true;
  if (selectedEvent) selectedEvent.total_rounds = selectedTotalRounds;
  persistEventTotalRounds(selectedTotalRounds);
  syncTotalRoundsInCurrentUrl(selectedTotalRounds);
}

function showMessage(target, message) {
  target.innerHTML = `<div class="state-msg">${esc(message)}</div>`;
}

async function loadLiveEvents() {
  const province = liveProvinceSelect.value;
  if (!province) {
    liveProvinceSelect.setCustomValidity('请选择省份');
    liveProvinceSelect.reportValidity();
    liveProvinceSelect.focus();
    return;
  }
  liveProvinceSelect.setCustomValidity('');
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
    const resp = await fetch(`/api/live-events?${params}`, { cache: 'no-store' });
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
  const totalRounds = normalizeTotalRounds(event.total_rounds);
  if (totalRounds) params.set('total_rounds', String(totalRounds));
  return `live-prediction.html?${params}`;
}

async function selectEvent(event, options = {}) {
  selectedEvent = event;
  initializeEventTotalRounds(event);
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
    const resp = await fetch(`/api/live-event?${params}`, { cache: 'no-store' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '组别加载失败');
    applyConfiguredEventTotalRounds(data.total_rounds);
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
    if (selectedTotalRounds) params.set('total_rounds', String(selectedTotalRounds));
    const resp = await fetch(`/api/live-group?${params}`, { cache: 'no-store' });
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

function getMinimumTotalRounds(data) {
  return Math.max(
    Number(data.completed_rounds) || 0,
    Number(data.known_pairing_rounds) || 0,
    1,
  );
}

function applyTotalRoundsValue(rawValue, minimumRounds, manual = true) {
  const parsed = parseInt(rawValue, 10);
  selectedTotalRounds = Math.min(Math.max(parsed || minimumRounds, minimumRounds), 30);
  if (manual) {
    hasManualTotalRounds = true;
    if (selectedEvent) selectedEvent.total_rounds = selectedTotalRounds;
    persistEventTotalRounds(selectedTotalRounds);
    syncTotalRoundsInCurrentUrl(selectedTotalRounds);
  }
  return selectedTotalRounds;
}

function prepareTotalRounds(data) {
  const minimumRounds = getMinimumTotalRounds(data);
  if (hasManualTotalRounds) {
    applyTotalRoundsValue(selectedTotalRounds, minimumRounds, false);
  } else {
    applyTotalRoundsValue(data.total_rounds, minimumRounds, false);
  }
  return minimumRounds;
}

function renderTotalRoundsEditor(id, minimumRounds) {
  return `
    <label class="live-round-editor" for="${id}">
      <span>总轮次</span>
      <input id="${id}" class="live-round-input" type="number" inputmode="numeric" min="${minimumRounds}" max="30" step="1" value="${selectedTotalRounds}" aria-label="总轮次">
    </label>`;
}

function bindTotalRoundsEditor(id, minimumRounds) {
  const input = document.getElementById(id);
  if (!input) return null;
  const update = () => {
    input.value = String(applyTotalRoundsValue(input.value, minimumRounds));
  };
  input.addEventListener('change', update);
  return input;
}

function readSelectedTotalRounds() {
  const input = document.getElementById('liveTotalRoundsInput')
    || document.getElementById('livePredictionTotalRoundsInput');
  if (input) {
    const minimumRounds = parseInt(input.min, 10) || 1;
    return applyTotalRoundsValue(input.value, minimumRounds);
  }
  return selectedTotalRounds || 0;
}

function renderGroupPlayers(data, options = {}) {
  const players = data.players || [];
  if (!players.length) {
    livePlayersPanel.style.display = 'block';
    showMessage(livePlayersPanel, '本组暂未读到选手');
    return;
  }

  const minimumRounds = prepareTotalRounds(data);
  const snapshotLabel = formatSnapshotTime(data.snapshot_at);
  if (options.predictionOnly && options.autoPredictId) {
    startPrediction(options.autoPredictId);
    return;
  }

  const rows = players.map(p => `
    <tr>
      <td>${p.display_rank || p.cloud_rank || p.rank || ''}</td>
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
        <div class="live-round-summary">
          <div class="live-muted">已完成 ${data.completed_rounds || 0} 轮 · 已知对阵至第 ${data.known_pairing_rounds || 0} 轮${data.score_updates_applied ? ` · 积分已按第 ${data.score_updated_through_round || data.completed_rounds} 轮赛果更新` : ''}${snapshotLabel ? ` · 数据 ${snapshotLabel}` : ''}</div>
          ${renderTotalRoundsEditor('liveTotalRoundsInput', minimumRounds)}
        </div>
      </div>
    </div>
    <table class="live-table">
      <thead><tr><th>名次</th><th>选手</th><th>大分</th><th>小分</th><th>总得分</th><th>胜负</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  bindTotalRoundsEditor('liveTotalRoundsInput', minimumRounds);
  livePlayersPanel.querySelectorAll('.live-player-link').forEach(btn => {
    btn.addEventListener('click', () => {
      readSelectedTotalRounds();
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
    total_rounds: readSelectedTotalRounds(),
  });
  return `live-prediction.html?${params}`;
}

function normalizeNextResult(value) {
  return ['win', 'loss'].includes(value) ? value : '';
}

function setPredictionBusy(isBusy, message = '') {
  livePredictionPanel.classList.toggle('is-updating', isBusy);
  livePredictionPanel.querySelectorAll('button, input').forEach(control => {
    control.disabled = isBusy;
  });
  const status = document.getElementById('liveScenarioStatus');
  if (status && message) status.textContent = message;
}

async function startPrediction(participantId, nextResult = selectedNextResult, options = {}) {
  const seq = ++predictionRequestSeq;
  const previousNextResult = selectedNextResult;
  const normalizedResult = normalizeNextResult(nextResult);
  selectedNextResult = normalizedResult;
  livePredictionSection.style.display = 'block';
  const preservePanel = Boolean(options.preserve && livePredictionPanel.querySelector('.live-next-opponent'));
  if (preservePanel) {
    const label = normalizedResult === 'win' ? '本局胜' : normalizedResult === 'loss' ? '本局负' : '未设定赛果';
    setPredictionBusy(true, `正在按${label}重新计算...`);
  } else {
    showMessage(livePredictionPanel, '正在同步下一轮对阵并计算名次概率');
  }

  try {
    const params = new URLSearchParams({
      group_id: liveGroupSelect.value,
      participant_id: participantId,
      simulations: '3000',
    });
    const totalRounds = readSelectedTotalRounds();
    if (totalRounds) params.set('total_rounds', String(totalRounds));
    if (normalizedResult) params.set('next_result', normalizedResult);
    const resp = await fetch(`/api/live-prediction?${params}`, { cache: 'no-store' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '预测失败');
    if (seq !== predictionRequestSeq) return;
    renderPrediction(data);
  } catch (err) {
    if (seq !== predictionRequestSeq) return;
    if (preservePanel) {
      selectedNextResult = previousNextResult;
      setPredictionBusy(false, `更新失败：${err.message}`);
    } else {
      showMessage(livePredictionPanel, `预测失败：${err.message}`);
    }
  } finally {
    if (seq === predictionRequestSeq) setPredictionBusy(false);
  }
}

function renderPrediction(data) {
  const items = data.probabilities || [];
  const rows = items.map(item => {
    const probability = Math.max(0, Math.min(1, Number(item.probability) || 0));
    const barWidth = probability > 0 ? Math.max(2, probability * 100) : 0;
    return `
      <div class="live-probability-row" aria-label="第 ${item.rank} 名，概率 ${pct(probability)}，模拟 ${item.count}/${data.simulations} 次">
        <span class="live-probability-rank">第 ${item.rank} 名</span>
        <span class="live-probability-track" aria-hidden="true"><span class="live-probability-fill" style="width:${barWidth}%"></span></span>
        <span class="live-probability-value">${pct(probability)}</span>
      </div>`;
  }).join('');
  const current = data.current || {};
  const minimumRounds = getMinimumTotalRounds(data);
  applyTotalRoundsValue(data.total_rounds, minimumRounds, false);
  selectedNextResult = normalizeNextResult(data.next_result);
  const snapshotLabel = formatSnapshotTime(data.snapshot_at);
  const manualPairingRounds = (data.manual_pairing_rounds || []).map(Number);
  const nextPairingIsManual = Boolean(data.next_opponent) && manualPairingRounds.includes(Number(data.next_opponent.bout));
  const nextPairingSource = nextPairingIsManual ? '人工录入对阵' : '云比赛公布';
  const nextOpponent = data.next_opponent;
  const isBye = Boolean(nextOpponent?.is_bye);
  const nextRoundLabel = nextOpponent?.bout || data.next_bout;
  const opponentMeta = nextOpponent && !isBye ? [
    nextOpponent.org && nextOpponent.org !== '--' ? nextOpponent.org : '',
    nextOpponent.current_rank ? `当前第 ${nextOpponent.current_rank} 名` : '',
    `${nextOpponent.win || 0}胜${nextOpponent.lose || 0}负${nextOpponent.draw ? `${nextOpponent.draw}和` : ''}`,
    nextOpponent.score !== null && nextOpponent.score !== undefined ? `大分 ${nextOpponent.score}` : '',
  ].filter(Boolean).join(' · ') : '';
  const resultLabel = selectedNextResult === 'win' ? '本局胜' : selectedNextResult === 'loss' ? '本局负' : '未设定';
  const resultStatus = isBye
    ? '本轮轮空，已自动按胜局计入概率计算'
    : selectedNextResult
      ? `已固定 ${data.player?.name || '当前棋手'} ${resultLabel}，下方概率已更新`
      : '选择本局结果后，下方概率会自动更新';

  const resultOptions = [
    { value: '', label: '未设定' },
    { value: 'win', label: '本局胜' },
    { value: 'loss', label: '本局负' },
  ].map(option => `
    <button type="button" class="live-result-option ${selectedNextResult === option.value ? 'is-active' : ''} ${option.value ? `is-${option.value}` : ''}" data-next-result="${option.value}" aria-pressed="${selectedNextResult === option.value}">${option.label}</button>`).join('');

  const nextOpponentHtml = nextOpponent ? `
    <section class="live-next-opponent">
      <div class="live-next-label">下一轮对手 · ${nextPairingSource}</div>
      <div class="live-next-main">
        <span class="live-next-round">第 ${nextOpponent.bout} 轮</span>
        <strong>${esc(nextOpponent.name || '未知棋手')}</strong>
        ${nextOpponent.seat ? `<span class="live-next-seat">第 ${nextOpponent.seat} 台</span>` : ''}
      </div>
      ${opponentMeta ? `<div class="live-next-meta">${esc(opponentMeta)}</div>` : ''}
      ${isBye ? `
        <div id="liveScenarioStatus" class="live-scenario-status" aria-live="polite">${esc(resultStatus)}</div>
      ` : `
        <div class="live-result-scenario">
          <div class="live-result-copy">
            <span class="live-result-label">设定本局结果</span>
            <span class="live-muted">以 ${esc(data.player?.name || '当前棋手')} 为视角</span>
          </div>
          <div class="live-result-segment" role="group" aria-label="设定下一轮胜负结果">${resultOptions}</div>
          <div id="liveScenarioStatus" class="live-scenario-status" aria-live="polite">${esc(resultStatus)}</div>
        </div>
      `}
    </section>` : `
    <section class="live-next-opponent">
      <div class="live-next-label">下一轮对手</div>
      <div class="live-next-empty">${nextRoundLabel ? `云比赛暂未公布第 ${nextRoundLabel} 轮对阵` : '比赛已完成或暂无后续轮次'}${nextRoundLabel ? '，该轮将按瑞士制模拟配对。' : ''}</div>
    </section>`;

  const probabilityTitle = selectedNextResult ? `${resultLabel}后的最终名次模拟概率` : '最终名次模拟概率';
  livePredictionPanel.innerHTML = `
    <div class="live-panel-heading live-prediction-heading">
      <div>
        <div class="live-panel-title">${esc(data.player?.name || '')} 的名次预测</div>
        <div class="live-muted">当前第 ${current.display_rank || current.cloud_rank || current.rank || '-'} 名 · 大分 ${current.score ?? '-'} · 小分 ${current.opponent_score ?? '-'} · 总得分 ${current.total_score ?? '-'}${data.score_updates_applied ? ` · 已按第 ${data.score_updated_through_round || data.completed_rounds} 轮赛果更新` : ''}${snapshotLabel ? ` · 数据 ${snapshotLabel}` : ''}</div>
      </div>
      <div class="live-round-actions">
        ${renderTotalRoundsEditor('livePredictionTotalRoundsInput', minimumRounds)}
        <button id="recalculatePredictionBtn" type="button" class="btn-secondary">重新计算</button>
      </div>
    </div>
    ${nextOpponentHtml}
    <div class="live-probability-heading">
      <div class="live-panel-title">${probabilityTitle}</div>
      <div class="live-muted">${data.simulations} 次模拟</div>
    </div>
    <div class="live-probability-list">${rows}</div>
    <div class="live-note">已公布对阵按真实配对模拟；未公布轮次仅在概率计算中按简化瑞士制配对，不展示为正式对阵。${isBye ? '轮空自动按胜局计入，' : selectedNextResult ? `下一轮已固定为${resultLabel}，` : ''}其余单盘按等强 50/50 估计，结果仅供趋势判断。</div>`;

  const roundInput = bindTotalRoundsEditor('livePredictionTotalRoundsInput', minimumRounds);
  const recalculateBtn = document.getElementById('recalculatePredictionBtn');
  const recalculate = () => {
    if (roundInput) applyTotalRoundsValue(roundInput.value, minimumRounds);
    startPrediction(data.player.id, selectedNextResult, { preserve: true });
  };
  recalculateBtn?.addEventListener('click', recalculate);
  roundInput?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      recalculate();
    }
  });
  livePredictionPanel.querySelectorAll('[data-next-result]').forEach(button => {
    button.addEventListener('click', () => {
      const result = normalizeNextResult(button.dataset.nextResult);
      if (result === selectedNextResult) return;
      startPrediction(data.player.id, result, { preserve: true });
    });
  });
}

loadLiveEventsBtn.addEventListener('click', loadLiveEvents);
liveProvinceSelect.addEventListener('change', () => liveProvinceSelect.setCustomValidity(''));
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
  const totalRoundsParam = normalizeTotalRounds(params.get('total_rounds'));
  predictionOnlyPage = Boolean(groupId && participantId);
  const event = {
    event_id: eventId,
    title: params.get('title') || `比赛 ${eventId}`,
    date: params.get('date') || '',
    province: params.get('province') || '',
    city: params.get('city') || '',
    organizer: params.get('organizer') || '',
    detail_url: params.get('detail_url') || `https://www.yunbisai.com/tpl/eventFeatures/eventDetail-${eventId}.html`,
    total_rounds: totalRoundsParam,
  };
  if (predictionOnlyPage) {
    document.title = `${params.get('player_name') || '选手'} · 名次概率预测`;
  }
  selectEvent(event, { groupId, participantId });
}

initFromUrl();
