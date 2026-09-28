'use strict';
const { randomUUID } = require('node:crypto');

function createTelemetry({ log = value => console.warn(JSON.stringify(value)), clock = () => Date.now() } = {}) {
  const routes = new Map();
  function middleware(req,res,next) {
    const started=clock(),id=randomUUID();
    res.setHeader('X-Request-Id',id);
    const route=/^\/api\/[a-z-]+$/.test(req.path) ? req.path : 'other';
    res.once('finish',()=>{
      const elapsed=Math.max(0,clock()-started);
      if(!routes.has(route) && routes.size<40) routes.set(route,{count:0,errors:0,samples:[]});
      const entry=routes.get(route);
      if(entry) { entry.count++;if(res.statusCode>=500) entry.errors++;entry.samples.push({elapsed,error:res.statusCode>=500});if(entry.samples.length>500) entry.samples.shift(); }
      if(res.statusCode>=500 || elapsed>5000) log({type:'request-alert',request_id:id,route,status:res.statusCode,duration_ms:elapsed});
    });
    next();
  }
  function snapshot() {
    return [...routes].map(([route,v])=>{const sorted=v.samples.map(s=>s.elapsed).sort((a,b)=>a-b);return {route,count:v.count,errors:v.errors,
      error_rate:v.samples.length?v.samples.filter(s=>s.error).length/v.samples.length:0,p95_ms:sorted[Math.max(0,Math.ceil(sorted.length*.95)-1)]||0,sample_count:sorted.length};});
  }
  return {middleware,snapshot};
}

function healthAlerts({coverage,cache,requests}, now=Date.now()) {
  const alerts=[];
  const failures=(coverage.failedEventCount||0)+(coverage.partialEventCount||0);
  if(failures) alerts.push({code:'INDEX_INCOMPLETE',severity:'warning',count:failures});
  if(cache.missing_round_groups) alerts.push({code:'CACHE_MISSING_ROUNDS',severity:'critical',count:cache.missing_round_groups});
  if(!coverage.lastSuccessAt || now-coverage.lastSuccessAt>48*3600000) alerts.push({code:'STALE_INDEX',severity:'warning'});
  for(const route of requests) {
    if(route.count>=10 && route.error_rate>.05) alerts.push({code:'REQUEST_ERRORS',severity:'critical',route:route.route});
    if(route.sample_count>=10 && route.p95_ms>10000) alerts.push({code:'REQUEST_LATENCY',severity:'warning',route:route.route});
  }
  return alerts;
}
module.exports={createTelemetry,healthAlerts};
