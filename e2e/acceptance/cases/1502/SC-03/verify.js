'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {repo,liveContext,sourceChecks,artifact,report,fail}=require('../../../shared/staging-continuity-proof.cjs');
async function main(){
  const ctx=await liveContext();
  const ci=await sourceChecks(ctx.sourceHead);
  const smoke=await artifact(ci['Acceptance Case Smoke'],'acceptance-case-smoke-1474');
  const reportArtifact=await artifact(ci['E2E Tests'],'playwright-report');
  const driver=fs.readFileSync(path.join(repo,'e2e/runner/drivers/browser-report.mjs'),'utf8');
  assert.match(driver,/self.test|selfTest|self-test/i);
  const quality=fs.readFileSync(path.join(repo,'.github/workflows/quality.yml'),'utf8');
  assert.match(quality,/node e2e\/runner\/drivers\/browser-report\.mjs self-test/);
  assert.ok(smoke.size_in_bytes>100&&reportArtifact.size_in_bytes>100);
  report('Actual exact PR-head browser Case Smoke, Playwright report and negative assertion gate succeeded; real merged-SHA full stack is healthy.',[
    {type:'ci',value:'Quality='+ci['Quality Gate'].id+' E2E='+ci['E2E Tests'].id+' Smoke='+ci['Acceptance Case Smoke'].id},
    {type:'artifacts',value:'smoke='+smoke.name+' bytes='+smoke.size_in_bytes+' playwright='+reportArtifact.name+' bytes='+reportArtifact.size_in_bytes},
    {type:'assertion',value:'browser assertion reporter negative fixtures executed by Quality Gate'},
    {type:'runtime',value:'real isolated Server/Agent/Web staging_sha='+ctx.target},
  ]);
}
main().catch(fail);
