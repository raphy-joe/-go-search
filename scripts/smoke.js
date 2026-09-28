'use strict';
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {once}=require('node:events');
async function smoke(origin) {
  const request=async (route,status=200)=>{
    const res=await fetch(new URL(route,origin),{redirect:'error',signal:AbortSignal.timeout(15000)});
    assert.equal(res.status,status,route);
    assert.ok(res.headers.get('content-security-policy'),`${route}: CSP missing`);
    return res;
  };
  assert.equal((await (await request('/healthz')).json()).status,'ok');
  for(const page of ['/index.html','/head-to-head.html','/live-prediction.html']) {
    assert.match(await (await request(page)).text(),/<html/);
  }
  assert.equal(typeof (await (await request('/api/system-status')).json()).coverage,'number');
  await request('/api/live-event?event_id=invalid',400);
  const admin=await fetch(new URL('/api/ops/status',origin),{signal:AbortSignal.timeout(15000)});
  assert.ok([401,503].includes(admin.status),'Admin endpoint must not allow anonymous requests');
  console.log('Smoke passed: health, pages, security headers, status, validation, admin protection');
}
async function local() {
  const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'go-search-smoke-'));
  const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),windowsHide:true,
    env:{...process.env,PORT:String(port),DATA_DIR:data,BACKGROUND_TASKS_DISABLED:'1',SEARCH_AUTO_BACKFILL:'0'},stdio:'ignore'});
  const exited=once(child,'exit');
  const origin=`http://127.0.0.1:${port}`;
  try {
    for(let i=0;i<100;i++) {
      if(child.exitCode!==null) throw new Error('Preview server exited before readiness');
      try {const response=await fetch(`${origin}/healthz`,{signal:AbortSignal.timeout(1000)});if(response.ok) break;} catch (_) {}
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    await smoke(origin);
  } finally {
    if(child.exitCode===null) child.kill();
    await exited;
    // Only this process's fresh temporary database is removed.
    if(path.dirname(path.resolve(data))!==path.resolve(os.tmpdir()) || !path.basename(data).startsWith('go-search-smoke-')) throw new Error('Unsafe temporary cleanup path');
    fs.rmSync(data,{recursive:true,force:true});
  }
}
if(require.main===module) (process.argv[2]==='--local'?local():smoke(process.argv[2]||'http://127.0.0.1:3000'))
  .catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={smoke};
