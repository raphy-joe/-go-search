'use strict';

(async function showSystemStatus() {
  const targets = [...document.querySelectorAll('[data-system-status]')];
  if (!targets.length) return;

  const setStatus = (text, detail = '', warning = false) => {
    targets.forEach(target => {
      target.textContent = text;
      target.title = detail;
      target.closest('.sidebar-note')?.classList.toggle('sidebar-note--warning', warning);
    });
  };

  try {
    const response = await fetch('/api/system-status', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'status unavailable');

    const coverage = Math.round((Number(data.coverage) || 0) * 100);
    const updatedAt = data.last_updated ? new Date(data.last_updated) : null;
    const updatedLabel = updatedAt && !Number.isNaN(updatedAt.getTime())
      ? updatedAt.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      : '未知';
    const age = updatedAt ? Date.now() - updatedAt.getTime() : Infinity;
    const warning = coverage < 90 || age > 48 * 60 * 60 * 1000;
    const text = data.indexer_running
      ? `索引更新中 · ${coverage}%`
      : `索引 ${coverage}% · 更新 ${updatedLabel}`;
    const detail = `已索引 ${data.indexed_events || 0} / ${data.events || 0} 场赛事`;
    setStatus(text, detail, warning);
  } catch (_) {
    setStatus('数据状态暂不可用', '无法读取赛事索引状态', true);
  }
})();
