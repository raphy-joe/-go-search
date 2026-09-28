'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { chromium } = require('playwright');
const { securityHeaders } = require('../api-security');

let browser, server, origin;
const root = path.resolve(__dirname, '..');
const errors = [];
before(async () => {
  const app = express();
  app.use(securityHeaders);
  app.use(express.static(path.join(root, 'public')));
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless:true, ...(process.platform === 'win32' ? {channel:'msedge'} : {}) });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  assert.deepEqual(errors, [], 'browser runtime errors');
});

const json = (route, body, status = 200) => route.fulfill({status, contentType:'application/json', body:JSON.stringify(body)});
const day = new Date().toISOString().slice(0,10);
const hit = (id, name, province) => ({type:'hit', event:{event_id:id,title:`${province}围棋段位赛`,date:day,province,
  city:'测试市',organizer:'围棋协会',detail_url:'https://m.yunbisai.com/event/1'},
  player:{name,group:'5段组',groupid:id,participantid:'11',win:4,lose:3,draw:0,org:'棋院',score:8,rank:2}});
const profile = (id, province) => ({id:`${id}:${id}:11`,label:province,orgs:['棋院'],event_count:1,date_from:day,date_to:day});
const sse = records => records.map(r => `data: ${JSON.stringify(r)}\n\n`).join('');

async function fixture(t, api) {
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  t.after(() => context.close());
  const calls = [];
  await context.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    calls.push(url);
    if (url.pathname === '/api/system-status') return json(route, {coverage:0.9,events:10,indexed_events:9,failed_events:1,last_updated:Date.now()});
    return api(route, url);
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) errors.push(message.text());
  });
  return {page, context, calls};
}

async function search(page, name='同名棋手') {
  await page.locator('#name').fill(name);
  await page.locator('#province').selectOption('__ALL__');
  await page.locator('#searchBtn').click();
  await page.waitForFunction(() => !document.getElementById('searchBtn').disabled);
}

test('search separates identities, rejects stale evaluations, and binds actions to result context', async t => {
  const {page,calls} = await fixture(t, async (route,url) => {
    if (url.pathname === '/api/search') return route.fulfill({contentType:'text/event-stream',body:sse([
      hit('1',url.searchParams.get('name'),'四川省'),hit('2',url.searchParams.get('name'),'浙江省'),
      {type:'identities',profiles:[profile('1','四川省'),profile('2','浙江省')],memberships:[
        {key:'1:1:11',identity_id:'1:1:11'},{key:'2:2:11',identity_id:'2:2:11'}]},
      {type:'done',searched:2,queued:2},
    ])});
    if (url.pathname === '/api/strength') {
      const old = url.searchParams.get('identity') === '1:1:11';
      if (old) await new Promise(resolve => setTimeout(resolve,500));
      return json(route,{available:true,label:old ? '旧身份估算' : '新身份估算',L:30,confidence:'中',stats:{events:1,rounds:7}}).catch(() => {});
    }
    if (url.pathname === '/api/promotions') return json(route,{items:[]});
    if (url.pathname === '/api/matches') return json(route,{matches:[{bout:1,opponent:'对手',opponent_id:'12',result:'win',score:2,opp_score:0}]});
    throw new Error(`Unexpected API: ${url}`);
  });
  await page.goto(`${origin}/index.html`);
  await search(page);
  assert.equal(await page.locator('.identity-group-heading').count(),2);
  assert.equal(await page.locator('#strengthCard').count(),0);
  assert.equal(calls.some(u => u.pathname === '/api/strength'),false);
  await page.locator('[data-identity="1:1:11"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#resultsList .result-card').length === 1);
  await page.locator('[data-identity="2:2:11"]').click();
  await page.waitForFunction(() => document.getElementById('strengthCard')?.textContent.includes('新身份估算'));
  await page.waitForTimeout(600);
  assert.doesNotMatch(await page.locator('#strengthCard').innerText(),/旧身份估算/);
  await page.locator('#name').fill('尚未查询的新名字');
  await page.locator('#province').selectOption('四川省');
  await page.locator('.btn-expand').first().click();
  await page.locator('.h2h-link').waitFor();
  await page.evaluate(() => { window.open = url => { window.lastOpened = url; }; });
  await page.locator('.h2h-link').click();
  const opened = new URL(await page.evaluate(() => window.lastOpened), origin);
  assert.equal(opened.searchParams.get('playerA'),'同名棋手');
  assert.equal(opened.searchParams.get('province'),'__ALL__');
  assert.equal(opened.searchParams.get('identity_a'),'2:2:11');
  assert.equal(opened.searchParams.get('identity_b'),'2:2:12');
  await page.locator('[data-identity=""]').click();
  assert.equal(await page.locator('#strengthCard').count(),0);
  const dir=path.join(root,'work','ui-hardening');fs.mkdirSync(dir,{recursive:true});
  for (const width of [1440,390,320]) {
    await page.setViewportSize({width,height:1000});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true,`search overflow at ${width}`);
    await page.screenshot({path:path.join(dir,`identities-${width}.png`),fullPage:true});
  }
});

