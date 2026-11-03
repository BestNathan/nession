#!/usr/bin/env node
// #1690 SC-08: authenticated current-main evidence for the existing public
// Sigstore checkpoint + read-only restore. This is a consumer, NOT a signer,
// second Store validator, or alternative Acceptance/Issue writer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const CHECKPOINT_WORKFLOW='.github/workflows/ci-run-store-anchor.yml';
export const CHECKPOINT_NAME='CI / Run Store Signed Checkpoint';
export const CHECKPOINT_JOB='Sign four-Store roots and rehearse read-only restore';
const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
const DIGEST=/^sha256:[a-f0-9]{64}$/;
const CHECKER=fileURLToPath(new URL('./run-store-sigstore-checkpoint.mjs',import.meta.url));
const STEP_NAMES=[
  'Collect four API/Git-matched immutable Store root commitments',
  'Independently sign and publicly witness checkpoint',
  'Verify Sigstore witness and rehearse read-only restore from pinned Store roots',
  'Retain checkpoint and verification evidence',
];
const reject=msg=>{throw Error('authenticated Run Store checkpoint: '+msg);};
function positive(x){return Number.isSafeInteger(x)&&x>0;}
function workflowPath(v){return v===CHECKPOINT_WORKFLOW||v===CHECKPOINT_WORKFLOW+'@refs/heads/main';}

export function checkpointScope({repo,sha,issue,stage,githubSha,githubRef}){
  return repo===REPO&&SHA.test(sha)&&issue===1690&&stage==='post-merge'&&
    githubSha===sha&&githubRef==='refs/heads/main';
}
export function authenticateCheckpointRun(run,jobs,artifacts,sha){
  if(!SHA.test(sha)||!positive(run?.id)||!positive(run?.run_attempt)||
    run.name!==CHECKPOINT_NAME||!workflowPath(run.path)||
    run.event!=='push'||run.head_branch!=='main'||run.head_sha!==sha||
    run.status!=='completed'||run.conclusion!=='success'||
    run.repository?.full_name!==REPO||run.head_repository?.full_name!==REPO)
    reject('untrusted signer Workflow/run/attempt/main source identity');
  if(!Array.isArray(jobs?.jobs)||jobs.jobs.length>100)
    reject('invalid signer Job listing');
  const matching=jobs.jobs.filter(j=>j?.name===CHECKPOINT_JOB);
  if(matching.length!==1)reject('missing/ambiguous signer Job');
  const job=matching[0];
  if(!positive(job.id)||job.run_id!==run.id||
    job.run_attempt!==run.run_attempt||job.head_sha!==sha||
    job.status!=='completed'||job.conclusion!=='success'||
    !Array.isArray(job.steps)||job.steps.length>100)
    reject('untrusted exact-attempt signer Job');
  for(const name of STEP_NAMES){
    const steps=job.steps.filter(x=>x.name===name);
    if(steps.length!==1||steps[0].status!=='completed'||
      steps[0].conclusion!=='success')
      reject('signer prerequisite step absent/failed: '+name);
  }
  if(!Array.isArray(artifacts?.artifacts)||artifacts.artifacts.length>100)
    reject('invalid signer Artifact listing');
  const name='run-store-signed-checkpoint-'+run.id+'-'+run.run_attempt;
  const found=artifacts.artifacts.filter(a=>a.name===name);
  if(found.length!==1)reject('missing/ambiguous signer Artifact');
  const art=found[0];
  if(!positive(art.id)||art.expired!==false||!positive(art.size_in_bytes)||
    !DIGEST.test(art.digest)||art.workflow_run?.id!==run.id||
    art.workflow_run?.head_sha!==sha)
    reject('expired/unbound signer Artifact ZIP identity');
  return {run_id:run.id,attempt:run.run_attempt,head_sha:sha,
    job_id:job.id,artifact_id:art.id,artifact_name:name,
    artifact_zip_digest:art.digest};
}

