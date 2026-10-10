'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {repo,liveContext,sourceChecks,canonicalIngest,report,fail}=require('../../../shared/staging-continuity-proof.cjs');
async function main(){
  const ctx=await liveContext();
  const checks=await sourceChecks(ctx.sourceHead);
  const proof=await canonicalIngest();
  const ingest=fs.readFileSync(path.join(repo,'scripts/acceptance-case-ingest.mjs'),'utf8');
  assert.match(ingest,/assertSourceBoundRecord/);
  assert.match(ingest,/case_tree_sha/);
  assert.equal(proof.record.provenance.verified_source.run_attempt,1);
  assert.match(proof.record.contract_sha256,/^[a-f0-9]{64}$/);
  report('Real trusted staging Case ingestion has canonical source SHA/tree and contract binding; actual PR-head tests and runtime passed.',[
    {type:'runtime',value:'staging_sha='+ctx.target+' observed Server/Agent/Web'},
    {type:'ci',value:'Quality='+checks['Quality Gate'].id+' E2E='+checks['E2E Tests'].id},
    {type:'ingest',value:'trusted_workflow_run='+proof.ingest.id+' source_run='+proof.source.id+' orphan_blob='+proof.blob},
    {type:'contract',value:'source_case_tree_sha='+proof.record.case_tree_sha+' contract_sha256='+proof.record.contract_sha256},
  ]);
}
main().catch(fail);
