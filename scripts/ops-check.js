'use strict';
async function check(origin,token) {
  const url=new URL(origin);
  if(!token) throw new Error('Set ADMIN_TOKEN before running the authenticated operations check');
  if(url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) {
    throw new Error('Admin credentials require HTTPS or a loopback SSH tunnel');
  }
  const response=await fetch(new URL('/api/ops/status',url),{headers:{authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error(`Operations endpoint returned HTTP ${response.status}`);
  const report=await response.json();
  if(!Array.isArray(report.alerts)) throw new Error('Unexpected operations response');
  return report;
}
if(require.main===module) check(process.argv[2]||'http://127.0.0.1:3000',process.env.ADMIN_TOKEN).then(report=>{
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.alerts.some(a=>a.severity==='critical')?2:report.alerts.length?1:0;
}).catch(e=>{console.error(e.message);process.exitCode=2;});
module.exports={check};
