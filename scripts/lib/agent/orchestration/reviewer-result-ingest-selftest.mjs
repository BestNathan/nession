import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startDevelopment,recordDispatch,acceptTaskResult,
  recordReboundDispatch,reconcileOutbox} from './outbox.mjs';
import {readIssueWorkflowState,writeIssueWorkflowState} from './state-store.mjs';
import {buildAgentWorkflowTelemetry,telemetryStoragePath}
  from '../../../agent-workflow-telemetry.mjs';
import {
  authenticateReviewerRun,findReviewerMetrics,canonicalActionFromArtifacts,
  resolveReviewIngestSource,stageVerifiedReviewerStore,issueReceiptMarker,
  formatReviewerIssueReceipt,projectReviewerIssue,
} from './reviewer-result-ingest.mjs';
const repo='BestNathan/nession',issue=1709,main='f'.repeat(40);
const sha='b'.repeat(40),actionSha='c'.repeat(40);
const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const run={id:335,run_attempt:1,path:'.github/workflows/agent-review.yml',
  name:'Agent / Review',event:'workflow_dispatch',head_branch:'main',head_sha:main,
  repository:{full_name:repo},head_repository:{full_name:repo},
  actor:{login:'github-actions[bot]'},status:'completed',conclusion:'success'};
assert.equal(authenticateReviewerRun(run,335,1),run);
for(const other of [{...run,actor:{login:'attacker'}},{...run,
  conclusion:'failure'},{...run,head_branch:'staging'},
  {...run,head_repository:{full_name:'fork/repo'}}]){
  assert.throws(()=>authenticateReviewerRun(other,335,1),/not the successful/);
}
const actionId='e'.repeat(64);
const artifacts={total_count:2,artifacts:[{name:'review-claim-335-1'},
  {name:'agent-result-335-1-'+actionId}]};
assert.equal(canonicalActionFromArtifacts(artifacts,run),actionId);
assert.throws(()=>canonicalActionFromArtifacts({...artifacts,
  artifacts:[artifacts.artifacts[1],artifacts.artifacts[1]]}),/duplicate/);
assert.throws(()=>canonicalActionFromArtifacts({...artifacts,total_count:3}),/incomplete/);
const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:repo,
  GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW:'Store / Agent Review Result Ingest',
  GITHUB_SHA:main,GITHUB_RUN_ATTEMPT:'1',GITHUB_EVENT_NAME:'repository_dispatch',
  GITHUB_ACTOR:'github-actions[bot]'};
const event={action:'nession-review-metrics-ingested',repository:{full_name:repo},
  sender:{login:'github-actions[bot]'},client_payload:{
    source_run_id:'335',source_run_attempt:'1',source_sha:main}};
assert.equal(resolveReviewIngestSource({environment:env,event}).run_id,335);
assert.throws(()=>resolveReviewIngestSource({environment:{...env,GITHUB_REF:'refs/heads/pr'},
  event}),/main-owned/);
assert.throws(()=>resolveReviewIngestSource({environment:{...env,GITHUB_ACTOR:'stranger'},
  event}),/untrusted/);
assert.throws(()=>resolveReviewIngestSource({environment:env,event:{
  ...event,client_payload:{...event.client_payload,source_run_id:'0'}}}),/source Run/);
const ownerEnv={...env,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_ACTOR:'BestNathan'};
const ownerEvent={repository:{full_name:repo},inputs:{
  source_run_id:'335',source_run_attempt:'1'}};
