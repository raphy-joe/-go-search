'use strict';
const { requestContext } = require('./api-security');
const { createCircuitBreaker, retryAfterMs } = require('./upstream-client');

function limitError(code, message, status = 503) {
  return Object.assign(new Error(message), { code, status, name: code === 'ABORTED' ? 'AbortError' : 'Error' });
}

function createLimiter({ concurrency, maxQueue, timeoutMs, backgroundConcurrency = concurrency }) {
  let active = 0;
  let backgroundActive = 0;
  const queue = [];
  function drain() {
    while (active < concurrency && queue.length) {
      const index = queue.findIndex(task => task.priority !== 'background' || backgroundActive < backgroundConcurrency);
      if (index < 0) break;
      const [task] = queue.splice(index, 1);
      if (task.controller.signal.aborted) continue;
      active++;
      if (task.priority === 'background') backgroundActive++;
      Promise.resolve().then(() => task.fn(task.controller.signal)).then(task.resolve, task.reject)
        .finally(() => { active--; if (task.priority === 'background') backgroundActive--; task.cleanup(); drain(); });
    }
  }
  return (fn, { signal, priority = 'foreground' } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(limitError('ABORTED', '请求已取消', 499));
    const canStart = active < concurrency && (priority !== 'background' || backgroundActive < backgroundConcurrency);
    if (!canStart && queue.length >= maxQueue) return reject(limitError('BUSY', '服务繁忙，请稍后重试'));
    const controller = new AbortController();
    let settled = false;
    const finish = callback => value => { if (!settled) { settled = true; callback(value); } };
    const task = { fn, priority, controller, resolve: finish(resolve), reject: finish(reject), cleanup };
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
    if (priority === 'background') queue.push(task);
    else {
      const backgroundIndex = queue.findIndex(item => item.priority === 'background');
      queue.splice(backgroundIndex < 0 ? queue.length : backgroundIndex, 0, task);
    }
    drain();
  });
}

const upstream = createLimiter({ concurrency: 8, backgroundConcurrency: 4, maxQueue: 64, timeoutMs: 30000 });
const breaker = createCircuitBreaker();
async function limitedFetch(fetchImpl, url, options = {}) {
  const signals = [options.signal, requestContext.getStore()].filter(Boolean);
  return upstream(async signal => {
    const origin = new URL(url).origin;
    breaker.before(origin);
    try {
      const { priority, ...fetchOptions } = options;
      const response = await fetchImpl(url, { ...fetchOptions, signal, timeout: options.timeout || 15000, size: 5 * 1024 * 1024 });
      const body = await response.text();
      if (!response.ok) {
        const error = Object.assign(new Error(`HTTP ${response.status}`), { status: response.status,
          retryAfterMs: retryAfterMs(response.headers?.get('retry-after')) });
        breaker.failure(origin, error);
      } else breaker.success(origin);
      return { ok: response.ok, status: response.status, headers: response.headers, url: response.url,
        text: async () => body, json: async () => JSON.parse(body) };
    } catch (error) {
      breaker.failure(origin, error);
      throw error;
    }
  }, { signal: signals.length ? AbortSignal.any(signals) : undefined, priority: options.priority });
}

module.exports = { createLimiter, limitedFetch, limitError, upstreamHealth: () => breaker.snapshot() };
