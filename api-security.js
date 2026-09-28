'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const requestContext = new AsyncLocalStorage();

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value);
}

function validateQuery(req, res, next) {
  const q = req.query || {};
  const fail = () => res.status(400).json({ code: 'INVALID_QUERY', error: '查询参数不正确，请检查姓名、日期和轮次' });
  for (const [key, value] of Object.entries(q)) {
    if (typeof value !== 'string' || value.length > 256) return fail();
    if (['name','playerA','playerB'].includes(key) && (!value.trim() || value.length > 64)) return fail();
    if (key === 'province' && value.length > 32) return fail();
    if (key === 'ranking_rule' && !['cloud-total-score','score-opponent-score'].includes(value)) return fail();
    if (key === 'seed' && !/^[\w:.-]{1,160}$/.test(value)) return fail();
    if (['event_id','group_id','participant_id','player_id'].includes(key) && !/^\d{1,15}$/.test(value)) return fail();
    if (['dateFrom','dateTo'].includes(key) && !validDate(value)) return fail();
    const bounds = { rounds:[1,30], total_rounds:[0,30], simulations:[200,8000], limit:[1,600], yearFrom:[1900,2100], yearTo:[1900,2100] }[key];
    if (bounds && (!/^\d+$/.test(value) || Number(value) < bounds[0] || Number(value) > bounds[1])) return fail();
  }
  if (q.dateFrom && q.dateTo && q.dateFrom > q.dateTo) return fail();
  if (req.path === '/live-events' && q.dateFrom && q.dateTo
    && (Date.parse(q.dateTo) - Date.parse(q.dateFrom)) / 86400000 > 31) return fail();
  next();
}

function createRequestBudget({ maxActive = 16, perIp = 6, timeoutMs = 60000 } = {}) {
  let active = 0;
  const ips = new Map();
  return (req, res, next) => {
    const ip = String(req.ip || 'unknown');
    if (active >= maxActive || (ips.get(ip) || 0) >= perIp) {
      res.setHeader('Retry-After', '3');
      return res.status(503).json({ code: 'BUSY', error: '服务繁忙，请稍后重试' });
    }
    active++;
    ips.set(ip, (ips.get(ip) || 0) + 1);
    const controller = new AbortController();
    req.workSignal = controller.signal;
    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      active--;
      const left = (ips.get(ip) || 1) - 1;
      if (left) ips.set(ip, left); else ips.delete(ip);
      controller.abort();
    }
    const timer = setTimeout(() => {
      if (!res.headersSent) res.status(504).json({ code: 'TIMEOUT', error: '查询超时，请稍后重试' });
      else res.end();
      finish();
    }, timeoutMs);
    res.once('close', finish);
    res.once('finish', finish);
    requestContext.run(controller.signal, next);
  };
}

function sendApiError(res, error, fallback = '数据暂时读取失败，请稍后重试') {
  if (res.headersSent || res.destroyed) return;
  const expected = ['BUSY','TIMEOUT','INCOMPLETE_PREDICTION_DATA','IDENTITY_REQUIRED','INVALID_IDENTITY'].includes(error.code);
  res.status(expected ? error.status || 502 : 502).json({
    code: expected ? error.code : 'UPSTREAM_UNAVAILABLE', error: expected ? error.message : fallback,
  });
}

module.exports = { securityHeaders, validateQuery, createRequestBudget, requestContext, sendApiError };