export function validateVerifiedCheckpoint(result,source){
  const witness=result?.witness,restore=result?.restore;
  if(result?.schema_version!==1||
    result.kind!=='run_store_external_checkpoint_and_restore_evidence'||
    witness?.kind!=='run_store_independent_signature_verification'||
    witness.verified!==true||witness.external_log_witnessed!==true||
    !DIGEST.test('sha256:'+String(witness.checkpoint_sha256??''))||
    witness.main_sha!==source.head_sha||
    restore?.kind!=='run_store_signed_checkpoint_restore_drill'||
    restore.source_main_sha!==source.head_sha||
    restore.baseline_class!=='new_observation_only_not_retroactive_attestation'||
    restore.production_ref_mutated!==false||
    restore.restored_to_temporary_git!==true||
    restore.total!==4||restore.coverage!==4||
    !Array.isArray(restore.results)||restore.results.length!==4||
    JSON.stringify(restore.results.map(x=>x.ref))!==
      JSON.stringify(['acceptance-results','task-results','metrics','agent-store'])||
    restore.results.some(x=>x.status!=='ReadOnlyRestoreVerified'||
      !SHA.test(x.baseline_sha)||!SHA.test(x.observed_sha)||
      !Number.isSafeInteger(x.checked_commits)||x.checked_commits<0||
      !Number.isSafeInteger(x.checked_changes)||x.checked_changes<0))
    reject('unverified independent signature or incomplete four-Store recovery');
  return Object.freeze({
    schema_version:1,kind:'authenticated_run_store_external_checkpoint',
    verdict:'Verified',repository:REPO,target_sha:source.head_sha,
    signer_run_id:source.run_id,signer_attempt:source.attempt,
    signer_job_id:source.job_id,
    source_workflow:CHECKPOINT_WORKFLOW,
    artifact_id:source.artifact_id,
    artifact_zip_digest:source.artifact_zip_digest,
    signed_checkpoint_sha256:witness.checkpoint_sha256,
    external_witness_verified:true,witness:witness.witness,
    recovery_status:'ReadOnlyRestoreVerified',recovered_stores:4,
    original_checkpoint_class:restore.baseline_class,
    no_production_ref_writes:true,
    writer_authorization_verified:false,
    provenance:'GitHub REST exact-main Run/attempt/Job/Artifact plus independently CLI-verified public Sigstore witness and canonical four-Store Git restore',
  });
}

