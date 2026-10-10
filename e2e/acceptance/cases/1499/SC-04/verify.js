'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {pathToFileURL}=require('node:url');
const {runtimeFromEnv}=require('../../../../../acceptance/shared/protocol-online-agent.js');
const {pinnedRun,SOURCES,fetchJson,report,fail}=require('../../../shared/trusted-run-store-proof.cjs');
const root=path.resolve(__dirname,'../../../../..');
async function main(){
  const runtime=runtimeFromEnv();
  assert.equal(runtime.target_sha,process.env.NESSION_ACCEPTANCE_TARGET_SHA);
  assert.equal(runtime.profile,'full-stack-local');
  const {artifactEvidence,validateArtifactEvidence}=await import(pathToFileURL(
    path.join(root,'scripts/run-record-artifact-evidence.mjs')).href);
  const [scenario,acceptance]=await Promise.all([
    pinnedRun(SOURCES.scenario),pinnedRun(SOURCES.acceptance)]);
  for(const [mode,record,sourceDigest,workflowUrl,retention] of [
    ['scenario',scenario.item,scenario.source.original_sha256,
      scenario.source.source_url,14],
    ['acceptance',acceptance.item,acceptance.item.provenance.source_result_sha256,
      acceptance.item.provenance.workflow_url,90],
  ]){
    const receipt=artifactEvidence({mode,run_id:record.run_id,
      run_attempt:record.run_attempt,source_record_sha256:sourceDigest,
      workflow_url:workflowUrl});
    validateArtifactEvidence(receipt,{mode,run_id:record.run_id,
      run_attempt:record.run_attempt,source_record_sha256:sourceDigest,
      workflow_url:workflowUrl});
    assert.equal(receipt.retention_days,retention);
    assert.equal(receipt.digest_scope,'validated-source-record-json');
    assert.match(receipt.sha256,/^[a-f0-9]{64}$/);
    assert.match(receipt.durability,/time-limited|not indefinitely|not configured/);
    assert.throws(()=>validateArtifactEvidence({...receipt,retention_days:99999},{
      mode,run_id:record.run_id,run_attempt:record.run_attempt,
      source_record_sha256:sourceDigest,workflow_url:workflowUrl}));
    assert.throws(()=>validateArtifactEvidence({...receipt,sha256:'f'.repeat(64)},{
      mode,run_id:record.run_id,run_attempt:record.run_attempt,
      source_record_sha256:sourceDigest,workflow_url:workflowUrl}));
  }
  const docs=fs.readFileSync(path.join(root,'docs/architecture/e2e-run-store.md'),'utf8');
  assert.match(docs,/14 days/);
  assert.match(docs,/90 days/);
  assert.match(docs,/not archived permanently/);
  assert.match(docs,/validated-source-record-json/);
  report('Authentic Case and Scenario source receipts enforce SHA-256 digest scope, mode-specific finite retention, and explicit lack of indefinite large-artifact archival.',[
    {type:'case',value:'run='+acceptance.run.id+' validated-source digest='+acceptance.item.provenance.source_result_sha256+' retention=90d'},
    {type:'scenario',value:'run='+scenario.run.id+' validated-source digest='+scenario.source.original_sha256+' retention=14d'},
    {type:'negative',value:'forged source checksum and unbounded retention rejected for both modes'},
    {type:'durability',value:'compact orphan record immutable; source Actions artifact expires; no unbacked indefinite archive claim'},
  ]);
}
main().catch(fail);