test('match failure can retry and stale data is explicitly labelled', async t => {
  let attempts=0;
  const {page}=await fixture(t,(route,url)=>{
    if(url.pathname==='/api/search') return route.fulfill({contentType:'text/event-stream',body:sse([
      hit('1','测试棋手','四川省'),{type:'identities',profiles:[profile('1','四川省')],memberships:[{key:'1:1:11',identity_id:'1:1:11'}]},
      {type:'done',searched:1,queued:1}])});
    if(url.pathname==='/api/strength') return json(route,{available:false});
    if(url.pathname==='/api/promotions') return json(route,{items:[]});
    if(url.pathname==='/api/matches') return ++attempts === 1 ? json(route,{error:'上游暂不可用'},502)
      : json(route,{stale:true,updated_at:Date.now(),matches:[{bout:1,opponent:'对手',result:'lose'}]});
    throw new Error(`Unexpected API: ${url}`);
  });
  await page.goto(`${origin}/index.html`);await search(page,'测试棋手');
  await page.locator('.btn-expand').first().click();
  await page.getByText('上游暂不可用',{exact:false}).waitFor();
  await page.locator('[data-retry]').click();
  await page.getByText('显示上次成功记录',{exact:false}).waitFor();
  assert.equal(attempts,2);
});

test('head-to-head clear cancels pending work and failed groups are not reported as no matches', async t => {
  let release;let count=0;
  const {page}=await fixture(t,async(route,url)=>{
    if(url.pathname!=='/api/head-to-head') throw new Error(`Unexpected API: ${url}`);
    count++;
    if(count===1) await new Promise(resolve=>release=resolve);
    return json(route,{players:{a:'甲',b:'乙'},summary:{games:0},games:[],failedGroups:1,checkedGroups:1}).catch(()=>{});
  });
  await page.goto(`${origin}/head-to-head.html`);
  await page.locator('#h2hPlayerA').fill('甲');await page.locator('#h2hPlayerB').fill('乙');
  await page.locator('#h2hBtn').click();
  while(!release) await new Promise(resolve=>setTimeout(resolve,10));
  await page.locator('#h2hClearBtn').click();release();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#h2hResult').isVisible(),false);
  await page.locator('#h2hPlayerA').fill('甲');await page.locator('#h2hPlayerB').fill('乙');
  await page.locator('#h2hBtn').click();
  await page.getByText('目前无法确认是否存在交手记录',{exact:false}).waitFor();
  assert.equal(await page.getByRole('button',{name:'重试',exact:true}).count(),1);
});

test('interrupted search keeps individual returned records usable without aggregating identities', async t => {
  const {page}=await fixture(t,(route,url)=>{
    if(url.pathname==='/api/search') return route.fulfill({contentType:'text/event-stream',body:sse([hit('1','测试棋手','四川省')])});
    if(url.pathname==='/api/matches') return json(route,{matches:[{bout:1,opponent:'对手',opponent_id:'12',result:'win'}]});
    throw new Error(`Unexpected API: ${url}`);
  });
  await page.goto(`${origin}/index.html`);await search(page,'测试棋手');
  await page.getByText('连接中断，当前结果可能不完整').waitFor();
  assert.equal(await page.locator('#strengthCard').count(),0);
  await page.locator('.btn-expand').click();
  await page.locator('.opp-link').waitFor();
});

