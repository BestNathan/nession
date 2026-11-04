// #1690 SC-10: authenticate *executed agent-store-specific* fixture
// outcomes from the canonical read-only main Gate, never infer them from a
// three-Store CAS matrix or assert that the real agent-store was provisioned.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {collectRunStoreFixtureEvidence} from './acceptance-run-store-fixture-evidence.mjs';

const REPO='BestNathan/nession',SHA=/^[a-f0-9]{40}$/;
const BAD='not_tested';
const fail=s=>{throw Error('agent-store disposable acceptance evidence: '+s);};
const EXPECTED=Object.freeze({
 encrypted_immutable_checkpoint:'aes_256_gcm_ciphertext_authenticated_and_roundtripped',
 public_git_secret_bytes:'absent_in_all_tracked_blobs',
 immutable_checkpoint_edit:'rejected_by_staged_integrity_and_publisher',
 immutable_checkpoint_delete:'rejected_by_staged_integrity_and_publisher',
 pointer_cas_sequence:'v1_to_v2_to_v3_authorized',
 stale_pointer_cas:'rejected_before_refresh',
 refreshed_pointer_cas:'authorized_success',
 deleted_remote_ref:'rejected_without_reinitialization',
});
export function verifyAgentStoreFixtureReport(report,source){
  if(!source||source.kind!=='verified_agent_store_disposable_fixture'||
     source.verdict!=='fixture_pass'||source.repository!==REPO||
     !SHA.test(source.target_sha??'')||
     report?.schema_version!==1||
     report.kind!=='agent_store_disposable_cas_fixture_evidence'||
     report.repository!==REPO||report.target_sha!==source.target_sha||
     report.workflow_run_id!==source.workflow_run_id||
     report.workflow_run_attempt!==source.run_attempt||
     report.store!=='agent-store'||
     report.execution!=='disposable_bare_git'||
     report.verdict!=='FixturePassed'||
     report.plaintext_or_secret_material_retained!==false||
     report.real_agent_store!==BAD||
     report.github_ruleset_enforcement!==BAD||
     report.real_writer_authorization!==BAD||
     report.external_anchor!=='not_provisioned'||
     report.audit_checked_commits!==2||report.audit_checked_changes!==4||
     !SHA.test(report.baseline_sha??'')||
     !SHA.test(report.first_advance_sha??'')||
     !SHA.test(report.second_advance_sha??'')||
     report.first_advance_sha===report.second_advance_sha||
     Object.entries(EXPECTED).some(([key,value])=>report[key]!==value))
    fail('unverified executed agent-store sealing, immutable delta or CAS pointer scenario');
  return {
    schema_version:1,kind:'authenticated_agent_store_disposable_fixture',
    repository:REPO,target_sha:source.target_sha,
    source_workflow:source.workflow_path,
    source_run_id:source.workflow_run_id,source_attempt:source.run_attempt,
    source_job_id:source.job_id,source_artifact_id:source.artifact_id,
    source_artifact_zip_digest:source.artifact_zip_digest,
    gate_ids:source.gate_ids,store:'agent-store',
    verdict:'Verified',executable_results:{...EXPECTED},
    audited_commits:report.audit_checked_commits,
    audited_changes:report.audit_checked_changes,
    baseline_sha:report.baseline_sha,
    authorized_first_pointer_sha:report.first_advance_sha,
    authorized_final_pointer_sha:report.second_advance_sha,
    no_private_plaintext_in_public_git:true,
    production_agent_store_provisioned:false,
    github_server_write_authorization_verified:false,
    independent_anchor_verified_by_fixture:false,
    proof_scope:'authenticated main-run actual isolated agent-store AES256-GCM, immutable overwrite/deletion, successful CAS pointer advances and failed stale CAS; not real agent-store',
  };
}
export async function collectAuthenticatedAgentFixture(repo,sha,directRuns,get,{
  run=execFileSync,
  makeTemp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'nession-agent-store-sc10-')),
}={}){
  if(repo!==REPO||!SHA.test(sha)||!Array.isArray(directRuns)||typeof get!=='function')
    fail('invalid source query scope');
  const candidates=await collectRunStoreFixtureEvidence(repo,sha,directRuns,get);
  if(candidates.length!==1)return null;
  const source=candidates[0];
  const home=makeTemp();
  try{
    if(!path.isAbsolute(home)||fs.lstatSync(home).isSymbolicLink())
      fail('untrusted temporary evidence path');
    const token=process.env.GITHUB_TOKEN||process.env.GH_TOKEN;
    if(!token)fail('missing trusted GitHub Actions read token');
    run('gh',['run','download',String(source.workflow_run_id),'--repo',REPO,
      '--name',source.artifact_name,'--dir',home],{
      timeout:90000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],
      env:{...process.env,GH_TOKEN:token,GITHUB_TOKEN:token}});
    const file=path.join(home,'agent-store.json');
    if(!fs.existsSync(file)||fs.lstatSync(file).isSymbolicLink()||
       fs.statSync(file).size<250||fs.statSync(file).size>16384)
      fail('missing, unsafe or oversized agent-store-specific executable receipt');
    return verifyAgentStoreFixtureReport(JSON.parse(fs.readFileSync(file,'utf8')),source);
  }finally{fs.rmSync(home,{force:true,recursive:true});}
}
export function selfTestAuthenticatedAgentFixture(){
  const sha='a'.repeat(40),source={
    kind:'verified_agent_store_disposable_fixture',verdict:'fixture_pass',
    repository:REPO,target_sha:sha,workflow_run_id:42,run_attempt:2,
    artifact_zip_digest:'sha256:'+'b'.repeat(64),
    workflow_path:'.github/workflows/ci-run-store-fixture-evidence.yml',
    job_id:88,artifact_id:91,gate_ids:['agent-checkpoint-store','run-store-integrity'],
  };
  const report={
    schema_version:1,kind:'agent_store_disposable_cas_fixture_evidence',
    repository:REPO,target_sha:sha,workflow_run_id:42,workflow_run_attempt:2,
    store:'agent-store',execution:'disposable_bare_git',
    ...EXPECTED,verdict:'FixturePassed',
    plaintext_or_secret_material_retained:false,
    real_agent_store:BAD,github_ruleset_enforcement:BAD,real_writer_authorization:BAD,
    external_anchor:'not_provisioned',audit_checked_commits:2,audit_checked_changes:4,
    baseline_sha:sha,first_advance_sha:'b'.repeat(40),second_advance_sha:'c'.repeat(40),
  };
  const verify=(r=report,s=source)=>verifyAgentStoreFixtureReport(r,s);
  assert.equal(verify().verdict,'Verified');
  assert.equal(verify().production_agent_store_provisioned,false);
  const alter=(field,value)=>assert.throws(()=>verify({...report,[field]:value}));
  alter('target_sha','d'.repeat(40));
  alter('workflow_run_attempt',1);
  alter('store','metrics');
  alter('execution','production');
  alter('stale_pointer_cas','not_tested');
  alter('immutable_checkpoint_delete','skipped');
  alter('public_git_secret_bytes','unverified');
  alter('real_agent_store','active');
  alter('github_ruleset_enforcement','verified');
  alter('audit_checked_changes',3);
  alter('plaintext_or_secret_material_retained',true);
  alter('second_advance_sha',report.first_advance_sha);
  assert.throws(()=>verify(report,{...source,target_sha:'d'.repeat(40)}));
  return true;
}
