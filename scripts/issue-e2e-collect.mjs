#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
// Post-run normalizer. Missing or corrupt reporter evidence yields Error, never Pass.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { summarize } from '../e2e/runner/selected-report.mjs';

export function collect(plan, report, runId, attempt) {
  if (plan?.kind !== 'issue_e2e_selection' || !Number.isSafeInteger(runId) || runId < 1 ||
      !Number.isSafeInteger(attempt) || attempt < 1) throw Error('invalid run/plan identity');
  let classification;
  if (plan.mode === 'selected') {
    try {
      classification = summarize(plan, report);
    } catch {
      classification = { results:plan.selected.map(({id})=>({
        id,result:'Error',discovered:0,passed:0,failed:0,skipped:0,flaky:0,assertions:0
      })),status:'Unproven' };
    }
  } else {
    classification = { results:[],status:plan.mode==='not-required'?'NotRequired':'Unproven' };
  }
  return { schema_version:1, kind:'issue_e2e_test_results',scope:plan.mode,
    target_sha:plan.target_sha,plan_digest:plan.plan_digest||null,
    run_id:runId,run_attempt:attempt,results:classification.results,status:classification.status };
}
function selfTest(){
  const p={kind:'issue_e2e_selection',mode:'selected',target_sha:'a'.repeat(40),
    plan_digest:'b'.repeat(64),selected:[{id:'terminal-attach'}]};
  assert.equal(collect(p,null,1,1).results[0].result,'Error');
  assert.equal(collect({...p,mode:'not-required'},null,1,1).status,'NotRequired');
  assert.throws(()=>collect(p,null,0,1));
  console.log('Issue E2E collection: no fabricated Pass for absent/corrupted Playwright report');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const [op,planFile,reportFile,outFile]=process.argv.slice(2);
if(op==='self-test')selfTest();
else if(op==='collect'){
  if(!planFile||!reportFile||!outFile)throw Error('collect PLAN REPORT OUT');
  const plan=JSON.parse(fs.readFileSync(planFile,'utf8'));
  let json=null;
  try{json=JSON.parse(fs.readFileSync(reportFile,'utf8'));}catch{}
  const result=collect(plan,json,Number(process.env.GITHUB_RUN_ID),Number(process.env.GITHUB_RUN_ATTEMPT));
  fs.writeFileSync(outFile,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log('Collected '+result.results.length+' E2E IDs, '+result.status);
}else throw Error('use self-test or collect');
}
