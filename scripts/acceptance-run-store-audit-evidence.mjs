// #1690 SC-07: bind an actual, independently Sigstore-signed read-only
// original-Rekor audit to exact GitHub Run/Attempt/Job and retained artifacts.
// The source-run's success alone is NEVER proof of audited Git content.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';

const REPO='BestNathan/nession';
const WORKFLOW='.github/workflows/ci-run-store-integrity-audit.yml';
const NAME='CI / Run Store Integrity Audit';
const JOB='Read-only original Rekor checkpoint + forensic drill';
const SIGNER=REPO+'/'+WORKFLOW;
const PREDICATE='https://github.com/BestNathan/nession/attestation/run-store-audit/v1';
const SHA=/^[a-f0-9]{40}$/,DIGEST=/^sha256:[a-f0-9]{64}$/;
const REFS=Object.freeze(['acceptance-results','task-results','metrics','agent-store']);
const CASES=Object.freeze([
  'immutable_record_overwrite','immutable_record_omission',
  'sha_index_repoint','non_ancestor_ref_replacement',
  'forged_receipt_digest','missing_receipt_source',
  'unexpected_ingester_workflow',
]);
const STEPS=Object.freeze([
  'Checkout exact trusted main SHA without Git writer tokens',
  'Verify canonical immutable, source, receipt and writer negatives',
  'Seed and detect illegal mutations in disposable Git only',
  'Verify original independent Rekor baseline against four live Git histories',
  'Append signed durable public audit report to Sigstore log',
  'Retain read-only audit and incident case evidence even on failure',
  'Emit attributable audit result',
]);
const POS=x=>Number.isSafeInteger(x)&&x>0;
const fail=msg=>{throw Error('authenticated Run Store integrity audit: '+msg);};
const workflowPath=x=>x===WORKFLOW||x===WORKFLOW+'@refs/heads/main';

export function authenticateAuditRun(run,jobs,artifacts,sha){
  if(!SHA.test(sha)||!POS(run?.id)||!POS(run.run_attempt)||
    run.name!==NAME||!workflowPath(run.path)||
    !['push','schedule','repository_dispatch'].includes(run.event)||
    run.head_branch!=='main'||run.head_sha!==sha||
    run.repository?.full_name!==REPO||
    run.head_repository?.full_name!==REPO||
    run.status!=='completed'||run.conclusion!=='success')
    fail('untrusted read-only main audit source Workflow');
  if(!Array.isArray(jobs?.jobs)||jobs.jobs.length>10)
    fail('invalid audit Job collection');
  const matches=jobs.jobs.filter(j=>j?.name===JOB);
  if(matches.length!==1)fail('missing/ambiguous original Rekor audit Job');
  const job=matches[0];
  if(!POS(job.id)||job.run_id!==run.id||
    job.run_attempt!==run.run_attempt||job.head_sha!==sha||
    job.status!=='completed'||job.conclusion!=='success'||
    !Array.isArray(job.steps)||job.steps.length>40)
    fail('untrusted exact-attempt audit Job');
  for(const name of STEPS){
    const steps=job.steps.filter(x=>x?.name===name);
    if(steps.length!==1||steps[0].status!=='completed'||
       steps[0].conclusion!=='success')
      fail('audit prerequisite missing/failed: '+name);
  }
  if(!Array.isArray(artifacts?.artifacts)||artifacts.artifacts.length>100)
    fail('invalid or excessively large audit Artifact listing');
  const name='run-store-original-rekor-audit-'+run.id+'-'+run.run_attempt;
  const artifactsFound=artifacts.artifacts.filter(x=>x.name===name);
  if(artifactsFound.length!==1)
    fail('missing/ambiguous exact-attempt original-Rekor Artifact');
  const artifact=artifactsFound[0];
  if(!POS(artifact.id)||artifact.expired!==false||
    !POS(artifact.size_in_bytes)||!DIGEST.test(artifact.digest)||
    artifact.workflow_run?.id!==run.id||
    artifact.workflow_run?.head_sha!==sha)
    fail('expired or unbound audit Artifact');
  return Object.freeze({
    run_id:run.id,attempt:run.run_attempt,main_sha:sha,
    event:run.event,job_id:job.id,artifact_id:artifact.id,
    artifact_name:name,artifact_zip_digest:artifact.digest,
  });
}

