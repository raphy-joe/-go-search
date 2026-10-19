'use strict';

function publishedFixture() {
  const header = '\u540d\u6b21,F=0,R=2;\u7f16\u53f7,F=1,R=2;\u59d3\u540d,F=2,R=2;\u5355\u4f4d,F=3,R=2;'
    + '\u7b2c1\u8f6e,C=2;\u7b2c2\u8f6e,C=2;\u7b2c3\u8f6e,C=2;\u603b\u5f97\u5206,F=10,R=2;\u4e2a\u4eba\u79ef\u5206,F=11,R=2;\u540d\u6b21,F=12,R=2';
  const sub = '\u5bf9\u624b,F=4;\u79ef\u5206,F=5;\u5bf9\u624b,F=6;\u79ef\u5206,F=7;\u5bf9\u624b,F=8;\u79ef\u5206,F=9';
  const rows = [
    [2,1,'Alpha&pId:1','Team','*2',2,'3',2,'*4',4,4.5,4,2],
    [3,2,'Beta&pId:2','Team','1',0,'*4',2,'3',2,2.1,2,3],
    [1,3,'Gamma&pId:3','Team','*4',2,'*1',4,'*2',6,7.2,6,1],
    [4,4,'Delta&pId:4','Team','3',0,'2',0,'1',0,0,0,4],
    [5,5,'Absent&pId:5','Team','',0,'','','','',-3,0,5],
  ];
  return { error:0, data:{ TableName:'Go - Final results',tabletop:[header,sub],tabledata:rows.map(row=>row.join(';')),elsedata:null } };
}

const entry = { id:'99',group_id:'8',title:'\u603b\u6210\u7ee9\u8868',createtime:'2026-10-09 09:25:48' };
module.exports = { publishedFixture, entry };
