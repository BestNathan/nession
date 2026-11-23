#!/usr/bin/env node
// #4342 SC-08: independent main-owned post-Store delivery receipt.
// A successful workflow conclusion NEVER implies a Review approval or SC Pass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {buildAgentWorkflowTelemetry,validateAgentWorkflowTelemetry,telemetryStoragePath}
  from './agent-workflow-telemetry.mjs';

const REPO='BestNathan/nession', SHA=/^[a-f0-9]{40}$/;
const BOUND=Object.freeze({
  source:45167810720,writer:45168056749,
  sha:'bc654241787cdf28ca854cbecd683fa5942101f6',
  merged_at:'2026-11-23T11:43:57Z',
  source_path:'.github/workflows/agent-provider-smoke.yml',
  writer_path:'.github/workflows/metrics-agent-telemetry.yml',
  raw:'raw/workflows/agent-provider-smoke/2026-11-23/45167810720-1-issue-1556-staging-claude-code.json',
});
function reject(x){throw Error('4342 post-Store preservation: '+x);}
function positive(x){return Number.isSafeInteger(x)&&x>0;}
function runs(r,id,workflow,event) {
  return r?.id===id&&r.run_attempt===1&&r.path===workflow&&
    r.event===event&&r.head_branch==='main'&&r.head_sha===BOUND.sha&&
    r.repository?.full_name===REPO&&r.head_repository?.full_name===REPO&&
    r.status==='completed'&&r.conclusion==='success';
}
function artifacts(list,name){
  if(!Array.isArray(list?.artifacts)||list.artifacts.length>100||
     list.total_count!==list.artifacts.length)reject('incomplete Artifact listing');
  const matches=list.artifacts.filter(x=>x.name===name);
  if(matches.length!==1||!positive(matches[0].id)||
     matches[0].expired!==false||!positive(matches[0].size_in_bytes))
    reject('untrusted/expired expected Artifact '+name);
  return matches[0].id;
}
function receiptFromLog(log) {
  if(typeof log!=='string'||Buffer.byteLength(log)>8*1024*1024)
    reject('untrusted writer log');
  const found=log.split(/\r?\n/).filter(x=>x.includes('"kind":"run_store_receipt_readback"'));
  if(found.length!==1)reject('missing or duplicate immutable Store receipt');
  const start=found[0].indexOf('{');
  try{return JSON.parse(found[0].slice(start));}
  catch{reject('malformed Store receipt');}
}
export function attest4342Downstream({source,writer,sourceArtifacts,writerArtifacts,
  jobs,log,raw,recordCommits,reviewListing}) {
  if(!runs(source,BOUND.source,BOUND.source_path,'push')||
     !runs(writer,BOUND.writer,BOUND.writer_path,'workflow_run'))
    reject('source/writer provenance mismatch');
  const sources=[
    'agent-telemetry-provider-smoke-qwen-45167810720-1',
    'agent-telemetry-provider-smoke-qwen-reviewer-45167810720-1',
    'agent-telemetry-provider-smoke-qwen-developer-45167810720-1',
  ];
  const sourceIds=sources.map(n=>artifacts(sourceArtifacts,n));
  const receiptArtifactId=artifacts(writerArtifacts,
    'run-store-receipt-45168056749-1-agent');
  if(!Array.isArray(jobs?.jobs)||jobs.jobs.length>100)
    reject('unbounded source writer jobs');
  const matches=jobs.jobs.filter(j=>j.name==='ingest');
  if(matches.length!==1||!positive(matches[0].id)||
     matches[0].run_id!==writer.id||matches[0].run_attempt!==1||
     matches[0].status!=='completed'||matches[0].conclusion!=='success')
    reject('untrusted writer job');
  const required=['Validate and append immutable telemetry','Commit metrics history',
    'Verify immutable Git bytes before uploading Run Store receipts',
    'Notify Acceptance of durable Provider evidence'];
  for(const name of required){
    if((matches[0].steps??[]).filter(s=>s.name===name&&s.conclusion==='success').length!==1)
      reject('post-Store notification/commit did not execute: '+name);
  }
  if((matches[0].steps??[]).filter(s=>
    s.name==='Notify Store of durable Reviewer evidence'&&s.conclusion==='skipped').length!==1)
    reject('Provider writer improperly emitted Reviewer notification');
  if(!log.includes('SOURCE_RUN_ID: '+source.id)||
     !log.includes('EXPECTED_WORKFLOW_ID: agent-provider-smoke'))
    reject('source/group binding absent from trusted log');
  const receipt=receiptFromLog(log);
  if(receipt.kind!=='run_store_receipt_readback'||receipt.schema_version!==1||
     receipt.store!=='metrics'||!SHA.test(receipt.commit_sha??'')||
     receipt.source_run_id!==String(source.id)||
     receipt.ingester_run_id!==String(writer.id)||
     !positive(receipt.checked_records)||!positive(receipt.changed_records))
    reject('missing trusted source-bound Store receipt');
  validateAgentWorkflowTelemetry(raw);
  if(raw.identity.github_run_id!==source.id||
     raw.identity.github_run_attempt!==source.run_attempt||
     raw.identity.workflow_id!=='agent-provider-smoke'||
     raw.identity.repository!==REPO||raw.identity.event!==source.event||
     telemetryStoragePath(raw)!==BOUND.raw||
     raw.task?.issue!==1556)
    reject('immutable Provider raw record mismatch');
  if(!Array.isArray(recordCommits)||recordCommits.length!==1||
     recordCommits[0]?.sha!==receipt.commit_sha)
    reject('missing unique immutable Store path history/commit');
  // A Reviewer launched after the original fix would require its own true
  // post-persistence Store notification. No eligible source => explicit N/A.
  if(!Number.isSafeInteger(reviewListing?.total_count)||reviewListing.total_count<0||
     reviewListing.total_count>100||
     !Array.isArray(reviewListing.workflow_runs)||
     reviewListing.workflow_runs.length!==reviewListing.total_count)
    reject('bounded Reviewer applicability listing unavailable');
  const eligible=reviewListing.workflow_runs.filter(r=>
    r?.path==='.github/workflows/agent-review.yml'&&
    r?.repository?.full_name===REPO&&
    Number.isFinite(Date.parse(r.created_at??''))&&
    Date.parse(r.created_at)>=Date.parse(BOUND.merged_at));
  if(eligible.length)reject('Reviewer post-Store applicability requires its own readback');
  return Object.freeze({
    kind:'verified_4342_poststore_delivery',status:'authenticated',
    source_sha:BOUND.sha,provider_source_run_id:source.id,
    provider_writer_run_id:writer.id,provider_writer_job_id:matches[0].id,
    provider_source_artifacts:sourceIds,provider_receipt_artifact:receiptArtifactId,
    metrics_commit_sha:receipt.commit_sha,raw_path:BOUND.raw,
    immutable_path_commit_count:recordCommits.length,
    provider_notification:'posted_after_store_commit',
    reviewer_notification:'not_applicable_no_reviewer_source_since_fix',
    reviewer_scope_start:BOUND.merged_at,
    reviewer_sources_checked:reviewListing.total_count,
    reviewer_scope_end:new Date().toISOString(),
    business_outcome:'unobserved_not_inferred',
  });
}
export function verified4342DownstreamCriterion(context,normalized){
  if(Number(context?.issue?.number)!==4342||context.stage!=='post-merge')
    return normalized;
  const item=normalized.criteria?.find(x=>x.criterion==='SC-08');
  if(!item)return normalized;
  const p=context.ci_evidence?.verified_4342_poststore_delivery;
  const ok=p?.kind==='verified_4342_poststore_delivery'&&
    p.status==='authenticated'&&p.target_sha===context.target_ref&&
    p.source_sha===BOUND.sha&&p.provider_source_run_id===BOUND.source&&
    p.provider_writer_run_id===BOUND.writer&&
    p.provider_notification==='posted_after_store_commit'&&
    p.reviewer_notification==='not_applicable_no_reviewer_source_since_fix'&&
    p.immutable_path_commit_count===1&&SHA.test(p.metrics_commit_sha??'');
  if(!ok){
    if(item.result==='Pass')reject('SC-08 Pass lacks authenticated post-Store proof');
    return normalized;
  }
  if(item.result==='Fail'||item.result==='N/A')return normalized;
  return {...normalized,criteria:normalized.criteria.map(x=>x.criterion!=='SC-08'?x:{
    ...x,result:'Pass',summary:'Provider notification followed immutable Metrics Store commit; no eligible Reviewer Run in independently scoped source listing; no Approval/SC outcome inferred',
    evidence:[{type:'authenticated-poststore',
      value:'Provider '+p.provider_source_run_id+' -> writer '+p.provider_writer_run_id+
        ', job '+p.provider_writer_job_id+', receipt '+p.provider_receipt_artifact+
        ', immutable Git '+p.metrics_commit_sha+', Reviewer N/A as of '+p.reviewer_scope_end}],
  })};
}
function gh(endpoint){
  return JSON.parse(execFileSync('gh',['api','repos/'+REPO+'/'+endpoint],
    {encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']}));
}
function ghText(endpoint){
  return execFileSync('gh',['api','repos/'+REPO+'/'+endpoint],
    {encoding:'utf8',timeout:30000,maxBuffer:9*1024*1024,stdio:['ignore','pipe','pipe']});
}
function gitJsonBlob(relative,commit){
  if(!SHA.test(commit))reject('invalid immutable blob ref');
  const entry=gh('contents/'+relative+'?ref='+commit);
  if(entry?.path!==relative||entry.type!=='file'||entry.encoding!=='base64'||
     typeof entry.content!=='string')reject('untrusted Store contents');
  return JSON.parse(Buffer.from(entry.content.replace(/\s/g,''),'base64').toString('utf8'));
}
function collect(file,sha){
  if(process.env.GITHUB_REPOSITORY!==REPO||
     process.env.ACCEPTANCE_STAGE!=='post-merge'||process.env.ISSUE_NUMBER!=='4342'||
     !SHA.test(sha))reject('unauthorized SC-08 read-only collector');
  const workspace=path.join(process.env.GITHUB_WORKSPACE??'','workspace');
  const rev=execFileSync('git',['-C',workspace,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  if(rev!==sha)reject('unverified acceptance target checkout');
  try{execFileSync('git',['-C',workspace,'merge-base','--is-ancestor',BOUND.sha,sha],
      {stdio:'ignore',timeout:20000});}
  catch{reject('original source SHA is not ancestor of accepted main');}
  const evidence=JSON.parse(fs.readFileSync(file,'utf8'));
  if(evidence?.kind!=='acceptance_ci_evidence'||evidence.target_sha!==sha)
    reject('untrusted Acceptance evidence target');
  const source=gh('actions/runs/'+BOUND.source),writer=gh('actions/runs/'+BOUND.writer);
  const sourceArtifacts=gh('actions/runs/'+BOUND.source+'/artifacts?per_page=100');
  const writerArtifacts=gh('actions/runs/'+BOUND.writer+'/artifacts?per_page=100');
  const jobs=gh('actions/runs/'+BOUND.writer+'/attempts/1/jobs?per_page=100');
  const ingest=jobs.jobs?.filter(j=>j.name==='ingest')??[];
  if(ingest.length!==1||!positive(ingest[0].id))reject('no unique writer');
  const log=ghText('actions/jobs/'+ingest[0].id+'/logs');
  const receipt=receiptFromLog(log);
  const raw=gitJsonBlob(BOUND.raw,receipt.commit_sha);
  const recordCommits=gh('commits?sha=metrics&path='+BOUND.raw+'&per_page=10');
  const reviewListing=gh('actions/workflows/agent-review.yml/runs?created=2026-11-23..'+
    new Date().toISOString().slice(0,10)+'&per_page=100');
  const proof=attest4342Downstream({source,writer,sourceArtifacts,writerArtifacts,
    jobs,log,raw,recordCommits,reviewListing});
  fs.writeFileSync(file,JSON.stringify({...evidence,
    verified_4342_poststore_delivery:{...proof,target_sha:sha}},null,2)+'\n');
  console.log('SC-08 post-Store Provider delivery authenticated; Reviewer not applicable in bounded source window');
}
function selfTest(){
  const raw=buildAgentWorkflowTelemetry({
    workflow_id:'agent-provider-smoke',github_run_id:BOUND.source,
    github_run_attempt:1,repository:REPO,event:'push',
    github_workflow:'Agent / Provider Smoke',
    unique_run_name:'45167810720-1-issue-1556-staging-claude-code',
    task:{id:'issue-1556-staging',type:'provider-smoke',issue:1556},
    agent:{provider:'claude-code',id:'legacy-acceptance-claude-code',
      role:'acceptor',status:'finished'},
    timing:{started_at:'2026-11-23T11:44:00Z'},
    result:{status:'completed'},
  });
  assert.equal(telemetryStoragePath(raw),BOUND.raw);
  const run=(id,p,event)=>({id,path:p,event,run_attempt:1,
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    head_branch:'main',head_sha:BOUND.sha,status:'completed',conclusion:'success'});
  const source=run(BOUND.source,BOUND.source_path,'push');
  const writer=run(BOUND.writer,BOUND.writer_path,'workflow_run');
  const sourceArtifacts={total_count:3,artifacts:[
    'agent-telemetry-provider-smoke-qwen-45167810720-1',
    'agent-telemetry-provider-smoke-qwen-reviewer-45167810720-1',
    'agent-telemetry-provider-smoke-qwen-developer-45167810720-1',
  ].map((name,i)=>({id:11+i,name,expired:false,size_in_bytes:100}))};
  const writerArtifacts={total_count:1,artifacts:[{
    id:24,name:'run-store-receipt-45168056749-1-agent',
    expired:false,size_in_bytes:100}]};
  const jobs={jobs:[{id:50,name:'ingest',run_id:writer.id,run_attempt:1,
    status:'completed',conclusion:'success',steps:[
      'Validate and append immutable telemetry','Commit metrics history',
      'Verify immutable Git bytes before uploading Run Store receipts',
      'Notify Acceptance of durable Provider evidence',
    ].map(name=>({name,conclusion:'success'})).concat([{
      name:'Notify Store of durable Reviewer evidence',conclusion:'skipped'}])}]};
  const commit='c'.repeat(40);
  const log='2026-11-23T11:47:48Z SOURCE_RUN_ID: '+source.id+'\n'+
    '2026-11-23T11:47:48Z EXPECTED_WORKFLOW_ID: agent-provider-smoke\n'+
    '2026-11-23T11:47:53Z '+JSON.stringify({schema_version:1,
      kind:'run_store_receipt_readback',store:'metrics',commit_sha:commit,
      source_run_id:String(source.id),ingester_run_id:String(writer.id),
      checked_records:3,changed_records:3});
  const reviewListing={total_count:1,workflow_runs:[{
    created_at:'2026-11-23T03:08:49Z',
    path:'.github/workflows/agent-review.yml',
    repository:{full_name:REPO}}]};
  const args={source,writer,sourceArtifacts,writerArtifacts,jobs,log,raw,
    recordCommits:[{sha:commit}],reviewListing};
  const proof=attest4342Downstream(args);
  assert.equal(proof.status,'authenticated');
  assert.equal(proof.reviewer_notification,'not_applicable_no_reviewer_source_since_fix');
  const context={issue:{number:4342},stage:'post-merge',target_ref:BOUND.sha,
    ci_evidence:{verified_4342_poststore_delivery:{...proof,target_sha:BOUND.sha}}};
  const pending={criteria:[{criterion:'SC-08',result:'Pending',evidence:[]}]};
  assert.equal(verified4342DownstreamCriterion(context,pending).criteria[0].result,'Pass');
  assert.equal(verified4342DownstreamCriterion({...context,ci_evidence:null},pending)
    .criteria[0].result,'Pending');
  assert.throws(()=>verified4342DownstreamCriterion({...context,ci_evidence:null},{
    criteria:[{criterion:'SC-08',result:'Pass',evidence:[]}]
  }),/Pass lacks authenticated/);
  assert.throws(()=>attest4342Downstream({...args,source:{...source,
    repository:{full_name:'attacker/fork'}}}),/provenance mismatch/);
  assert.throws(()=>attest4342Downstream({...args,jobs:{jobs:[{
    ...jobs.jobs[0],steps:jobs.jobs[0].steps.filter(x=>
      x.name!=='Notify Acceptance of durable Provider evidence')
  }]}}),/notification\/commit did not execute/);
  assert.throws(()=>attest4342Downstream({...args,
    recordCommits:[{sha:commit},{sha:'d'.repeat(40)}]}),/unique immutable Store/);
  assert.throws(()=>attest4342Downstream({...args,reviewListing:{
    total_count:2,workflow_runs:[...reviewListing.workflow_runs,{
      path:'.github/workflows/agent-review.yml',
      repository:{full_name:REPO},created_at:'2026-11-23T11:45:00Z'
    }]
  }}),/Reviewer post-Store applicability/);
  console.log('4342 source-bound post-Store Provider and Reviewer N/A positive/adversarial fixtures passed');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]==='collect'&&process.argv[3]&&process.argv[4])
    collect(process.argv[3],process.argv[4]);
  else if(process.argv[2]==='self-test')selfTest();
  else reject('usage: self-test | collect CI_EVIDENCE_JSON TARGET_SHA');
}
