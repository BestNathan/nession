'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {repo,liveContext,sourceChecks,canonicalIngest,report,fail}=require('../../../shared/staging-continuity-proof.cjs');
async function main(){
  const ctx=await liveContext();
  const ci=await sourceChecks(ctx.sourceHead);
  const proof=await canonicalIngest();
  assert.equal(fs.existsSync(path.join(repo,'acceptance/cases')),false,'retired Case tree still exists');
  const canonical=path.join(repo,'e2e/acceptance/cases/1497/SC-04');
  assert.equal(fs.realpathSync(canonical),canonical,'Case tree symlink');
  const ingester=fs.readFileSync(path.join(repo,'scripts/acceptance-case-ingest.mjs'),'utf8');
  assert.match(ingester,/assertSourceBoundRecord/);
  assert.match(ingester,/case_tree_sha/);
  report('Authenticated successful staging Case ingestion verified the canonical source Case tree at its real Git SHA; no unsafe legacy fallback.',[
    {type:'provenance',value:'source_run='+proof.source.id+' source_sha='+proof.source.head_sha+' case_tree='+proof.record.case_tree_sha},
    {type:'orphan',value:'trusted_ingest='+proof.ingest.id+' record_git_blob='+proof.blob},
    {type:'ci',value:'Quality='+ci['Quality Gate'].id+' exact_source_head='+ctx.sourceHead},
    {type:'runtime',value:'live staged Server/Agent/Web at '+ctx.target},
  ]);
}
main().catch(fail);