assert.equal(resolveReviewIngestSource({environment:ownerEnv,event:ownerEvent}).attempt,1);
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'review-result-ingest-test-'));
try{
  const metricsRoot=path.join(tmp,'metrics');
  fs.mkdirSync(metricsRoot);
  const telemetry=buildAgentWorkflowTelemetry({
    workflow_id:'agent-review',github_workflow:'Agent / Review',
    github_run_id:335,github_run_attempt:1,repository:repo,event:'workflow_dispatch',
    task:{id:'issue-1709-review',type:'review',issue,pr:2176,
      target_ref:actionSha,action_id:actionId},
    agent:{provider:'cursor',id:'review-cursor-01',role:'reviewer',
      model:{id:'composer-2.5'},status:'finished'},
    execution:{tool_calls:[],tools_observed:true},
    timing:{started_at:'2026-10-13T08:00:00Z',
      finished_at:'2026-10-13T08:02:00Z'},
    result:{status:'review-approved'},
  });
  const relative=telemetryStoragePath(telemetry);
  const destination=path.join(metricsRoot,relative);
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  fs.writeFileSync(destination,JSON.stringify(telemetry)+'\n');
  assert.deepEqual(findReviewerMetrics(metricsRoot,run),telemetry);
  const second=path.join(metricsRoot,'raw/workflows/agent-review/2026-10-14');
  fs.mkdirSync(second);
  fs.writeFileSync(path.join(second,path.basename(destination)),JSON.stringify(
    {...telemetry,timing:{...telemetry.timing,started_at:'2026-10-14T08:00:00Z'}}));
  assert.throws(()=>findReviewerMetrics(metricsRoot,run),/duplicate/);
  fs.rmSync(second,{recursive:true});
  assert.throws(()=>findReviewerMetrics(metricsRoot,{...run,id:336}),/missing or duplicate/);

  const root=path.join(tmp,'agent-store');fs.mkdirSync(root);
  const started=startDevelopment(registry,{issue,sha,
    developer:'dev-cursor-01',reviewer:'review-cursor-01',
    acceptor:'accept-cursor-01'},{
    repository:repo,event:'workflow_dispatch',permission:'write',
    ref:'refs/heads/main',run_id:222});
  writeIssueWorkflowState(root,started,0);
  const dev=reconcileOutbox(started).pending[0];
  const dispatchedDev=recordDispatch(started,started.version,dev.id,{
    status:'verified',dispatch_id:dev.id,source_run_id:333});
  writeIssueWorkflowState(root,dispatchedDev,started.version);
  const devResult={kind:'developer',issue,run_id:333,run_attempt:1,
    target_sha:actionSha,outcome:'implementation_ready',task_id:dev.id};
  const devSource={repository:repo,path:'.github/workflows/agent-develop.yml',
    name:'Agent / Development',run_id:333,attempt:1,event:'workflow_dispatch',
    ref:'refs/heads/main',issue,task_id:dev.id,agent_id:'dev-cursor-01',
    input_sha:sha,output_sha:actionSha,verified:true};
  const reviewing=acceptTaskResult(dispatchedDev,dispatchedDev.version,
    devResult,devSource,registry);
  writeIssueWorkflowState(root,reviewing,dispatchedDev.version);
  const reviewer=reconcileOutbox(reviewing).pending[0];
  const dispatched=recordDispatch(reviewing,reviewing.version,reviewer.id,{
    status:'verified',dispatch_id:reviewer.id,source_run_id:335});
  writeIssueWorkflowState(root,dispatched,reviewing.version);
  const reviewResult={kind:'reviewer',issue,run_id:335,run_attempt:1,
    target_sha:actionSha,outcome:'approved',task_id:reviewer.id};
  const source={repository:repo,path:'.github/workflows/agent-review.yml',
    name:'Agent / Review',run_id:335,attempt:1,event:'workflow_dispatch',
    ref:'refs/heads/main',issue,task_id:reviewer.id,
    agent_id:'review-cursor-01',input_sha:actionSha,output_sha:actionSha,
    verified:true};
  const receipt={schema_version:2,kind:'authenticated_agent_task_result',
    issue,action_id:reviewer.id,result:reviewResult,source,
    artifact:{id:1001,digest:'sha256:'+'d'.repeat(64),
      json_sha256:'a'.repeat(64),source_run_id:335,source_run_attempt:1},
    acceptance_result:null,implementing_pr:{
      repository:repo,number:2176,head_sha_at_attestation:actionSha,
      relation:'trusted_pr_head_at_result_attestation'}};
  const next=acceptTaskResult(dispatched,dispatched.version,reviewResult,source,registry);
  assert.equal(next.phase,'quality');
  const record=readIssueWorkflowState(root,issue);
  const committed=stageVerifiedReviewerStore({storeRoot:root,verified:{
    replayed:false,record,receipt,intermediate:null,next}});
  assert.equal(committed.changed,true);
  assert.equal(committed.version,record.version+1);
  assert.equal(readIssueWorkflowState(root,issue).state.phase,'quality');
  assert.equal(reconcileOutbox(readIssueWorkflowState(root,issue).state).pending.length,1);
  const marker=issueReceiptMarker(receipt),commit='f'.repeat(40);
  assert.match(marker,/nession-review-result:v1/);
  assert.match(formatReviewerIssueReceipt(receipt,commit,next.version),
    /one pending Quality verification action/);
  let posted=0,reads=0;
  const fetchFn=async(url,opts)=>{
    if(opts.method==='POST'){
      posted++;
      assert.match(JSON.parse(opts.body).body,/Authenticated Reviewer result/);
      return {status:201};
    }
    reads++;
    return {ok:true,json:async()=>reads>1?[{body:marker}]:[]};
  };
  assert.equal((await projectReviewerIssue({receipt,commit,version:next.version,
    token:'fixture-token123',fetchFn})).projected,true);
  assert.equal((await projectReviewerIssue({receipt,commit,version:next.version,
    token:'fixture-token123',fetchFn})).already_present,true);
  assert.equal(posted,1);
  const wrong={...receipt,result:{...receipt.result,run_id:336}};
  assert.throws(()=>issueReceiptMarker(wrong),/untrusted authenticated/);
  assert.throws(()=>stageVerifiedReviewerStore({storeRoot:root,verified:{
    replayed:false,record,receipt,intermediate:null,next}}),/Store state changed/);

  // Skipped-run rebinding and Reviewer consumption are TWO immutable versions
  // in ONE candidate Git commit; no partially rebound receipt is ever pushed.
  const secondRoot=path.join(tmp,'rebound-store');fs.mkdirSync(secondRoot);
  for(const state of [started,dispatchedDev,reviewing])
    writeIssueWorkflowState(secondRoot,state,state.version-1);
  const skipped=recordDispatch(reviewing,reviewing.version,reviewer.id,{
    status:'verified',dispatch_id:reviewer.id,source_run_id:334});
  writeIssueWorkflowState(secondRoot,skipped,reviewing.version);
  const rebounded=recordReboundDispatch(skipped,skipped.version,reviewer.id,{
    schema_version:1,kind:'skipped_dispatch_rebinding',action_id:reviewer.id,
    issue,role:'reviewer',skipped_run_id:334,replacement_run_id:335,
    verified_main_sha:main});
  const reboundNext=acceptTaskResult(rebounded,rebounded.version,
    reviewResult,source,registry);
  const staged=stageVerifiedReviewerStore({storeRoot:secondRoot,verified:{
    replayed:false,record:readIssueWorkflowState(secondRoot,issue),
    receipt,intermediate:rebounded,next:reboundNext}});
  assert.equal(staged.version,skipped.version+2);
  assert.equal(readIssueWorkflowState(secondRoot,issue).state.phase,'quality');
  assert.equal(fs.existsSync(path.join(secondRoot,'workflows/issues/'+issue+
    '/states/'+String(rebounded.version).padStart(8,'0')+'.json')),true);
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
console.log('Trusted Reviewer Store CAS, Metrics, Issue projection and replay fixtures passed');
