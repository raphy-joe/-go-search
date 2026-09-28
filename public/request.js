'use strict';

async function requestJson(url, { signal, timeoutMs = 65000, ...options } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json();
    if (!response.ok) {
      throw Object.assign(new Error(data.error || '查询失败，请重试'), {
        code: data.code, status: response.status, data,
      });
    }
    return data;
  } catch (error) {
    if (timedOut) throw new Error('查询超时，请稍后重试');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
