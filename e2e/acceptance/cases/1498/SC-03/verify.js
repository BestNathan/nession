'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {repo,invokeScenario,comparePair,result,fail}=require('../../../shared/terminal-scenario-evidence.cjs');

// Reference is a pinned Git blob in the append-only, trusted orphan store;
// product source carries only an evidence *locator*, never the stored Run data.
const historical={
  run_id:37943100476, attempt:1,
  sha:'59653b2372f1692da0d0fdeecfeaad335fe12dfb',
  blob:'7cf2752c5123c841f3e1151175302e04dde250aa',
  path:'runs/2026-10-09/37943100476-1/scenario/terminal-attach-resume-1.json',
  workflow_id:378682095,
};
async function trustedHistoricalRun(){
  const api='https://api.github.com/repos/BestNathan/nession';
  async function get(endpoint){
    const r=await fetch(api+endpoint,{headers:{Accept:'application/vnd.github+json',
      'User-Agent':'nession-acceptance-scenario'},signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw new Error('historical trusted evidence HTTP '+r.status);
    return r.json();
  }
  const [stored,run]=await Promise.all([
    get('/contents/'+historical.path+'?ref=acceptance-results'),
    get('/actions/runs/'+historical.run_id),
  ]);
  assert.equal(stored.sha,historical.blob,'orphan record Git blob identity changed');
  assert.equal(stored.encoding,'base64');
  const data=JSON.parse(Buffer.from(stored.content.replace(/\s/g,''),'base64').toString('utf8'));
  assert.equal(data.schema_version,1);
  assert.equal(data.kind,'e2e_scenario_observation');
  assert.equal(data.scenario,'terminal-attach-resume');
  assert.equal(data.mode,'scenario');
  assert.equal(data.status,'Completed');
  assert.equal(data.evaluation,null);
  assert.equal(data.target_sha,historical.sha);
  assert.equal(data.run_id,historical.run_id);
  assert.equal(data.run_attempt,historical.attempt);
  assert.equal(data.run_index,1);
  assert.equal(data.source.repository,'BestNathan/nession');
  assert.equal(data.source.run_id,historical.run_id);
  assert.equal(data.source.run_attempt,historical.attempt);
  assert.equal(data.source.workflow_id,historical.workflow_id);
  assert.equal(data.source.target_sha,historical.sha);
  assert.equal(data.source.conclusion,'success');
  assert.equal(run.id,historical.run_id);
  assert.equal(run.workflow_id,historical.workflow_id);
  assert.equal(run.head_sha,historical.sha);
  assert.equal(run.conclusion,'success');
  return data;
}
function crossCompare(fileA,fileB){
  const process=spawnSync(global.process.execPath,[path.join(repo,'e2e/run'),'compare',fileA,fileB],{
    cwd:repo,encoding:'utf8',timeout:8000,maxBuffer:1024*1024,
  });
  assert.equal(process.error,undefined);
  assert.equal(process.status,0,'cross-SHA compare error: '+process.stderr);
  const data=JSON.parse(process.stdout);
  assert.equal(data.status,'Completed');
  assert.equal(data.evaluation,null);
  assert.equal(data.config_comparable,true);
  assert.ok(data.differences.some(x=>x.field==='target_sha'),'cross-SHA identity difference missing');
  assert.match(data.limitations,/not synchronized/);
  assert.match(data.limitations,/nondeterministic/);
  return data;
}
async function main(){
  const stage=invokeScenario(2);
  const [a,b]=stage.records.map(r=>r.data);
  assert.equal(a.config_sha256,b.config_sha256);
  assert.notEqual(a.started_at,b.started_at,'independent repetitions must have distinct clocks');
  const same=comparePair(stage.records);
  assert.equal(same.left.sample_count,a.observation_count);
  assert.equal(same.right.sample_count,b.observation_count);
  const historicalRecord=await trustedHistoricalRun();
  assert.notEqual(historicalRecord.target_sha,stage.target);
  assert.equal(historicalRecord.config_sha256,a.config_sha256,'cross-SHA config parameters differ');
  const historicalFile=path.join(stage.dir,'historical-pinned-evidence.json');
  fs.writeFileSync(historicalFile,JSON.stringify(historicalRecord));
  const cross=crossCompare(historicalFile,stage.records[0].file);
  result('Two real staging repetitions and authenticated pinned-orphan cross-SHA observations compared without a synthetic evaluation',[
    {type:'repetition',value:'target='+stage.target+' runs=2 samples='+a.observation_count+','+b.observation_count},
    {type:'historical',value:'run='+historical.run_id+' sha='+historical.sha+' pinned_git_blob='+historical.blob},
    {type:'comparison',value:'sameSHA_final_delta='+same.observed_delta.final_browser_marker_count+' crossSHA_final_delta='+cross.observed_delta.final_browser_marker_count},
    {type:'uncertainty',value:'Wallclock unsynchronized, scheduling nondeterministic; no causal speed or Acceptance claim from raw Run Records'},
  ]);
}
main().catch(fail);
