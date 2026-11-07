#!/usr/bin/env node
// #2817: genuine GitHub-shaped failed Run fixtures and real local orphan
// Store CAS prove recovery never re-POSTs a failed Developer Action.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {SOURCE,SOURCE_V2,SOURCE_V3,verifyQwenPreflightFailure,
  verifyQwenPreflightFailureLive,verifyQwenPreflightFailureV2,
  verifyQwenPreflightFailureV2Live,verifyQwenPreflightFailureV3,
  verifyQwenPreflightFailureV3Live} from './qwen-preflight-failure.mjs';
import {startDevelopment,recordDispatchIntent,recordDispatch,
  recordAttestedQwenPreflightFailure,qwenPreflightSuccessorId,
  recordAttestedQwenPreflightFailureV2,qwenPreflightSuccessorIdV2,
  recordAttestedQwenPreflightFailureV3,qwenPreflightSuccessorIdV3,
  validateDevelopmentState} from './outbox.mjs';
import {writeIssueWorkflowState,readIssueWorkflowState} from './state-store.mjs';
import {recoverAttestedQwenPreflight,recoverAttestedQwenPreflightV2,
  recoverAttestedQwenPreflightV3}
  from './dispatch-store.mjs';

const repo='BestNathan/nession',a=SOURCE;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-preflight-recovery-'));
const git=(dir,...cmd)=>execFileSync('git',['-C',dir,...cmd],{
  encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,
  env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
}).trim();
const run={id:a.run_id,run_attempt:1,head_sha:a.source_sha,
  head_branch:'main',path:'.github/workflows/agent-develop.yml',
  name:'Agent / Development',event:'workflow_dispatch',
  status:'completed',conclusion:'failure',actor:{login:'github-actions[bot]'},
  repository:{full_name:repo},head_repository:{full_name:repo}};
const step=(name,conclusion)=>({name,conclusion,status:'completed'});
const qwen={id:127791677229,run_id:a.run_id,run_attempt:1,
  name:'qwen-developer',status:'completed',conclusion:'failure',steps:[
    step('Checkout main-owned Qwen model-runner code only','success'),
    step('Require exact signed Qwen Store ACK before any model or source checkout','success'),
    step('Validate pinned Qwen model, endpoint, public Session key and CLI version','failure'),
    step('Prepare disposable exact-SHA tracked source without executing it','skipped'),
    step('Execute Store-admitted Qwen CLI in unprivileged Docker','skipped'),
    step('Upload only bounded patch and encrypted native Session','skipped'),
  ]};
const jobs={total_count:5,jobs:[
  {id:1,run_id:a.run_id,name:'claim',status:'completed',conclusion:'success'},
  qwen,...['qwen-restore','restore','developer'].map((name,i)=>({
    id:i+2,run_id:a.run_id,name,status:'completed',conclusion:'skipped'}))
]};
const artifacts={total_count:1,artifacts:[{
  name:'development-worker-claim-'+a.run_id+'-1',
  expired:false,digest:'sha256:'+'a'.repeat(64),
  workflow_run:{id:a.run_id,head_sha:a.source_sha},
}]};
const log='2026-11-06T08:26:16Z   QWEN_RESUME_PUBLIC_KEY_B64: \n'+
  '2026-11-06T08:26:16Z Error: error:1E08010C:DECODER routines::unsupported\n'+
  '2026-11-06T08:26:16Z ##[error]Process completed with exit code 1.\n';
// Second exact pre-model failure: the restore private key was absent on the
// workflow head that ran the first successor Action.
const a2=SOURCE_V2;
const run2={id:a2.run_id,run_attempt:1,head_sha:a2.run_head_sha,
  head_branch:'main',path:'.github/workflows/agent-develop.yml',
  name:'Agent / Development',event:'workflow_dispatch',
  status:'completed',conclusion:'failure',actor:{login:'github-actions[bot]'},
  repository:{full_name:repo},head_repository:{full_name:repo}};
