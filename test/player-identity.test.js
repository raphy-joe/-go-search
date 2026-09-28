'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {partitionPlayerRows,selectIdentity,recordKey}=require('../player-identity');
const row=(id,province,group='5段组',extra={})=>({event_id:String(id),group_id:String(id),participant_id:'1',participant_name:'测试棋手',
  provincename:province,title:'围棋段位赛',min_time:'2026-08-01',group_name:group,win:4,lose:3,org:'测试棋院',...extra});

test('similar national open away results stay with the main competing region',()=>{
  const rows=[row(1,'四川省'),row(2,'四川省'),row(3,'浙江省','公开组',{title:'全国业余围棋公开赛'})];
  assert.equal(partitionPlayerRows(rows).length,1);
});
test('substantial contemporaneous strength differences remain separate even at national opens',()=>{
  const rows=[row(1,'四川省','2段组'),row(2,'四川省','2段组'),row(3,'浙江省','公开组',{title:'全国围棋公开赛'})];
  assert.equal(partitionPlayerRows(rows).length,2);
});
test('an open title alone does not prove nationwide eligibility',()=>{
  const rows=[row(1,'四川省'),row(2,'四川省'),row(3,'浙江省','5段组',{title:'某杯围棋公开赛'})];
  assert.equal(partitionPlayerRows(rows).length,2);
  assert.equal(partitionPlayerRows(rows,new Map([['3','参赛资格：面向全国围棋爱好者']])).length,1);
});
test('every away event must have nationwide eligibility evidence',()=>{
  const rows=[row(1,'四川省'),row(2,'四川省'),row(3,'四川省'),row(4,'浙江省','公开组',{title:'全国围棋公开赛'}),row(5,'浙江省')];
  assert.equal(partitionPlayerRows(rows).length,2);
});
test('unknown strength and noncontemporaneous evidence are not automatically merged',()=>{
  const rows=[row(1,'四川省'),row(2,'四川省'),row(3,'浙江省','未定组',{title:'全国围棋公开赛'})];
  assert.equal(partitionPlayerRows(rows).length,2);
  rows[2]=row(3,'浙江省','5段组',{title:'全国围棋公开赛',min_time:'2024-01-01'});
  assert.equal(partitionPlayerRows(rows).length,2);
});
test('two namesakes in the same event group remain separate within one province',()=>{
  const rows=[row(1,'四川省'),row(1,'四川省','5段组',{participant_id:'2'})];
  assert.equal(partitionPlayerRows(rows).length,2);
});
test('ambiguous profiles need selection, and explicit record anchors resolve their trajectory',()=>{
  const rows=[row(1,'四川省'),row(2,'浙江省')],profiles=partitionPlayerRows(rows);
  assert.equal(selectIdentity(profiles),null);assert.equal(selectIdentity(profiles,recordKey(rows[1])).label,'浙江省');
  assert.throws(()=>selectIdentity(profiles,'missing'),/轨迹已变化/);
});
test('ordinary growth within the home region does not split a player',()=>{
  assert.equal(partitionPlayerRows([row(1,'四川省','1段组',{min_time:'2024-08-01'}),row(2,'四川省','5段组')]).length,1);
});
