// #1690 SC-04: consume the real canonical Run Store CAS matrix, already run
// inside the main-owned SC-10 fixture Gate. This does NOT prove GitHub
// server-side App/PAT authorization, Ruleset enforcement or a production write.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {collectRunStoreFixtureEvidence} from './acceptance-run-store-fixture-evidence.mjs';

const REPO='BestNathan/nession';
const SHA=/^[0-9a-f]{40}$/;
const STORES=['acceptance-results','task-results','metrics'];
const fail=x=>{throw Error('authenticated Run Store CAS matrix: '+x);};
export function validateCasMatrixEvidence(report,fixture){
  if(!fixture||fixture.verdict!=='fixture_pass'||fixture.repository!==REPO||
     !SHA.test(fixture.target_sha??'')||
     !Number.isSafeInteger(fixture.workflow_run_id)||fixture.workflow_run_id<1||
     !Number.isSafeInteger(fixture.run_attempt)||fixture.run_attempt<1||
     report?.schema_version!==1||
     report.kind!=='isolated_run_store_cas_concurrency_matrix'||
     report.repository!==REPO||
     report.verdict!=='FixturePassed'||report.coverage!==3||report.total!==3||
     report.observed_main_sha!==fixture.target_sha||
     report.workflow_run_id!==fixture.workflow_run_id||
     report.workflow_run_attempt!==fixture.run_attempt||
     report.evidence_scope!=='isolated_disposable_bare_git_only_not_server_authorization'||
     report.production_ref_mutated!==false||
     report.server_side_denial_verified!==false||
     report.writer_identity_verified!==false||
     report.independent_anchor_verified!==false||
     !Array.isArray(report.stores)||report.stores.length!==3||
     JSON.stringify(report.stores.map(x=>x.store))!==JSON.stringify(STORES))
    fail('invalid or unbound exact-main matrix report');
  for(const row of report.stores){
    if(row.execution!=='disposable_bare_git'||
       row.parallel_distinct_key!=='two_commits_retained'||
       row.identical_key!=='exactly_one_commit_and_one_replay'||
       row.divergent_same_key!=='rejected'||
       row.immutable_overwrite!=='rejected'||
       row.deleted_remote_ref!=='rejected'||
       row.unrelated_ref_rewrite!=='rejected'||
       (row.store==='metrics'&&row.stale_metrics_projection!=='stale_conflict_rejected')||
       (row.store!=='metrics'&&row.stale_metrics_projection!=='not_applicable')||
       !SHA.test(row.initial_tip??'')||!SHA.test(row.parallel_tip??'')||
       !SHA.test(row.final_tip??'')||
       !Number.isSafeInteger(row.publisher_receipts)||row.publisher_receipts<2)
      fail('CAS matrix missing mandatory executed outcome for '+row.store);
  }
  return Object.freeze({
    kind:'authenticated_run_store_cas_matrix',schema_version:1,
    repository:REPO,target_sha:fixture.target_sha,
    producer_workflow:fixture.workflow_path,
    source_run_id:fixture.workflow_run_id,source_attempt:fixture.run_attempt,
    source_job_id:fixture.job_id,source_artifact_id:fixture.artifact_id,
    source_artifact_zip_digest:fixture.artifact_zip_digest,
    verdict:'Verified',
    real_disposable_git_parallel_publishers:true,
    repeated_identical_keys_idempotent:true,
    divergent_immutable_collision_rejected:true,
    stale_concurrent_CAS_retried_without_lost_records:true,
    source_receipts_present:true,
    stores:report.stores.map(x=>({...x})),
    production_refs_mutated:false,
    github_server_writer_authorization_verified:false,
    external_checkpoint_verified_by_this_report:false,
    proof_scope:'actual concurrent production publisher processes using isolated bare Git, with exact-main Gate Job and finite-retention artifact; no GitHub protected branch write attempts',
  });
}
export async function collectCasMatrixEvidence(repo,sha,directRuns,get,{
  run=execFileSync,makeTemp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'nession-cas-acceptance-')),
}={}){
  if(repo!==REPO||!SHA.test(sha)||!Array.isArray(directRuns)||typeof get!=='function')
    fail('untrusted CAS evidence query');
  const proofs=await collectRunStoreFixtureEvidence(repo,sha,directRuns,get);
  if(proofs.length!==1)return null;
  const fixture=proofs[0];
  const temp=makeTemp();
  try{
    if(!path.isAbsolute(temp)||fs.lstatSync(temp).isSymbolicLink())
      fail('unsafe temporary acceptance artifact path');
    const token=process.env.GITHUB_TOKEN||process.env.GH_TOKEN;
    if(!token)fail('missing trusted Actions read credential');
    run('gh',['run','download',String(fixture.workflow_run_id),
      '--repo',REPO,'--name',fixture.artifact_name,'--dir',temp],{
      timeout:90000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],
      env:{...process.env,GH_TOKEN:token,GITHUB_TOKEN:token},
    });
    const reportFile=path.join(temp,'cas-matrix.json');
    if(!fs.existsSync(reportFile)||fs.lstatSync(reportFile).isSymbolicLink()||
       fs.statSync(reportFile).size<100||fs.statSync(reportFile).size>64*1024)
      fail('missing or oversized current-main real CAS matrix report');
    return validateCasMatrixEvidence(JSON.parse(fs.readFileSync(reportFile,'utf8')),fixture);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
export function selfTestCasMatrixEvidence(){
  const sha='a'.repeat(40),fixture={
    verdict:'fixture_pass',repository:REPO,target_sha:sha,
    workflow_run_id:123,run_attempt:2,job_id:321,artifact_id:432,
    workflow_path:'.github/workflows/ci-run-store-fixture-evidence.yml',
    artifact_zip_digest:'sha256:'+'b'.repeat(64),
  };
  const report={schema_version:1,kind:'isolated_run_store_cas_concurrency_matrix',
    repository:REPO,verdict:'FixturePassed',coverage:3,total:3,
    observed_main_sha:sha,workflow_run_id:123,workflow_run_attempt:2,
    evidence_scope:'isolated_disposable_bare_git_only_not_server_authorization',
    production_ref_mutated:false,server_side_denial_verified:false,
    writer_identity_verified:false,independent_anchor_verified:false,
    stores:STORES.map(store=>({
      store,execution:'disposable_bare_git',
      parallel_distinct_key:'two_commits_retained',
      identical_key:'exactly_one_commit_and_one_replay',
      divergent_same_key:'rejected',immutable_overwrite:'rejected',
      deleted_remote_ref:'rejected',unrelated_ref_rewrite:'rejected',
      stale_metrics_projection:store==='metrics'?'stale_conflict_rejected':'not_applicable',
      initial_tip:sha,parallel_tip:sha,final_tip:sha,publisher_receipts:3,
    }))};
  const clone=x=>JSON.parse(JSON.stringify(x));
  assert.equal(validateCasMatrixEvidence(report,fixture).verdict,'Verified');
  assert.equal(validateCasMatrixEvidence(report,fixture).github_server_writer_authorization_verified,false);
  for(const mutation of [
    {observed_main_sha:'c'.repeat(40)},
    {workflow_run_attempt:3},{coverage:2},{server_side_denial_verified:true},
    {production_ref_mutated:true},{independent_anchor_verified:true},
    {stores:report.stores.slice(0,2)},
    {stores:report.stores.map((x,i)=>i===0?{...x,divergent_same_key:'accepted'}:x)},
    {stores:report.stores.map((x,i)=>i===2?{...x,stale_metrics_projection:'skipped'}:x)},
  ])assert.throws(()=>validateCasMatrixEvidence({...clone(report),...mutation},fixture));
  assert.throws(()=>validateCasMatrixEvidence(report,{...fixture,target_sha:'c'.repeat(40)}));
  return true;
}