const qwen2={id:128304345959,run_id:a2.run_id,run_attempt:1,
  name:'qwen-developer',status:'completed',conclusion:'failure',steps:[
    step('Checkout main-owned Qwen model-runner code only','success'),
    step('Run actions/setup-node@v4','success'),
    step('Require exact signed Qwen Store ACK before any model or source checkout','success'),
    step('Validate pinned Qwen model, endpoint, public Session key and CLI version','failure'),
    step('Prepare disposable exact-SHA tracked source without executing it','skipped'),
    step('Fetch only bounded read-only Issue context outside model container','skipped'),
    step('Attest latest committed Qwen Reviewer Issue comment before Repair','skipped'),
    step('Build pinned, source-free isolated Qwen runtime','skipped'),
    step('Download only same-Run encrypted Qwen Resume transfer','skipped'),
    step('Open Qwen native Session on trusted host before model Docker','skipped'),
    step('Execute Store-admitted Qwen CLI in unprivileged Docker','skipped'),
    step('Upload only bounded patch and encrypted native Session','skipped'),
    step('Upload canonical real Qwen Developer telemetry','success'),
    step('Remove private transient restored Session and Issue data','success'),
  ]};
const jobs2={total_count:5,jobs:[
  {id:11,run_id:a2.run_id,name:'claim',status:'completed',conclusion:'success'},
  qwen2,...['qwen-restore','restore','developer'].map((name,i)=>({
    id:i+12,run_id:a2.run_id,name,status:'completed',conclusion:'skipped'}))
]};
const artifacts2={total_count:1,artifacts:[{
  name:'development-worker-claim-'+a2.run_id+'-1',
  expired:false,digest:'sha256:'+'c'.repeat(64),
  workflow_run:{id:a2.run_id,head_sha:a2.run_head_sha},
}]};
const log2='2026-11-07T04:43:35Z   QWEN_RESUME_PRIVATE_KEY_B64: \n'+
  '2026-11-07T04:43:35Z Error: Qwen native Restore private key is not configured\n'+
  '2026-11-07T04:43:35Z ##[error]Process completed with exit code 1.\n';
// Third exact pre-model failure: the pinned CLI package's postinstall was
// skipped, so the native binary was absent and the Worker image build failed.
const a3=SOURCE_V3;
const run3={id:a3.run_id,run_attempt:1,head_sha:a3.run_head_sha,
  head_branch:'main',path:'.github/workflows/agent-develop.yml',
  name:'Agent / Development',event:'workflow_dispatch',
  status:'completed',conclusion:'failure',actor:{login:'github-actions[bot]'},
  repository:{full_name:repo},head_repository:{full_name:repo}};
const qwen3={id:128314017593,run_id:a3.run_id,run_attempt:1,
  name:'qwen-developer',status:'completed',conclusion:'failure',steps:[
    step('Checkout main-owned Qwen model-runner code only','success'),
    step('Run actions/setup-node@v4','success'),
    step('Require exact signed Qwen Store ACK before any model or source checkout','success'),
    step('Validate pinned Qwen model, endpoint, public Session key and CLI version','success'),
    step('Prepare disposable exact-SHA tracked source without executing it','success'),
    step('Fetch only bounded read-only Issue context outside model container','success'),
    step('Attest latest committed Qwen Reviewer Issue comment before Repair','skipped'),
    step('Build pinned, source-free isolated Qwen runtime','failure'),
    step('Download only same-Run encrypted Qwen Resume transfer','skipped'),
    step('Open Qwen native Session on trusted host before model Docker','skipped'),
    step('Execute Store-admitted Qwen CLI in unprivileged Docker','skipped'),
    step('Upload canonical real Qwen Developer telemetry','success'),
    step('Upload only bounded patch and encrypted native Session','skipped'),
    step('Remove private transient restored Session and Issue data','success'),
  ]};
const jobs3={total_count:5,jobs:[
  {id:21,run_id:a3.run_id,name:'claim',status:'completed',conclusion:'success'},
  qwen3,...['qwen-restore','restore','developer'].map((name,i)=>({
    id:i+22,run_id:a3.run_id,name,status:'completed',conclusion:'skipped'}))
]};
const artifacts3={total_count:1,artifacts:[{
  name:'development-worker-claim-'+a3.run_id+'-1',
  expired:false,digest:'sha256:'+'e'.repeat(64),
  workflow_run:{id:a3.run_id,head_sha:a3.run_head_sha},
}]};
const log3='2026-11-07T05:28:06Z #6 4.312 Error: claude native binary not installed.\n'+
  '2026-11-07T05:28:06Z ##[error]Process completed with exit code 1.\n';
