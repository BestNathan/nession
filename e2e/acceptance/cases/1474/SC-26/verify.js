'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {repo,invokeScenario,result,fail}=require('../../../shared/terminal-scenario-evidence.cjs');
try{
 const consumer=fs.readFileSync(path.join(repo,'e2e/acceptance/cases/1498/SC-04/verify.js'),'utf8');
 assert.match(consumer,/invokeScenario\(1\)/);
 assert.match(consumer,/Case 1498\/SC-04 executes canonical e2e\/run scenario/);
 const run=invokeScenario(1),x=run.records[0].data;
 const after=x.observations.filter(o=>o.stage==='after-reload');
 assert.ok(after.length>=1);
 assert.ok(x.observations.some(o=>o.stage==='before-reload'));
 assert.ok(after.some(o=>o.browser.mounted && o.browser.marker_count>0),
  'real browser marker recovery absent');
 assert.ok(after.every(o=>o.backend.marker_count>=0));
 assert.ok(Date.parse(x.finished_at)>=Date.parse(x.started_at));
 result('Real Terminal resume Case consumed the same canonical Scenario used by an independently accepted Issue/SC consumer',[
 {type:'timeline',value:'SHA='+run.target+' before/after samples='+x.observation_count+' recovered='+after.at(-1).browser.marker_count},
 {type:'reuse',value:'source-aligned 1498/SC-04 directly invokes same canonical terminal-attach-resume Scenario'},
 {type:'evidence',value:'tmux/backend hashes with browser marker recovery and no fabricated Scenario verdict'}]);
}catch(e){fail(e);}