export function validateSignedAudit(report,drill,verified,identity){
  if(report?.schema_version!==1||
    report.kind!=='run_store_original_signed_baseline_history_audit'||
    report.repository!==REPO||report.verdict!=='Verified'||
    report.audit_source!=='independent_first_good_Rekor'||
    report.baseline_source_main_sha!=='ccd0858b6bc06cf5c22e0efc1a9f2100974a568f'||
    report.baseline_source_run_id!==41613325000||
    report.pinned_log_index!==3665505739||
    report.pinned_attestation_id!==63042719||
    report.external_subject_sha256!==
      'd6579886c6150f34b373901b29ad2aecf9d624b91004e7f87675d6dc3062e690'||
    report.independent_sigstore_witness_verified!==true||
    report.no_production_ref_mutation!==true||
    report.writer_authorization_verified!==false||
    report.legacy_records_predating_anchor!=='not_retroactively_authenticated'||
    report.audited_main_sha!==identity?.main_sha||
    report.audit_run_id!==identity?.run_id||
    report.audit_run_attempt!==identity?.attempt||
    report.total!==4||report.coverage!==4||
    report.alert_channel!=='GitHub Actions failure and error annotation if audit fails'||
    !Array.isArray(report.verified_history)||report.verified_history.length!==4||
    JSON.stringify(report.verified_history.map(x=>x.ref))!==JSON.stringify(REFS)||
    report.verified_history.some(x=>x.status!=='ReadOnlyRestoreVerified'||
      !SHA.test(x.baseline_sha??'')||!SHA.test(x.observed_sha??'')||
      !Number.isSafeInteger(x.checked_commits)||x.checked_commits<0||
      !Number.isSafeInteger(x.checked_changes)||x.checked_changes<0))
    fail('original Rekor-pinned live 4/4 audit report cannot be trusted');

  if(drill?.schema_version!==1||
    drill.kind!=='isolated_run_store_integrity_incident_drill'||
    drill.verdict!=='FixtureDetectionPassed'||
    drill.execution_mode!=='isolated_disposable_local_git'||
    drill.repository!==REPO||
    drill.observed_main_sha!==identity.main_sha||
    Number(drill.github_run_id)!==identity.run_id||
    Number(drill.github_run_attempt)!==identity.attempt||
    drill.coverage!==CASES.length||drill.total!==CASES.length||
    drill.production_ref_mutated!==false||
    drill.server_side_denials_verified!==false||
    drill.unexpected_writer_identity_verified!==false||
    drill.referential_source_integrity_verified!==false||
    drill.independent_anchor_verified!==false||
    drill.external_alert_channel_verified!==false||
    !Array.isArray(drill.cases)||drill.cases.length!==CASES.length||
    JSON.stringify(drill.cases.map(c=>c.id))!==JSON.stringify(CASES)||
    drill.cases.some(c=>c.status!=='Detected'||
      c.seed!=='disposable_local_git_only'||
      c.valid_append_preflight!=='Accepted'||
      !SHA.test(c.baseline_sha??'')||!SHA.test(c.observed_sha??'')||
      c.baseline_sha===c.observed_sha))
    fail('missing exact-run seven-case disposable incident drill');

  const bytes=Buffer.from(JSON.stringify(report,null,2)+'\n','utf8');
  const sha256=crypto.createHash('sha256').update(bytes).digest('hex');
  if(!Array.isArray(verified)||verified.length<1||verified.length>20)
    fail('independent GitHub Sigstore verification missing');
  const witness=verified.find(v=>{
    const result=v?.verificationResult;
    const st=result?.statement;
    const bundle=v?.attestation?.bundle??v?.attestation;
    const entries=bundle?.verificationMaterial?.tlogEntries;
    return st?.predicateType===PREDICATE&&
      isDeepStrictEqual(st.predicate,report)&&
      Array.isArray(st.subject)&&st.subject.length===1&&
      st.subject[0]?.digest?.sha256===sha256&&
      Array.isArray(result.verifiedTimestamps)&&result.verifiedTimestamps.length>0&&
      Array.isArray(entries)&&entries.length>0&&
      entries.some(e=>Number.isSafeInteger(Number(e.logIndex))&&
        Number(e.logIndex)>=0&&(e.inclusionProof||e.inclusionPromise));
  });
  if(!witness)fail('no exact signed audit report/predicate/subject/Rekor witness');
  const entries=(witness.attestation?.bundle??witness.attestation)
    .verificationMaterial.tlogEntries;
  const signedLog=entries.find(e=>
    Number.isSafeInteger(Number(e.logIndex))&&Number(e.logIndex)>=0&&
    (e.inclusionProof||e.inclusionPromise)).logIndex;
  return Object.freeze({
    kind:'authenticated_run_store_integrity_audit',schema_version:1,
    repository:REPO,verdict:'Verified',
    target_sha:identity.main_sha,
    audit_run_id:identity.run_id,audit_attempt:identity.attempt,
    audit_job_id:identity.job_id,
    source_workflow:WORKFLOW,source_event:identity.event,
    artifact_id:identity.artifact_id,
    artifact_zip_digest:identity.artifact_zip_digest,
    original_baseline_rekor_index:report.pinned_log_index,
    signed_audit_rekor_index:Number(signedLog),
    signed_audit_sha256:sha256,
    original_signed_baseline_verified:true,
    four_live_store_histories_verified:true,
    covered_stores:report.verified_history.map(x=>({
      ref:x.ref,baseline_sha:x.baseline_sha,observed_sha:x.observed_sha,
      checked_commits:x.checked_commits,checked_changes:x.checked_changes,
      status:x.status,
    })),
    isolated_violation_detection:drill.cases.map(x=>({
      id:x.id,status:x.status,valid_append_preflight:x.valid_append_preflight,
    })),
    applicable_gate_steps_verified:true,
    report_independently_sigstore_reverified:true,
    reporter_alert_channel:report.alert_channel,
    no_automatic_repair:true,no_production_ref_mutation:true,
    github_server_writer_authorization_verified:false,
    external_alert_delivery_verified:false,
    pre_baseline_history_authenticated:false,
    provenance:'GitHub REST exact-main Run/attempt/Job/retained Artifact + independently verified Sigstore report with original Rekor-pinned four-Store history and isolated detection cases',
  });
}

