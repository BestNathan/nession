'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {repo,invokeScenario,result,fail}=require('../../../shared/terminal-scenario-evidence.cjs');
try{
 const manifest=fs.readFileSync(path.join(repo,'e2e/scenarios/terminal-attach-resume/scenario.yaml'),'utf8');
 assert.match(manifest,/mode: observe/);assert.match(manifest,/entry: reproduce.cjs/);
 const run=invokeScenario(1),r=run.records[0].data;
 assert.equal(r.evaluation,null);assert.equal(r.status,'Completed');
 assert.equal(r.target_sha,run.target);assert.ok(r.session_created);
 assert.ok(r.observations.some(o=>o.stage==='before-reload')&&r.observations.some(o=>o.stage==='after-reload'));
 assert.match(r.config_sha256,/^[a-f0-9]{64}$/);
 result('Standalone manifest-driven real Server/Agent/tmux/browser terminal attach and reload captured exact source SHA and bounded inputs without an Acceptance verdict',[
 {type:'scenario',value:'target='+run.target+' config_sha256='+r.config_sha256+' samples='+r.observation_count},
 {type:'runtime',value:'real full-stack-local terminal replay completed in observe mode'},
 {type:'separation',value:'Scenario evaluation=null; independent Issue/SC Case performs assessment'}]);
}catch(e){fail(e);}