test('head-to-head identity confirmation retains query scope and fits mobile screens', async t => {
  const {page,calls}=await fixture(t,(route,url)=>{
    if(url.pathname!=='/api/head-to-head') throw new Error(`Unexpected API: ${url}`);
    if(!url.searchParams.get('identity_a')) return json(route,{identity_required:true,players:{a:'甲',b:'乙'},
      selected_identities:{a:'',b:'3:3:11'},identities:{a:[profile('1','四川省'),profile('2','浙江省')],b:[profile('3','四川省')]}});
    return json(route,{players:{a:'甲',b:'乙'},summary:{games:0},games:[],checkedGroups:2});
  });
  await page.goto(`${origin}/head-to-head.html?playerA=甲&playerB=乙&province=__ALL__`);
  await page.locator('#confirmIdentities').waitFor();
  const dir=path.join(root,'work','ui-hardening');fs.mkdirSync(dir,{recursive:true});
  for(const width of [1440,390,320]) {
    await page.setViewportSize({width,height:1000});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`head-to-head overflow at ${width}`);
    await page.screenshot({path:path.join(dir,`head-to-head-${width}.png`),fullPage:true});
  }
  await page.locator('#identity-a').selectOption('2:2:11');
  await page.locator('#h2hProvince').selectOption('四川省');
  await page.locator('#confirmIdentities').click();
  await page.getByText('未找到「甲」与「乙」近两年的交手记录',{exact:false}).waitFor();
  const request=calls.filter(u=>u.pathname==='/api/head-to-head').at(-1);
  assert.equal(request.searchParams.get('province'),'__ALL__');
  assert.equal(request.searchParams.get('identity_a'),'2:2:11');
  assert.equal(request.searchParams.get('identity_b'),'3:3:11');
});

test('live prediction waits for confirmation and suppresses stale probabilities on missing history', async t => {
  let count=0;
  const {page,calls}=await fixture(t,(route,url)=>{
    if(url.pathname==='/api/live-events') return json(route,{events:[]});
    if(url.pathname==='/api/live-event') return json(route,{total_rounds:10,groups:[{group_id:'1',group_name:'公开组',pnumber:2,live:true}]});
    if(url.pathname==='/api/live-group') return json(route,{group_id:'1',total_rounds:10,completed_rounds:9,known_pairing_rounds:10,players:[{id:'11',name:'测试棋手',score:16}]});
    if(url.pathname==='/api/live-prediction') {
      if(++count>1) return json(route,{code:'INCOMPLETE_PREDICTION_DATA',error:'历史轮次不完整，请稍后刷新'},422);
      return json(route,{player:{id:'11',name:'测试棋手'},current:{rank:1,score:16,opponent_score:80},total_rounds:10,
        completed_rounds:9,known_pairing_rounds:10,simulations:3000,next_bout:10,next_opponent:{bout:10,name:'已公布对手'},
        probabilities:[{rank:1,probability:0.6,count:1800},{rank:2,probability:0.4,count:1200}]});
    }
    throw new Error(`Unexpected API: ${url}`);
  });
  await page.goto(`${origin}/live-prediction.html`);
  assert.equal(calls.some(u=>u.pathname==='/api/live-events'),false);
  await page.locator('#liveProvince').selectOption('四川省');
  assert.equal(calls.some(u=>u.pathname==='/api/live-events'),false);
  await page.locator('#loadLiveEventsBtn').click();
  await page.waitForFunction(()=>!document.getElementById('loadLiveEventsBtn').disabled);
  await page.goto(`${origin}/live-prediction.html?event_id=1&group_id=1&participant_id=11&total_rounds=10&detail_url=javascript:alert(1)`);
  await page.locator('.live-probability-row').first().waitFor();
  assert.equal(await page.locator('#selectedEventLink').getAttribute('href'),'https://m.yunbisai.com/event/1');
  assert.equal(await page.locator('#livePredictionTotalRoundsInput').inputValue(),'10');
  const dir=path.join(root,'work','ui-hardening');fs.mkdirSync(dir,{recursive:true});
  for(const width of [1440,390,320]) {
    await page.setViewportSize({width,height:1000});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`prediction overflow at ${width}`);
    await page.screenshot({path:path.join(dir,`prediction-${width}.png`),fullPage:true});
  }
  await page.locator('[data-next-result="win"]').click();
  await page.getByText('历史轮次不完整',{exact:false}).waitFor();
  assert.equal(await page.locator('.live-probability-row').count(),0);
  assert.equal(await page.getByRole('button',{name:'重试',exact:true}).count(),1);
});

