'use strict';

function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

function retryable(error) {
  if (error.name === 'AbortError' || ['ABORTED', 'INVALID_UPSTREAM_RESPONSE'].includes(error.code)) return false;
  return [408, 429, 500, 502, 503, 504].includes(error.status)
    || /timeout|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ENOTFOUND/i.test(error.message);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      reject(Object.assign(new Error('Request cancelled'), { name: 'AbortError' })); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
    if (signal?.aborted) aborted();
    else signal?.addEventListener('abort', aborted, { once: true });
  });
}

async function fetchTextWithRetry(fetchImpl, url, options = {}, retries = 1, { wait = sleep, random = Math.random } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetchImpl(url, options);
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), {
        status: response.status, retryAfterMs: retryAfterMs(response.headers?.get('retry-after')),
      });
      return await response.text();
    } catch (error) {
      if (options.signal?.aborted || attempt >= retries || !retryable(error)) throw error;
      const backoff = Math.min(8000, 500 * 2 ** attempt) + Math.floor(random() * 300);
      const delay = Math.max(backoff, error.retryAfterMs || 0);
      // Long server cooldowns should fail fast, not tie up an interactive request.
      if (delay > 10000) throw error;
      await wait(delay, options.signal);
    }
  }
}

function createCircuitBreaker({ now = Date.now, threshold = 4, cooldownMs = 15000 } = {}) {
  const origins = new Map();
  function entry(origin) {
    if (!origins.has(origin)) origins.set(origin, { failures: 0, until: 0, probing: false });
    return origins.get(origin);
  }
  return {
    before(origin) {
      const state = entry(origin);
      if (state.until > now() || state.probing) throw Object.assign(new Error('上游暂时不可用，请稍后重试'), {
        code: 'UPSTREAM_COOLDOWN', status: 503, retryAfterMs: Math.max(1000, state.until - now()),
      });
      if (state.failures >= threshold || state.until) state.probing = true;
    },
    success(origin) {
      if ((origins.get(origin)?.until || 0) <= now()) origins.delete(origin);
    },
    failure(origin, error) {
      const state = entry(origin); state.probing = false;
      if (!retryable(error)) {
        if (state.until <= now()) origins.delete(origin);
        return;
      }
      state.failures++;
      if (error.status === 429 || error.retryAfterMs || state.failures >= threshold) {
        state.until = Math.max(state.until, now() + (error.status === 429 ? Math.max(1000, error.retryAfterMs || cooldownMs)
          : Math.max(cooldownMs, error.retryAfterMs || 0)));
      }
    },
    snapshot() { return [...origins].map(([origin, state]) => ({ origin, failures: state.failures, retry_at: state.until })); },
  };
}

const combineSignals = (...signals) => {
  const present = signals.filter(Boolean);
  return present.length ? AbortSignal.any(present) : undefined;
};
module.exports = { fetchTextWithRetry, retryAfterMs, retryable, sleep, createCircuitBreaker, combineSignals };
