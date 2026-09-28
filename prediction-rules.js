'use strict';
const { createHash } = require('node:crypto');
const RULES = Object.freeze({
  'cloud-total-score': { label:'总得分、大分', formula:'大分 + 2 × 对手分 / 最高大分 - 轮次' },
  'score-opponent-score': { label:'大分、对手分', formula:'先比较大分，再比较对手分' },
});
function rankingRule(id) {
  const value = id || 'cloud-total-score';
  if (!RULES[value]) throw Object.assign(new Error('不支持的排名规则'), {code:'INVALID_QUERY',status:400});
  return { id:value, ...RULES[value], source:id ? 'user-assumption' : 'unverified-default', verified:false,
    scoring:'win-2-draw-1-loss-0', bye_opponent_score:0, tie:'shared-rank' };
}
function snapshotFingerprint(snapshot) {
  const players = snapshot.players.map(p => ({id:String(p.id),score:p.score,win:p.win,lose:p.lose,draw:p.draw,short_no:p.short_no}))
    .sort((a,b)=>a.id.localeCompare(b.id));
  const rows = snapshot.matchData.rows.map(r => ({bout:r.bout,p1_id:r.p1_id,p2_id:r.p2_id,p1_result:r.p1_result,p2_result:r.p2_result,p1_score:r.p1_score,p2_score:r.p2_score}))
    .sort((a,b)=>a.bout-b.bout || String(a.p1_id).localeCompare(String(b.p1_id)) || String(a.p2_id).localeCompare(String(b.p2_id)));
  const rounds = {total:snapshot.matchData.totalRounds,completed:snapshot.matchData.completedRounds,known:snapshot.matchData.knownPairingRounds};
  return createHash('sha256').update(JSON.stringify({players,rows,rounds})).digest('hex').slice(0,24);
}
module.exports = { RULES, rankingRule, snapshotFingerprint };