test('result filters persist in links and backend strength failures never invoke a browser estimate',async t=>{
  let strengthCalls=0;
  const data=[hit('1','筛选棋手','四川省'),hit('2','筛选棋手','四川省'),hit('3','筛选棋手','四川省')];
  data[0].event.title='秋季段位赛';data[1].event.title='全国公开赛';data[2].event.title='春季段位赛';
  data[1].player.group='4段组';data[2].event.date='2025-01-10';
  const {page,calls}=await fixture(t,(route,url)=>{
    if(url.pathname==='/api/search') return route.fulfill({contentType:'text/event-stream',body:sse([
      ...data,{type:'identities',profiles:[profile('1','四川省')],memberships:data.map(h=>({key:`${h.event.event_id}:${h.player.groupid}:11`,identity_id:'1:1:11'}))},
      {type:'done',searched:3,queued:3}])});
    if(url.pathname==='/api/strength') return ++strengthCalls===1 ? json(route,{error:'测试断网'},502)
      : json(route,{available:true,label:'普通5段',L:30,confidence:'中',stats:{events:3,rounds:21},model:{version:'test-model',window_days:180}});
    if(url.pathname==='/api/promotions') return json(route,{items:[]});
    throw new Error(`Unexpected API: ${url}`);
  });
  await page.goto(`${origin}/index.html`);await search(page,'筛选棋手');
  await page.getByText('评估暂不可用',{exact:true}).waitFor();
  assert.equal(calls.filter(u=>u.pathname==='/api/matches').length,0);
  await page.locator('#strengthCard').getByRole('button',{name:'重试'}).click();
  await page.getByText('普通5段',{exact:true}).waitFor();
  await page.locator('#resultYear').selectOption('2025');
  await page.locator('#resultGroup').selectOption('5段组');
  await page.locator('#resultKeyword').fill('春季');
  assert.equal(await page.locator('.result-card:visible').count(),1);
  assert.equal(strengthCalls,2,'display filters must not change the strength sample');
  assert.equal(new URL(page.url()).searchParams.get('keyword'),'春季');
  await page.reload();await page.locator('#resultKeyword').waitFor();
  await page.waitForFunction(()=>!document.getElementById('searchBtn').disabled);
  assert.equal(await page.locator('#resultYear').inputValue(),'2025');
  assert.equal(await page.locator('.result-card:visible').count(),1);
  await page.locator('#resetResultFilters').click();
  assert.equal(await page.locator('.result-card:visible').count(),3);
  assert.equal(new URL(page.url()).searchParams.has('keyword'),false);
  const dir=path.join(root,'work','ui-hardening');fs.mkdirSync(dir,{recursive:true});
  for(const width of [1440,390,320]) {
    await page.setViewportSize({width,height:1000});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.join(dir,`filters-${width}.png`),fullPage:true});
  }
  await page.evaluate(()=>{navigator.clipboard.writeText=async value=>{window.copiedQuery=value;};});
  await page.locator('[data-copy-query]').click();
  assert.equal(await page.evaluate(()=>window.copiedQuery),page.url());
  await page.evaluate(()=>scrollTo(0,700));
  await page.goto(`${origin}/head-to-head.html`);
  await page.goBack();
  await page.waitForFunction(()=>!document.getElementById('searchBtn').disabled && scrollY>300);
});

test('ranking table supports keyboard lookup, mobile score details and carries rules to a new player tab',async t=>{
  const {page,calls}=await fixture(t,(route,url)=>{
    if(url.pathname==='/api/live-event') return json(route,{total_rounds:10,groups:[{group_id:'1',group_name:'公开组',pnumber:2,live:true}]});
    if(url.pathname==='/api/live-group') return json(route,{group_id:'1',total_rounds:10,total_rounds_source:'cloud',completed_rounds:9,known_pairing_rounds:10,
      players:[{id:'11',name:'测试甲',org:'四川棋院',display_rank:1,score:16,opponent_score:88,total_score:232,win:8,lose:1},
        {id:'12',name:'测试乙',org:'浙江棋院',display_rank:2,score:14,opponent_score:80,total_score:208,win:7,lose:2}]});
    throw new Error(`Unexpected API: ${url}`);
  });
  await page.goto(`${origin}/live-prediction.html?event_id=1&group_id=1&total_rounds=10`);
  await page.locator('#livePlayerQuery').waitFor();
  await page.locator('#liveRankingRule').selectOption('score-opponent-score');
  await page.waitForFunction(()=>document.getElementById('livePlayerQuery')!==null);
  await page.locator('#livePlayerQuery').fill('浙江');
  assert.equal(await page.locator('.live-player-link:visible').count(),1);
  await page.locator('#livePlayerQuery').press('Enter');
  assert.equal(await page.locator('[data-player-id="12"]').evaluate(el=>el===document.activeElement),true);
  assert.equal(calls.filter(u=>u.pathname==='/api/live-group').at(-1).searchParams.get('ranking_rule'),'score-opponent-score');
  await page.evaluate(()=>{window.open=url=>{window.lastOpened=url;};});
  await page.locator('[data-player-id="12"]').click();
  const opened=new URL(await page.evaluate(()=>window.lastOpened),origin);
  assert.equal(opened.searchParams.get('ranking_rule'),'score-opponent-score');
  assert.equal(opened.searchParams.get('total_rounds'),'10');
  const dir=path.join(root,'work','ui-hardening');fs.mkdirSync(dir,{recursive:true});
  for(const width of [1440,390,320]) {
    await page.setViewportSize({width,height:1000});
    if(width<600) {
      const button=page.locator('[data-player-detail="12"]');
      if(await button.getAttribute('aria-expanded')!=='true') await button.click();
      assert.equal(await page.locator('#player-detail-12').isVisible(),true);
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`ranking page at ${width}`);
    assert.equal(await page.locator('.ranking-scroll').evaluate(el=>el.scrollWidth<=el.clientWidth),true,`ranking table at ${width}`);
    await page.screenshot({path:path.join(dir,`ranking-${width}.png`),fullPage:true});
  }
  await page.reload();await page.locator('#livePlayerQuery').waitFor();
  assert.equal(await page.locator('#livePlayerQuery').inputValue(),'浙江');
});

