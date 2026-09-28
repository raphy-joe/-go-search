'use strict';
const fs = require('node:fs');
const {open,all,close} = require('./sqlite-tools');
const {predictPlayerRank,reconcileLivePlayers,validatePredictionSnapshot,computeCurrentRanking} = require('../prediction-engine');
const {isPlayedMatch} = require('../match-results');
const versions = require('../model-versions');

function holdOutFinalRound(players,rows) {
  const rounds=Math.max(...rows.map(r=>r.bout),0);
  if(rounds<3 || rows.some(r=>!isPlayedMatch(r))) throw new Error('Need a completed group with at least three rounds');
  const zero=players.map(p=>({...p,score:0,win:0,lose:0,draw:0,cloud_rank:0}));
  const finalStats=reconcileLivePlayers(zero,rows).players;
  if(players.some(p=>{
    const calculated=finalStats.find(x=>x.id===p.id);
    return !(p.cloud_rank>0) || p.win+p.lose+p.draw!==rounds ||
      p.win!==calculated.win || p.lose!==calculated.lose || p.draw!==calculated.draw || Number(p.score)!==calculated.score;
  })) throw new Error('Final official standings and complete round results must agree');
  const history=rows.filter(r=>r.bout<rounds);
  const before=reconcileLivePlayers(zero,history).players.map(p=>({...p,cloud_rank:0,score_reconciled:false}));
  const hidden=rows.map(r=>r.bout===rounds ? {...r,p1_result:'',p2_result:'',p1_score:0,p2_score:0} : {...r});
  const snapshot={players:before,matchData:{rows:hidden,totalRounds:rounds,totalRoundsSource:'historical-final-round',
    completedRounds:rounds-1,knownPairingRounds:rounds},snapshotAt:0};
  validatePredictionSnapshot(snapshot);
  return snapshot;
}
async function backtest(file,{groupLimit=5,playersPerGroup=5,simulations=1000,rule=''}={}) {
  const db=await open(file);
  try {
    const groups=await all(db,`SELECT DISTINCT p.group_id,e.min_time FROM go_participant_index p
      JOIN events e ON p.event_id=e.event_id JOIN group_match_cache c ON c.group_id=p.group_id
      WHERE date(e.min_time)<date('now') ORDER BY e.min_time DESC,p.group_id LIMIT 100`);
    const results=[],skipped=[];
    for(const group of groups) {
      if(new Set(results.map(r=>r.group_id)).size>=groupLimit) break;
      const players=(await all(db,'SELECT * FROM go_participant_index WHERE group_id=?',[group.group_id])).map(p=>({
        id:p.participant_id,name:p.participant_name,short_no:p.short_no,score:Number(p.score),win:p.win,lose:p.lose,draw:p.draw,cloud_rank:p.rank}));
      const rows=await all(db,'SELECT * FROM group_match_cache WHERE group_id=? ORDER BY bout,p1_id',[group.group_id]);
      let snapshot;
      try {snapshot=holdOutFinalRound(players,rows);} catch(e) {skipped.push({group_id:group.group_id,reason:e.message});continue;}
      const ordered=[...players].sort((a,b)=>a.cloud_rank-b.cloud_rank || a.id.localeCompare(b.id));
      const sample=ordered.length<=playersPerGroup ? ordered : Array.from({length:playersPerGroup},(_,i)=>ordered[Math.round(i*(ordered.length-1)/(playersPerGroup-1))]);
      const reproduced=computeCurrentRanking(players,rows,snapshot.matchData.totalRounds,rule);
      for(const p of sample) {
        const prediction=predictPlayerRank({snapshot,groupId:group.group_id,participantId:p.id,simulations,
          rankingRuleId:rule,includeDistribution:true,seed:`backtest-v1:${group.group_id}:${p.id}`});
        const outcomes=prediction.probabilities;
        const actual=outcomes.find(r=>r.rank===p.cloud_rank)?.probability||0;
        const brier=outcomes.reduce((sum,r)=>sum+(r.probability-(r.rank===p.cloud_rank?1:0))**2,0)+(actual===0?1:0);
        results.push({group_id:group.group_id,participant_id:p.id,actual_rank:p.cloud_rank,top_rank:outcomes[0].rank,
          top1:outcomes[0].rank===p.cloud_rank,top5:outcomes.slice(0,5).some(r=>r.rank===p.cloud_rank),
          actual_probability:actual,brier,final_rule_agrees:reproduced.find(r=>r.id===p.id).rank===p.cloud_rank,
          model:prediction.model});
      }
    }
    const mean=key=>results.length ? results.reduce((sum,r)=>sum+Number(r[key]),0)/results.length : null;
    return {created_at:new Date().toISOString(),versions,method:'Known final pairings; all final results and standings removed from model input; stratified by final rank for evaluation only',
      limitations:'Convenience sample of complete cached groups; rules unverified, 50/50 games. Not a calibrated strength or probability accuracy guarantee.',
      ranking_rule:rule||'unverified-default',samples:results.length,groups:new Set(results.map(r=>r.group_id)).size,
      metrics:{top1:mean('top1'),top5:mean('top5'),brier:mean('brier'),final_rule_agreement:mean('final_rule_agrees')},results,skipped};
  } finally {await close(db);}
}
if(require.main===module) {
  const [db,output]=process.argv.slice(2);
  if(!db || !output) {console.error('Usage: node scripts/backtest.js DB NEW_REPORT.json');process.exitCode=1;}
  else backtest(db).then(report=>{
    fs.writeFileSync(output,JSON.stringify(report,null,2),{flag:'wx'});
    console.log(JSON.stringify({samples:report.samples,groups:report.groups,metrics:report.metrics,skipped:report.skipped.length,output},null,2));
  }).catch(e=>{console.error(e.message);process.exitCode=1;});
}
module.exports={holdOutFinalRound,backtest};
