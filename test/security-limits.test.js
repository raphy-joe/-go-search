'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');
const {createLimiter}=require('../resource-limits');
const {validateQuery,securityHeaders,createRequestBudget}=require('../api-security');
const response=()=>Object.assign(new EventEmitter(),{headers:{},statusCode:200,setHeader(k,v){this.headers[k]=v},
  status(code){this.statusCode=code;return this},json(data){this.body=data;this.emit('finish');return this},end(){this.emit('finish')}});

test('query validation rejects unbounded rounds, nested parameters and invalid dates',()=>{
  for(const query of [{rounds:'999999999'},{rounds:'1.5'},{rounds:'-1'},{group_id:'../1'},{name:['A','B']},
    {name:'x'.repeat(65)},{dateFrom:'2026-02-30'},{dateFrom:'2026-09-01',dateTo:'2026-08-01'},{simulations:'9000'}]){
    const res=response();let next=false;validateQuery({query,path:'/matches'},res,()=>next=true);
    assert.equal(res.statusCode,400);assert.equal(next,false);
  }
});
test('valid bounded requests and unicode names are accepted',()=>{
  let next=false;validateQuery({query:{name:'牛欣琦',rounds:'10',total_rounds:'10',dateTo:'2026-09-28'},path:'/matches'},response(),()=>next=true);
  assert.equal(next,true);
});
test('security headers work over HTTP without forcing unavailable HTTPS',()=>{
  const res=response();securityHeaders({secure:false},res,()=>{});
  assert.equal(res.headers['X-Frame-Options'],'DENY');assert.match(res.headers['Content-Security-Policy'],/script-src 'self'/);
  assert.equal(res.headers['Strict-Transport-Security'],undefined);
});
test('resource queue rejects overload, releases slots and handles cancellation',async()=>{
  const run=createLimiter({concurrency:1,maxQueue:1,timeoutMs:1000});let release;
  const first=run(()=>new Promise(r=>release=r));await Promise.resolve();
  const controller=new AbortController();const second=run(()=>42,{signal:controller.signal});
  await assert.rejects(run(()=>43),e=>e.code==='BUSY');
  controller.abort();await assert.rejects(second,e=>e.code==='ABORTED');release(1);assert.equal(await first,1);
  assert.equal(await run(()=>2),2);
});
test('resource timeouts abort running work',async()=>{
  const run=createLimiter({concurrency:1,maxQueue:0,timeoutMs:15});let aborted=false;
  await assert.rejects(run(signal=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason)}))),e=>e.code==='TIMEOUT');
  assert.equal(aborted,true);
});
test('HTTP concurrency budget cancels disconnected work and frees capacity',()=>{
  const middleware=createRequestBudget({maxActive:1,perIp:1,timeoutMs:1000});
  const a=response(),b=response(),req={ip:'1'};middleware(req,a,()=>{});middleware({ip:'1'},b,()=>{});
  assert.equal(b.statusCode,503);a.emit('close');assert.equal(req.workSignal.aborted,true);
  const c=response();let next=false;middleware({ip:'1'},c,()=>next=true);assert.equal(next,true);c.emit('finish');
});