try{
  const proof=verifyQwenPreflightFailure(run,jobs,artifacts,log);
  assert.deepEqual(proof,{verified:true,...a});
  for(const [source,j,aft,lg] of [
    [{...run,actor:{login:'attacker'}},jobs,artifacts,log],
    [{...run,run_attempt:2},jobs,artifacts,log],
    [{...run,head_sha:'f'.repeat(40)},jobs,artifacts,log],
    [{...run,event:'pull_request'},jobs,artifacts,log],
    [run,{...jobs,total_count:6},artifacts,log],
    [run,{...jobs,jobs:jobs.jobs.map(x=>x.name==='qwen-developer'?
      {...x,conclusion:'success'}:x)},artifacts,log],
    [run,{...jobs,jobs:jobs.jobs.map(x=>x.name==='qwen-developer'?
      {...x,steps:x.steps.map(s=>s.name==='Execute Store-admitted Qwen CLI in unprivileged Docker'?
        {...s,conclusion:'success'}:s)}:x)},artifacts,log],
    [run,jobs,{...artifacts,total_count:2},log],
    [run,jobs,artifacts,log.replace('DECODER routines::unsupported','ready')],
    [run,jobs,artifacts,log.replace('QWEN_RESUME_PUBLIC_KEY_B64: ','QWEN_RESUME_PUBLIC_KEY_B64: sensitive')],
  ])assert.throws(()=>verifyQwenPreflightFailure(source,j,aft,lg),
    /trusted Qwen preflight recovery/);
  const mock=async url=>{
    const key=url.replace('https://api.github.com/repos/'+repo,'');
    const data=key==='/actions/runs/'+a.run_id?run:
      key==='/actions/runs/'+a.run_id+'/jobs?per_page=100'?jobs:
      key==='/actions/runs/'+a.run_id+'/artifacts?per_page=100'?artifacts:null;
    if(key.includes('/logs'))return {
      ok:true,headers:{get:()=>String(log.length)},text:async()=>log};
    if(data)return {ok:true,json:async()=>data};
    throw Error('unexpected trusted fetch '+url);
  };
  assert.deepEqual(await verifyQwenPreflightFailureLive('verified-token',mock),proof);

  const proof2=verifyQwenPreflightFailureV2(run2,jobs2,artifacts2,log2);
  assert.deepEqual(proof2,{verified:true,...a2});
  for(const [source,j,aft,lg] of [
    [{...run2,actor:{login:'attacker'}},jobs2,artifacts2,log2],
    [{...run2,run_attempt:2},jobs2,artifacts2,log2],
    [{...run2,head_sha:a2.source_sha},jobs2,artifacts2,log2],
    [{...run2,event:'pull_request'},jobs2,artifacts2,log2],
    [run2,{...jobs2,total_count:6},artifacts2,log2],
    [run2,{...jobs2,jobs:jobs2.jobs.map(x=>x.name==='qwen-developer'?
      {...x,conclusion:'success'}:x)},artifacts2,log2],
    [run2,{...jobs2,jobs:jobs2.jobs.map(x=>x.name==='qwen-developer'?
      {...x,steps:x.steps.map(s=>s.name==='Execute Store-admitted Qwen CLI in unprivileged Docker'?
        {...s,conclusion:'success'}:s)}:x)},artifacts2,log2],
    [run2,jobs2,{...artifacts2,total_count:2},log2],
    [run2,jobs2,artifacts2,log2.replace(
      'Qwen native Restore private key is not configured','ready')],
    [run2,jobs2,artifacts2,log2.replace(
      'QWEN_RESUME_PRIVATE_KEY_B64: ','QWEN_RESUME_PRIVATE_KEY_B64: sensitive')],
  ])assert.throws(()=>verifyQwenPreflightFailureV2(source,j,aft,lg),
    /trusted Qwen preflight recovery/);
  const mock2=async url=>{
    const key=url.replace('https://api.github.com/repos/'+repo,'');
    const data=key==='/actions/runs/'+a2.run_id+'/attempts/1'?run2:
      key==='/actions/runs/'+a2.run_id+'/attempts/1/jobs?per_page=100'?jobs2:
      key==='/actions/runs/'+a2.run_id+'/artifacts?per_page=100'?artifacts2:null;
    if(key.includes('/logs'))return {
      ok:true,headers:{get:()=>String(log2.length)},text:async()=>log2};
    if(data)return {ok:true,json:async()=>data};
    throw Error('unexpected trusted fetch '+url);
  };
  assert.deepEqual(await verifyQwenPreflightFailureV2Live('verified-token',mock2),
    proof2);

  const proof3=verifyQwenPreflightFailureV3(run3,jobs3,artifacts3,log3);
  assert.deepEqual(proof3,{verified:true,...a3});
  for(const [source,j,aft,lg] of [
    [{...run3,actor:{login:'attacker'}},jobs3,artifacts3,log3],
    [{...run3,run_attempt:2},jobs3,artifacts3,log3],
    [{...run3,head_sha:a3.source_sha},jobs3,artifacts3,log3],
    [{...run3,event:'pull_request'},jobs3,artifacts3,log3],
    [run3,{...jobs3,total_count:6},artifacts3,log3],
    [run3,{...jobs3,jobs:jobs3.jobs.map(x=>x.name==='qwen-developer'?
      {...x,conclusion:'success'}:x)},artifacts3,log3],
    [run3,{...jobs3,jobs:jobs3.jobs.map(x=>x.name==='qwen-developer'?
      {...x,steps:x.steps.map(s=>s.name==='Execute Store-admitted Qwen CLI in unprivileged Docker'?
        {...s,conclusion:'success'}:s)}:x)},artifacts3,log3],
    [run3,jobs3,{...artifacts3,total_count:2},log3],
    [run3,jobs3,artifacts3,log3.replace('claude native binary not installed','ready')],
  ])assert.throws(()=>verifyQwenPreflightFailureV3(source,j,aft,lg),
    /trusted Qwen preflight recovery/);
  const mock3=async url=>{
    const key=url.replace('https://api.github.com/repos/'+repo,'');
    const data=key==='/actions/runs/'+a3.run_id?run3:
      key==='/actions/runs/'+a3.run_id+'/jobs?per_page=100'?jobs3:
      key==='/actions/runs/'+a3.run_id+'/artifacts?per_page=100'?artifacts3:null;
    if(key.includes('/logs'))return {
      ok:true,headers:{get:()=>String(log3.length)},text:async()=>log3};
    if(data)return {ok:true,json:async()=>data};
    throw Error('unexpected trusted fetch '+url);
  };
  assert.deepEqual(await verifyQwenPreflightFailureV3Live('verified-token',mock3),
    proof3);

  const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
  const first=startDevelopment(registry,{
    issue:a.issue,sha:a.source_sha,developer:'dev-qwen-01',
    reviewer:'review-qwen-01',acceptor:'accept-qwen-01',
  },{repository:repo,event:'workflow_dispatch',
    permission:'write',ref:'refs/heads/main',run_id:42183468789});
  assert.equal(first.outbox[0].id,a.action_id);
  const prepared=recordDispatchIntent(first,1,a.action_id,{
    status:'prepared',dispatch_id:a.action_id,issuer_run_id:42187563201,
    ticket_sha256:'b'.repeat(64)});
  const dispatched=recordDispatch(prepared,2,a.action_id,{
    status:'verified',dispatch_id:a.action_id,source_run_id:a.run_id});
  assert.equal(dispatched.version,3);
  const final=recordAttestedQwenPreflightFailure(dispatched,3,proof);
  validateDevelopmentState(final);
  assert.equal(final.version,4);
  assert.equal(final.outbox.length,2);
  assert.equal(final.outbox[0].status,'failed');
  assert.equal(final.outbox[0].receipt.failure_code,a.failure_code);
  assert.equal(final.outbox[1].status,'pending');
  assert.equal(final.outbox[1].attempts,0);
  assert.equal(final.outbox[1].id,
    qwenPreflightSuccessorId(a.issue,a.action_id,a.run_id));
  assert.deepEqual(final.outbox[1].task,dispatched.outbox[0].task);
  for(const patch of [
    {run_id:a.run_id+1},{issue:1997},{source_sha:'0'.repeat(40)},
    {failure_code:'native_sdk_sandbox_unavailable'},{verified:false},
  ])assert.throws(()=>recordAttestedQwenPreflightFailure(dispatched,3,
    {...proof,...patch}),/agent outbox/);
  assert.throws(()=>recordAttestedQwenPreflightFailure(dispatched,2,proof),
    /stale|agent outbox/);

  const successorId=qwenPreflightSuccessorId(a.issue,a.action_id,a.run_id);
  const prepared2=recordDispatchIntent(final,4,successorId,{
    status:'prepared',dispatch_id:successorId,issuer_run_id:42339621697,
    ticket_sha256:'d'.repeat(64)});
  const dispatched2=recordDispatch(prepared2,5,successorId,{
    status:'verified',dispatch_id:successorId,source_run_id:a2.run_id});
  assert.equal(dispatched2.version,6);
  const final2=recordAttestedQwenPreflightFailureV2(dispatched2,6,proof2);
  validateDevelopmentState(final2);
  assert.equal(final2.version,7);
  assert.equal(final2.outbox.length,3);
  assert.equal(final2.outbox[1].status,'failed');
  assert.equal(final2.outbox[1].receipt.failure_code,a2.failure_code);
  assert.equal(final2.outbox[2].status,'pending');
  assert.equal(final2.outbox[2].attempts,0);
  assert.equal(final2.outbox[2].id,
    qwenPreflightSuccessorIdV2(a2.issue,a2.action_id,a2.run_id));
  assert.deepEqual(final2.outbox[2].task,dispatched2.outbox[1].task);
  for(const patch of [
    {run_id:a2.run_id+1},{run_head_sha:'0'.repeat(40)},
    {source_sha:'0'.repeat(40)},
    {failure_code:'qwen_native_sealing_public_key_missing'},{verified:false},
  ])assert.throws(()=>recordAttestedQwenPreflightFailureV2(dispatched2,6,
    {...proof2,...patch}),/agent outbox/);
  assert.throws(()=>recordAttestedQwenPreflightFailureV2(dispatched2,5,proof2),
    /stale|agent outbox/);

  const successorId2=final2.outbox[2].id;
  const prepared3=recordDispatchIntent(final2,7,successorId2,{
    status:'prepared',dispatch_id:successorId2,issuer_run_id:42342757887,
    ticket_sha256:'f'.repeat(64)});
  const dispatched3=recordDispatch(prepared3,8,successorId2,{
    status:'verified',dispatch_id:successorId2,source_run_id:a3.run_id});
  assert.equal(dispatched3.version,9);
  const final3=recordAttestedQwenPreflightFailureV3(dispatched3,9,proof3);
  validateDevelopmentState(final3);
  assert.equal(final3.version,10);
  assert.equal(final3.outbox.length,4);
  assert.equal(final3.outbox[2].status,'failed');
  assert.equal(final3.outbox[2].receipt.failure_code,a3.failure_code);
  assert.equal(final3.outbox[3].status,'pending');
  assert.equal(final3.outbox[3].attempts,0);
  assert.equal(final3.outbox[3].id,
    qwenPreflightSuccessorIdV3(a3.issue,a3.action_id,a3.run_id));
  assert.deepEqual(final3.outbox[3].task,dispatched3.outbox[2].task);
  for(const patch of [
    {run_id:a3.run_id+1},{run_head_sha:'0'.repeat(40)},
    {source_sha:'0'.repeat(40)},
    {failure_code:'qwen_native_restore_private_key_missing'},{verified:false},
  ])assert.throws(()=>recordAttestedQwenPreflightFailureV3(dispatched3,9,
    {...proof3,...patch}),/agent outbox/);
  assert.throws(()=>recordAttestedQwenPreflightFailureV3(dispatched3,8,proof3),
    /stale|agent outbox/);

  const remote=path.join(root,'remote.git');
  const local=path.join(root,'work');
  execFileSync('git',['init','--bare',remote],{stdio:'ignore'});
  execFileSync('git',['clone',remote,local],{stdio:'ignore'});
  git(local,'config','user.name','Nession Recovery Test');
  git(local,'config','user.email','nession-test@example.invalid');
  git(local,'checkout','--orphan','agent-store');
  git(local,'commit','--allow-empty','-m','initialize agent-store test branch');
  git(local,'push','-u','origin','agent-store');
  const sourceStates=[first,prepared,dispatched];
  for(let i=0;i<sourceStates.length;i++){
    writeIssueWorkflowState(local,sourceStates[i],i);
    git(local,'add','-A');
    git(local,'commit','-m','source Issue v'+(i+1));
    git(local,'push','origin','agent-store');
  }
  const url='file://'+remote;
  const result=recoverAttestedQwenPreflight({remote:url,source:proof});
  assert.equal(result.status,'recovered');
  assert.equal(result.action_id,final.outbox[1].id);
  assert.equal(result.state_version,4);
  const replay=recoverAttestedQwenPreflight({remote:url,source:proof});
  assert.equal(replay.status,'replayed');
  assert.equal(replay.action_id,result.action_id);
  assert.equal(replay.state_version,4);
  git(local,'pull','--ff-only','origin','agent-store');
  assert.deepEqual(readIssueWorkflowState(local,a.issue).state,final);
  assert.throws(()=>recoverAttestedQwenPreflight({
    remote:url,source:{...proof,run_id:2}}),
    /trusted dispatch Store/);

  for(const [state,previous] of [[prepared2,4],[dispatched2,5]]){
    writeIssueWorkflowState(local,state,previous);
    git(local,'add','-A');
    git(local,'commit','-m','second Qwen failure source Issue v'+state.version);
    git(local,'push','origin','agent-store');
  }
  const result2=recoverAttestedQwenPreflightV2({remote:url,source:proof2});
  assert.equal(result2.status,'recovered');
  assert.equal(result2.action_id,final2.outbox[2].id);
  assert.equal(result2.state_version,7);
  const replay2=recoverAttestedQwenPreflightV2({remote:url,source:proof2});
  assert.equal(replay2.status,'replayed');
  assert.equal(replay2.action_id,result2.action_id);
  assert.equal(replay2.state_version,7);
  git(local,'pull','--ff-only','origin','agent-store');
  assert.deepEqual(readIssueWorkflowState(local,a2.issue).state,final2);
  assert.throws(()=>recoverAttestedQwenPreflightV2({
    remote:url,source:{...proof2,run_id:2}}),
    /trusted dispatch Store/);

  for(const [state,previous] of [[prepared3,7],[dispatched3,8]]){
    writeIssueWorkflowState(local,state,previous);
    git(local,'add','-A');
    git(local,'commit','-m','third Qwen failure source Issue v'+state.version);
    git(local,'push','origin','agent-store');
  }
  const result3=recoverAttestedQwenPreflightV3({remote:url,source:proof3});
  assert.equal(result3.status,'recovered');
  assert.equal(result3.action_id,final3.outbox[3].id);
  assert.equal(result3.state_version,10);
  const replay3=recoverAttestedQwenPreflightV3({remote:url,source:proof3});
  assert.equal(replay3.status,'replayed');
  assert.equal(replay3.action_id,result3.action_id);
  assert.equal(replay3.state_version,10);
  git(local,'pull','--ff-only','origin','agent-store');
  assert.deepEqual(readIssueWorkflowState(local,a3.issue).state,final3);
  assert.throws(()=>recoverAttestedQwenPreflightV3({
    remote:url,source:{...proof3,run_id:2}}),
    /trusted dispatch Store/);
  console.log('Qwen preflight recovery: real Store CAS, exact GitHub source, one successor, replay, compromised Run/log/artifact negatives pass; Restore-key and Worker-image recovery repeats passed');
}finally{
  fs.rmSync(root,{recursive:true,force:true});
}
