'use strict';
const { requestContext } = require('./api-security');

function limitError(code, message, status = 503) {
  return Object.assign(new Error(message), { code, status, name: code === 'ABORTED' ? 'AbortError' : 'Error' });
}

function createLimiter({ concurrency, maxQueue, timeoutMs }) {
  let active = 0;
  const queue = [];
  function drain() {
    while (active < concurrency && queue.length) {
      const task = queue.shift();
      if (task.controller.signal.aborted) continue;
      active++;
      Promise.resolve().then(() => task.fn(task.controller.signal)).then(task.resolve, task.reject)
        .finally(() => { active--; task.cleanup(); drain(); });
    }
  }
  return (fn, { signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(limitError('ABORTED', '请求已取消', 499));
    if (active >= concurrency && queue.length >= maxQueue) return reject(limitError('BUSY', '服务繁忙，请稍后重试'));
    const controller = new AbortController();
    let settled = false;
    const finish = callback => value => { if (!settled) { settled = true; callback(value); } };
    const task = { fn, controller, resolve: finish(resolve), reject: finish(reject), cleanup };
    function cancel(error) {
      controller.abort(error);
      const index = queue.indexOf(task);
      if (index >= 0) queue.splice(index, 1);
      task.reject(error);
      cleanup();
    }
    const onAbort = () => cancel(limitError('ABORTED', '请求已取消', 499));
    const timer = setTimeout(() => cancel(limitError('TIMEOUT', '请求超时，请稍后重试', 504)), timeoutMs);
    function cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
    signal?.addEventListener('abort', onAbort, { once: true });
    queue.push(task);
    drain();
  });
}

const upstream = createLimiter({ concurrency: 8, maxQueue: 64, timeoutMs: 30000 });
async function limitedFetch(fetchImpl, url, options = {}) {
  const signals = [options.signal, requestContext.getStore()].filter(Boolean);
  return upstream(async signal => {
    const response = await fetchImpl(url, { ...options, signal, timeout: options.timeout || 15000, size: 5 * 1024 * 1024 });
    const body = await response.text();
    return { ok: response.ok, status: response.status, headers: response.headers, url: response.url,
      text: async () => body, json: async () => JSON.parse(body) };
  }, { signal: signals.length ? AbortSignal.any(signals) : undefined });
}

module.exports = { createLimiter, limitedFetch, limitError };