test('prediction links restore seed, result scenario and chosen ranking assumption',async t=>{
  const {page,calls}=await fixture(t,(route,url)=>{
    if(url.pathname==='/api/live-event') return json(route,{total_rounds:10,groups:[{group_id:'1',group_name:'公开组',pnumber:2,live:true}]});
    if(url.pathname==='/api/live-group') return json(route,{group_id:'1',total_rounds:10,completed_rounds:9,known_pairing_rounds:10,players:[{id:'11',name:'甲',score:16}]});
    if(url.pathname==='/api/live-prediction') return json(route,{player:{id:'11',name:'甲'},current:{rank:1,score:16,opponent_score:80},total_rounds:10,
      completed_rounds:9,known_pairing_rounds:10,simulations:3000,next_bout:10,next_opponent:{bout:10,name:'乙'},next_result:'win',
      model:{version:'test-model',seed:'shared-seed',snapshot_fingerprint:'test-fingerprint'},probabilities:[{rank:1,probability:1,count:3000}]});
    throw new Error(`Unexpected API: ${url}`);
  });
  await page.goto(`${origin}/live-prediction.html?event_id=1&group_id=1&participant_id=11&total_rounds=10&seed=shared-seed&next_result=win&ranking_rule=score-opponent-score`);
  await page.locator('.live-probability-row').waitFor();
  const request=calls.find(u=>u.pathname==='/api/live-prediction');
  assert.equal(request.searchParams.get('seed'),'shared-seed');
  assert.equal(request.searchParams.get('next_result'),'win');
  assert.equal(request.searchParams.get('ranking_rule'),'score-opponent-score');
  assert.equal(await page.locator('#liveRankingRule').inputValue(),'score-opponent-score');
  assert.match(await page.locator('#livePredictionPanel').innerText(),/规则未核实/);
});

test('head-to-head played records fit mobile and preserve accessible unit details',async t=>{
  const {page}=await fixture(t,(route,url)=>{
    if(url.pathname!=='/api/head-to-head') throw new Error(`Unexpected API: ${url}`);
    return json(route,{players:{a:'测试甲',b:'测试乙'},summary:{games:1,win:1,lose:0,draw:0,winRate:1},checkedGroups:1,
      games:[{event:{date:day,title:'全国少年围棋公开赛暨四川省青少年围棋争霸赛',detail_url:'https://m.yunbisai.com/event/1'},
        group:{name:'5段组'},bout:7,result:'win',score:2,opp_score:0,playerA:{org:'成都市围棋协会'},playerB:{org:'杭州围棋学校'}}]});
  });
  await page.goto(`${origin}/head-to-head.html?playerA=测试甲&playerB=测试乙&province=__ALL__`);
  await page.locator('.h2h-table').waitFor();
  const dir=path.join(root,'work','ui-hardening');fs.mkdirSync(dir,{recursive:true});
  for(const width of [1440,390,320]) {
    await page.setViewportSize({width,height:1000});
    if(width<600) {
      const detail=page.locator('.h2h-table details');
      if(await detail.getAttribute('open')===null) await detail.locator('summary').click();
      assert.match(await detail.innerText(),/杭州围棋学校/);
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`H2H at ${width}`);
    await page.screenshot({path:path.join(dir,`head-to-head-records-${width}.png`),fullPage:true});
  }
});
