'use strict';
const assert=require('node:assert/strict');
const {invokeScenario,comparePair,result,fail}=require('../../../shared/terminal-scenario-evidence.cjs');
try{
  const run=invokeScenario(2);
  const [a,b]=run.records.map(r=>r.data);
  assert.equal(a.config_sha256,b.config_sha256);
  assert.notEqual(a.started_at,b.started_at,'independent repetitions must have distinct clocks');
  const comparison=comparePair(run.records);
  assert.equal(comparison.left.sample_count,a.observation_count);
  assert.equal(comparison.right.sample_count,b.observation_count);
  assert.match(comparison.limitations,/Wallclock samples are not synchronized/);
  result('Two real staging SHA Scenario executions compared through canonical CLI with explicit clock and nondeterminism limits',[
    {type:'repetition',value:'target='+run.target+' run_index=1,2 samples='+a.observation_count+','+b.observation_count},
    {type:'comparison',value:'observed_final_browser_delta='+comparison.observed_delta.final_browser_marker_count+' config_comparable='+comparison.config_comparable},
    {type:'uncertainty',value:'different clocks/environment scheduling; compare cannot infer causal improvement or Acceptance verdict'},
  ]);
}catch(e){fail(e);}