export async function collectAuthenticatedCheckpoint(scope,directRuns,get,{
  execute=execFileSync, temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'nession-1690-sigstore-evidence-')),
}={}){
  if(!checkpointScope(scope))return null;
  if(!Array.isArray(directRuns)||typeof get!=='function')reject('untrusted discovery interface');
  const candidates=directRuns.filter(r=>r?.name===CHECKPOINT_NAME&&
    workflowPath(r.path)&&r.event==='push'&&r.head_branch==='main'&&
    r.head_sha===scope.sha&&r.status==='completed'&&r.conclusion==='success')
    .sort((a,b)=>b.id-a.id).slice(0,3);
  for(const candidate of candidates){
    if(!positive(candidate.id))continue;
    const base='/repos/'+REPO+'/actions/runs/'+candidate.id;
    const run=await get(base);
    if(run?.id!==candidate.id||!positive(run.run_attempt))
      reject('signer discovery run identity drift');
    const [jobs,artifacts]=await Promise.all([
      get(base+'/attempts/'+run.run_attempt+'/jobs?per_page=100'),
      get(base+'/artifacts?per_page=100'),
    ]);
    const source=authenticateCheckpointRun(run,jobs,artifacts,scope.sha);
    const dir=temp();
    try{
      if(!path.isAbsolute(dir)||fs.lstatSync(dir).isSymbolicLink())
        reject('unsafe independent verifier temporary directory');
      const env={...process.env,GH_TOKEN:process.env.GITHUB_TOKEN||process.env.GH_TOKEN,
        GITHUB_TOKEN:process.env.GITHUB_TOKEN||process.env.GH_TOKEN,
        GITHUB_REPOSITORY:REPO,GITHUB_REF:'refs/heads/main',
        GITHUB_SHA:source.head_sha,GITHUB_RUN_ID:String(source.run_id),
        GITHUB_RUN_ATTEMPT:String(source.attempt)};
      execute('gh',['run','download',String(source.run_id),'--repo',REPO,
        '--name',source.artifact_name,'--dir',dir],{
          env,timeout:90000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
      const checkpoint=path.join(dir,'checkpoint.json');
      const output=path.join(dir,'verified-acceptance.json');
      if(!fs.existsSync(checkpoint)||fs.lstatSync(checkpoint).isSymbolicLink()||
        fs.statSync(checkpoint).size<100||fs.statSync(checkpoint).size>64*1024)
        reject('missing/invalid bounded signer checkpoint');
      // The existing canonical verifier independently checks signer identity,
      // subject/predicate SHA, Rekor inclusion and four Store root ancestry.
      execute(process.execPath,[CHECKER,'verify-restore',checkpoint,output],{
        env,timeout:240000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
      if(!fs.existsSync(output)||fs.lstatSync(output).isSymbolicLink()||
        fs.statSync(output).size>64*1024)reject('missing/unbounded independent restore');
      return validateVerifiedCheckpoint(JSON.parse(fs.readFileSync(output,'utf8')),source);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
  return null; // Explicit Pending: source not completed or no unexpired evidence.
}

export function selfTestAuthenticatedCheckpoint(){
  const sha='a'.repeat(40);
  const scope={repo:REPO,sha,issue:1690,stage:'post-merge',
    githubSha:sha,githubRef:'refs/heads/main'};
  assert.equal(checkpointScope(scope),true);
  for(const diff of [{issue:42},{stage:'pre-merge'},{githubSha:'b'.repeat(40)},
    {githubRef:'refs/heads/feature'},{repo:'fork/repo'}])
    assert.equal(checkpointScope({...scope,...diff}),false);
  const ident={full_name:REPO};
  const run={id:123,run_attempt:1,name:CHECKPOINT_NAME,
    path:CHECKPOINT_WORKFLOW,event:'push',head_branch:'main',head_sha:sha,
    repository:ident,head_repository:ident,status:'completed',conclusion:'success'};
  const job={id:321,name:CHECKPOINT_JOB,run_id:123,run_attempt:1,
    head_sha:sha,status:'completed',conclusion:'success',
    steps:STEP_NAMES.map(name=>({name,status:'completed',conclusion:'success'}))};
  const artifact={id:888,name:'run-store-signed-checkpoint-123-1',
    expired:false,size_in_bytes:1000,digest:'sha256:'+'c'.repeat(64),
    workflow_run:{id:123,head_sha:sha}};
  const auth=(r=run,j=job,a=artifact)=>authenticateCheckpointRun(r,
    {jobs:[j]},{artifacts:[a]},sha);
  assert.equal(auth().artifact_id,888);
  assert.throws(()=>auth({...run,path:CHECKPOINT_WORKFLOW+'@refs/heads/evil'}));
  assert.throws(()=>auth({...run,event:'workflow_dispatch'}));
  assert.throws(()=>auth({...run,repository:{full_name:'fork/repo'}}));
  assert.throws(()=>auth({...run,head_sha:'b'.repeat(40)}));
  assert.throws(()=>auth({...run,run_attempt:2}));
  assert.throws(()=>auth(run,{...job,steps:job.steps.map((s,i)=>
    i===2?{...s,conclusion:'skipped'}:s)}));
  assert.throws(()=>auth(run,job,{...artifact,expired:true}));
  assert.throws(()=>auth(run,job,{...artifact,digest:'fake'}));
  assert.throws(()=>auth(run,job,{...artifact,workflow_run:{id:999,head_sha:sha}}));
  const roots=['acceptance-results','task-results','metrics','agent-store'];
  const report={schema_version:1,kind:'run_store_external_checkpoint_and_restore_evidence',
    witness:{kind:'run_store_independent_signature_verification',verified:true,
      external_log_witnessed:true,checkpoint_sha256:'d'.repeat(64),main_sha:sha,
      witness:'verified public Sigstore log timestamp'},
    restore:{kind:'run_store_signed_checkpoint_restore_drill',source_main_sha:sha,
      baseline_class:'new_observation_only_not_retroactive_attestation',
      restored_to_temporary_git:true,total:4,coverage:4,production_ref_mutated:false,
      results:roots.map(ref=>({ref,baseline_sha:sha,observed_sha:sha,
        checked_commits:0,checked_changes:0,status:'ReadOnlyRestoreVerified'}))}};
  const verify=x=>validateVerifiedCheckpoint(x,auth());
  assert.equal(verify(report).verdict,'Verified');
  assert.equal(verify(report).writer_authorization_verified,false);
  assert.throws(()=>verify({...report,witness:{...report.witness,external_log_witnessed:false}}));
  assert.throws(()=>verify({...report,restore:{...report.restore,coverage:3}}));
  assert.throws(()=>verify({...report,restore:{...report.restore,production_ref_mutated:true}}));
  assert.throws(()=>verify({...report,restore:{...report.restore,
    results:report.restore.results.map((x,i)=>i===0?{...x,ref:'wrong'}:x)}}));
  return true;
}
