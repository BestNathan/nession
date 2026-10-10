'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {execFileSync}=require('node:child_process');
const {repo,result,fail}=require('../../../shared/terminal-scenario-evidence.cjs');
const {pinnedRun,SOURCES}=require('../../../shared/trusted-run-store-proof.cjs');
async function main(){
 const cases=await import(pathToFileURL(path.join(repo,'acceptance/cases.mjs')).href);
 const browser=await import(pathToFileURL(path.join(repo,'e2e/runner/drivers/browser-report.mjs')).href);
 assert.equal(cases.aggregateVerifierResults([]),'Pending');
 assert.equal(cases.aggregateVerifierResults([{result:'Pass'},{result:'Pending'}]),'Pending');
 assert.equal(cases.aggregateVerifierResults([{result:'Pass'},{result:'Error'}]),'Error');
 assert.equal(cases.aggregateVerifierResults([{result:'Pass'},{result:'Fail'}]),'Fail');
 assert.equal(browser.classifyBrowserReport(null,0).result,'Error');
 assert.equal(browser.classifyBrowserReport({suites:[],stats:{expected:0,unexpected:0,skipped:0,flaky:0}},0,{schema_version:1,executed:0,passed:0,assertions:0,failedAssertions:0}).result,'Error');
 const self=execFileSync(process.execPath,[path.join(repo,'e2e/runner/drivers/browser-report.mjs'),'self-test'],{cwd:repo,encoding:'utf8',timeout:5000});
 assert.match(self,/positive\/negative fixtures passed/);
 const scenario=await pinnedRun(SOURCES.scenario);
 assert.equal(scenario.item.evaluation,null);
 assert.equal(scenario.item.status,'Completed');
 result('Zero/skipped/missing verifier evidence never maps to Pass and real Scenario execution remains observational',[
  {type:'classifier',value:'empty/discovery-missing/zero assertion rejected; aggregation distinguishes Pending/Fail/Error'},
  {type:'selftest',value:'Playwright assertion-proof negative cases executed from shared Runner Drivers'},
  {type:'separation',value:'authenticated orphan Scenario run='+scenario.run.id+' has evaluation=null despite Completed execution'}
 ]);
}
main().catch(fail);
