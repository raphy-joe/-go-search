'use strict';

window.PageView = {
  update(values) {
    const url = new URL(location.href);
    for (const [key,value] of Object.entries(values)) {
      if (value === '' || value === null || value === undefined) url.searchParams.delete(key);
      else url.searchParams.set(key,String(value));
    }
    history.replaceState(history.state, '', url);
  },
  restoreScroll() {
    const top = Number(history.state?.scrollY);
    if (top > 0) requestAnimationFrame(() => window.scrollTo(0,top));
  },
  resetScroll() { history.replaceState({...history.state,scrollY:0},'',location.href); },
  score(value) {
    return value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? '--'
      : new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(Number(value));
  },
};
addEventListener('pagehide', () => history.replaceState({...history.state,scrollY:scrollY},'',location.href));
for (const button of document.querySelectorAll('[data-copy-query]')) {
  button.addEventListener('click',async()=>{
    const status = document.querySelector('[data-link-status]');
    try {
      await navigator.clipboard.writeText(location.href);
      if (status) status.textContent='查询链接已复制';
    } catch (_) { if(status) status.textContent='链接已保存在地址栏，可从地址栏复制'; }
  });
}

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

    const coverage = Math.floor((Number(data.coverage) || 0) * 1000) / 10;
    const updatedAt = data.last_updated ? new Date(data.last_updated) : null;
    const updatedLabel = updatedAt && !Number.isNaN(updatedAt.getTime())
      ? updatedAt.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      : '未知';
    const age = updatedAt ? Date.now() - updatedAt.getTime() : Infinity;
    const failed = Number(data.failed_events || 0) + Number(data.partial_events || 0);
    const warning = failed > 0 || coverage < 100 || age > 48 * 60 * 60 * 1000;
    const text = data.indexer_running
      ? `索引更新中 · ${coverage}%`
      : `索引 ${coverage}%${failed ? ` · ${failed} 场待修复` : ''} · 更新 ${updatedLabel}`;
    const detail = `有效索引 ${data.indexed_events || 0} / ${data.events || 0} 场；失败 ${data.failed_events || 0} 场，部分完成 ${data.partial_events || 0} 场，待刷新 ${data.stale_events || 0} 场。更新时间为最近一次成功，并不代表每场都已更新。`;
    setStatus(text, detail, warning);
  } catch (_) {
    setStatus('数据状态暂不可用', '无法读取赛事索引状态', true);
  }
})();
