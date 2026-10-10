'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {repo,liveContext,sourceChecks,artifact,report,fail}=require('../../../shared/staging-continuity-proof.cjs');
async function main(){
  const ctx=await liveContext();
  const ci=await sourceChecks(ctx.sourceHead);
  const regression=fs.readFileSync(path.join(repo,'e2e/globalSetup.ts'),'utf8');
  const evaluator=fs.readFileSync(path.join(repo,'e2e/acceptance/evaluator/run-case.mjs'),'utf8');
  assert.match(regression,/runner\/runtime\/full-stack\.js/);
  assert.match(evaluator,/runner\/runtime\/full-stack\.js/);
  const lifecycle=fs.readFileSync(path.join(repo,'e2e/runner/runtime/full-stack.js'),'utf8');
  assert.match(lifecycle,/stop:|async stop|stop\(\)/);
  const e2e=await artifact(ci['E2E Tests'],'playwright-report');
  const smoke=await artifact(ci['Acceptance Case Smoke'],'acceptance-case-smoke-1474');
  report('Shared Runner owns real Server, Agent, tmux and Web lifecycle with successful exact-head Quality/E2E/Case Smoke and isolated staging Case execution.',[
    {type:'ownership',value:'globalSetup and Case evaluator both delegate to e2e/runner/runtime/full-stack.js'},
    {type:'runtime',value:'target='+ctx.target+' profile=full-stack-local, real Agent protocol and HTTP readiness'},
    {type:'ci',value:'Quality='+ci['Quality Gate'].id+' E2E='+ci['E2E Tests'].id+' CaseSmoke='+ci['Acceptance Case Smoke'].id},
    {type:'artifacts',value:'playwright='+e2e.size_in_bytes+' case='+smoke.size_in_bytes},
  ]);
}
main().catch(fail);
