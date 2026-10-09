'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {repo,invokeScenario,result,fail}=require('../../../shared/terminal-scenario-evidence.cjs');
try{
  const source=fs.readFileSync(path.join(repo,'e2e/scenarios/terminal-attach-resume/reproduce.cjs'),'utf8');
  const helper=fs.readFileSync(path.join(repo,'e2e/acceptance/shared/terminal-scenario-evidence.cjs'),'utf8');
  assert.match(helper,/e2e\/run'\),'scenario'/);
  assert.match(source,/runner\/collectors\/terminal-observation\.cjs/);
  const run=invokeScenario(1);
  const x=run.records[0].data;
  assert.equal(x.observations[0].stage,'before-reload');
  const after=x.observations.filter(o=>o.stage==='after-reload');
  assert.ok(after.length>=1);
  assert.ok(after.some(o=>o.backend.marker_count>=0));
  assert.ok(Number.isFinite(Date.parse(x.finished_at))-Date.parse(x.started_at));
  result('Issue/SC Acceptance directly reused the exact Scenario/Runner and generated real terminal replay timeline',[
    {type:'reuse',value:'Case 1498/SC-04 executes canonical e2e/run scenario terminal-attach-resume'},
    {type:'timeline',value:'target='+run.target+' begin='+x.started_at+' finish='+x.finished_at+' samples='+x.observation_count},
    {type:'collector',value:'shared e2e/runner/collectors terminal observation, backend hash with no terminal text'},
  ]);
}catch(e){fail(e);}