export async function collectAuthenticatedAudit(scope,directRuns,get,{
  execute=execFileSync,
  temporary=()=>fs.mkdtempSync(path.join(os.tmpdir(),'nession-store-audit-acceptance-')),
}={}){
  const {repo,sha,issue,stage,githubSha,githubRef}=scope??{};
  if(repo!==REPO||issue!==1690||stage!=='post-merge'||
    !SHA.test(sha)||githubSha!==sha||githubRef!=='refs/heads/main')return null;
  if(!Array.isArray(directRuns)||typeof get!=='function')
    fail('untrusted original-Rekor audit source discovery');
  const candidates=directRuns.filter(r=>r?.name===NAME&&
    workflowPath(r.path)&&['push','schedule','repository_dispatch'].includes(r.event)&&
    r.head_branch==='main'&&r.head_sha===sha&&
    r.status==='completed'&&r.conclusion==='success')
    .sort((a,b)=>b.id-a.id).slice(0,3);
  for(const candidate of candidates){
    const base='/repos/'+REPO+'/actions/runs/'+candidate.id;
    const run=await get(base);
    if(run?.id!==candidate.id||!POS(run.run_attempt))
      fail('original-Rekor audit run identity changed');
    const [jobs,artifacts]=await Promise.all([
      get(base+'/attempts/'+run.run_attempt+'/jobs?per_page=100'),
      get(base+'/artifacts?per_page=100'),
    ]);
    const identity=authenticateAuditRun(run,jobs,artifacts,sha);
    const temp=temporary();
    try{
      if(!path.isAbsolute(temp)||fs.lstatSync(temp).isSymbolicLink())
        fail('unsafe independent audit temporary directory');
      const token=process.env.GITHUB_TOKEN||process.env.GH_TOKEN;
      if(!token)fail('trusted GitHub Actions read credential unavailable');
      const env={...process.env,GH_TOKEN:token,GITHUB_TOKEN:token};
      execute('gh',['run','download',String(identity.run_id),
        '--repo',REPO,'--name',identity.artifact_name,'--dir',temp],{
        env,timeout:90000,maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe'],
      });
      const read=name=>{
        const file=path.join(temp,name);
        if(!fs.existsSync(file)||fs.lstatSync(file).isSymbolicLink()||
          fs.statSync(file).size<100||fs.statSync(file).size>64*1024)
          fail('original-Rekor audit Artifact missing/bad '+name);
        return {file,data:JSON.parse(fs.readFileSync(file,'utf8'))};
      };
      const audit=read('audit.json'),drill=read('seeded-violations.json');
      const out=execute('gh',['attestation','verify',audit.file,
        '--repo',REPO,'--signer-workflow',SIGNER,
        '--predicate-type',PREDICATE,'--format','json'],{
        env,timeout:90000,maxBuffer:4*1024*1024,
        encoding:'utf8',stdio:['ignore','pipe','pipe'],
      });
      const verified=JSON.parse(out);
      return validateSignedAudit(audit.data,drill.data,verified,identity);
    }finally{fs.rmSync(temp,{force:true,recursive:true});}
  }
  return null;
}
export function selfTestAuthenticatedAudit(){
  const sha='a'.repeat(40),repo={full_name:REPO};
  const run={id:123,run_attempt:2,name:NAME,path:WORKFLOW,
    event:'push',head_branch:'main',head_sha:sha,
    status:'completed',conclusion:'success',repository:repo,head_repository:repo};
  const jobs={jobs:[{
    id:456,run_id:123,run_attempt:2,head_sha:sha,
    name:JOB,status:'completed',conclusion:'success',
    steps:STEPS.map(name=>({name,status:'completed',conclusion:'success'})),
  }]};
  const artifacts={artifacts:[{
    id:789,expired:false,size_in_bytes:1000,
    name:'run-store-original-rekor-audit-123-2',
    digest:'sha256:'+'b'.repeat(64),
    workflow_run:{id:123,head_sha:sha},
  }]};
  const auth=(r=run,j=jobs,a=artifacts)=>authenticateAuditRun(r,j,a,sha);
  assert.equal(auth().run_id,123);
  assert.throws(()=>auth({...run,event:'pull_request'}));
  assert.throws(()=>auth({...run,head_sha:'c'.repeat(40)}));
  assert.throws(()=>auth({...run,run_attempt:3}));
  assert.throws(()=>auth({...run,path:WORKFLOW+'@refs/heads/attack'}));
  assert.throws(()=>auth(run,{jobs:[{...jobs.jobs[0],steps:STEPS.map(name=>
    ({name,status:'completed',conclusion:name===STEPS[3]?'failure':'success'}))}]}));
  assert.throws(()=>auth(run,jobs,{artifacts:[{...artifacts.artifacts[0],expired:true}]}));

  const identity={...auth(),event:'push'};
  const report={schema_version:1,
    kind:'run_store_original_signed_baseline_history_audit',
    repository:REPO,verdict:'Verified',audit_source:'independent_first_good_Rekor',
    baseline_source_main_sha:'ccd0858b6bc06cf5c22e0efc1a9f2100974a568f',
    baseline_source_run_id:41613325000,pinned_log_index:3665505739,
    pinned_attestation_id:63042719,
    external_subject_sha256:
      'd6579886c6150f34b373901b29ad2aecf9d624b91004e7f87675d6dc3062e690',
    independent_sigstore_witness_verified:true,no_production_ref_mutation:true,
    writer_authorization_verified:false,
    legacy_records_predating_anchor:'not_retroactively_authenticated',
    audited_main_sha:sha,audit_run_id:123,audit_run_attempt:2,
    total:4,coverage:4,alert_channel:
      'GitHub Actions failure and error annotation if audit fails',
    verified_history:REFS.map(ref=>({
      ref,baseline_sha:'a'.repeat(40),observed_sha:'b'.repeat(40),
      checked_commits:3,checked_changes:12,status:'ReadOnlyRestoreVerified',
    })),
  };
  const drill={schema_version:1,kind:'isolated_run_store_integrity_incident_drill',
    verdict:'FixtureDetectionPassed',execution_mode:'isolated_disposable_local_git',
    repository:REPO,observed_main_sha:sha,github_run_id:'123',
    github_run_attempt:'2',coverage:CASES.length,total:CASES.length,
    production_ref_mutated:false,server_side_denials_verified:false,
    unexpected_writer_identity_verified:false,
    referential_source_integrity_verified:false,independent_anchor_verified:false,
    external_alert_channel_verified:false,
    cases:CASES.map(id=>({id,status:'Detected',
      seed:'disposable_local_git_only',valid_append_preflight:'Accepted',
      baseline_sha:'a'.repeat(40),observed_sha:'b'.repeat(40)})),
  };
  const digest=crypto.createHash('sha256')
    .update(JSON.stringify(report,null,2)+'\n').digest('hex');
  const verified=[{verificationResult:{statement:{
    predicateType:PREDICATE,predicate:report,
    subject:[{digest:{sha256:digest}}],
  },verifiedTimestamps:[{timestamp:'2026-11-04T00:36:37Z'}]},
  attestation:{bundle:{verificationMaterial:{tlogEntries:[{
    logIndex:3683693831,inclusionProof:{rootHash:'example'},
  }]}}}}];
  const verify=(r=report,d=drill,v=verified,source=identity)=>
    validateSignedAudit(r,d,v,source);
  assert.equal(verify().verdict,'Verified');
  for(const mutation of [
    {audited_main_sha:'c'.repeat(40)},{audit_run_attempt:1},
    {coverage:3},{writer_authorization_verified:true},
    {external_subject_sha256:'f'.repeat(64)},
    {verified_history:report.verified_history.slice(0,3)},
  ])assert.throws(()=>verify({...report,...mutation}));
  for(const mutation of [
    {coverage:3},{production_ref_mutated:true},
    {cases:drill.cases.slice(0,3)},
  ])assert.throws(()=>verify(report,{...drill,...mutation}));
  assert.throws(()=>verify(report,drill,[{...verified[0],
    verificationResult:{...verified[0].verificationResult,
      statement:{...verified[0].verificationResult.statement,
        subject:[{digest:{sha256:'f'.repeat(64)}}]}}}]));
  assert.throws(()=>verify(report,drill,verified,{...identity,run_id:999}));
  return true;
}
