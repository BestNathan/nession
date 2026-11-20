#!/usr/bin/env node
// #4174: exact failed-run provenance, no result Artifact, Store CAS successor
// and replay/credential/attempt negatives. Never calls a real Provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {SOURCE,verifyQwenTrackedSourceFailure,verifyQwenTrackedSourceFailureLive}
  from './qwen-tracked-source-failure.mjs';
import {startDevelopment,recordDispatchIntent,recordDispatch,
  recordAttestedQwenTrackedSourceFailure,qwenTrackedSourceSuccessorId,validateDevelopmentState}
  from './outbox.mjs';
import {recoverAttestedQwenTrackedSourceFailure} from './dispatch-store.mjs';
import {writeIssueWorkflowState,readIssueWorkflowState} from './state-store.mjs';

const repo='BestNathan/nession',s=SOURCE;
const run={id:s.run_id,run_attempt:1,head_sha:s.run_head_sha,head_branch:'main',
  path:'.github/workflows/agent-develop.yml',name:'Agent / Development',
  event:'workflow_dispatch',status:'completed',conclusion:'failure',
  actor:{login:'github-actions[bot]'},repository:{full_name:repo},
  head_repository:{full_name:repo}};
const step=(name,conclusion)=>({name,conclusion,status:'completed'});
const qwen={id:136279796177,run_id:s.run_id,run_attempt:1,
  name:'qwen-developer',status:'completed',conclusion:'failure',steps:[
    step('Require exact signed Qwen Store ACK before any model or source checkout','success'),
    step('Validate pinned Qwen model, endpoint, public Session key and CLI version','success'),
    step('Prepare disposable exact-SHA tracked source without executing it','success'),
    step('Fetch only bounded read-only Issue context before Node model','success'),
    step('Install pinned Qwen Claude CLI on Node Runner','success'),
    step('Execute Store-admitted Qwen Developer directly with Node.js','failure'),
    step('Upload canonical real Qwen Developer telemetry','success'),
    step('Upload only bounded patch and encrypted native Session','skipped'),
    step('Remove private transient restored Session and Issue data','success'),
  ]};
const jobs={total_count:6,jobs:[
  {id:136279711619,name:'claim',status:'completed',conclusion:'success'},
  qwen,
  ...['qwen-restore','restore','developer','wake-qwen-result'].map((name,i)=>({
    id:i+3,name,status:'completed',conclusion:'skipped'})),
]};
const artifacts={total_count:2,artifacts:[
  {id:14627851470,name:'development-worker-claim-'+s.run_id+'-1',
    digest:'sha256:20a4679663ea9afc518a1713c3497e5f1c7bc0a0675a39540ed55955681e605f',
    expired:false,size_in_bytes:978,workflow_run:{id:s.run_id,head_sha:s.run_head_sha}},
  {id:14628061648,name:'agent-telemetry-developer-'+s.run_id+'-1',
    digest:'sha256:f99942cf43be5a94b0ded8e39090a9a25dd506ee2143381246cb64a6dade40e1',
    expired:false,size_in_bytes:888,workflow_run:{id:s.run_id,head_sha:s.run_head_sha}},
]};
const log='2026-11-20T12:15:32Z ##[error]Qwen Developer source: untracked, index, rename or delete change prohibited\n'+
  '2026-11-20T12:15:32Z ##[error]Process completed with exit code 1.\n';
const proof=verifyQwenTrackedSourceFailure(run,jobs,artifacts,log);
assert.deepEqual(proof,{verified:true,...s});
for(const [r,j,a,l] of [
  [{...run,run_attempt:2},jobs,artifacts,log],
  [{...run,head_sha:'f'.repeat(40)},jobs,artifacts,log],
  [{...run,actor:{login:'attacker'}},jobs,artifacts,log],
  [{...run,conclusion:'success'},jobs,artifacts,log],
  [run,{...jobs,total_count:7},artifacts,log],
  [run,{...jobs,jobs:jobs.jobs.map(x=>x.name==='qwen-developer'?
    {...x,steps:x.steps.map(s=>s.name.startsWith('Execute Store-admitted')?
      {...s,conclusion:'success'}:s)}:x)},artifacts,log],
  [run,jobs,{...artifacts,total_count:3},log],
  [run,jobs,{...artifacts,artifacts:artifacts.artifacts.map(x=>({
    ...x,digest:'sha256:'+'f'.repeat(64)}))},log],
  [run,jobs,artifacts,'Qwen accepted source'],
]){
  assert.throws(()=>verifyQwenTrackedSourceFailure(r,j,a,l),
    /trusted Qwen tracked-source recovery/);
}
const mock=async url=>{
  const suffix=url.replace('https://api.github.com/repos/'+repo,'');
  const data=suffix==='/actions/runs/'+s.run_id?run:
    suffix==='/actions/runs/'+s.run_id+'/jobs?per_page=100'?jobs:
    suffix==='/actions/runs/'+s.run_id+'/artifacts?per_page=100'?artifacts:null;
  if(suffix==='/actions/jobs/136279796177/logs')return {ok:true,
    headers:{get:()=>String(log.length)},text:async()=>log};
  if(data)return {ok:true,json:async()=>data};
  throw Error('unexpected authenticated GitHub source read');
};
assert.deepEqual(await verifyQwenTrackedSourceFailureLive('trusted-source-read',mock),proof);
const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const original=startDevelopment(registry,{issue:s.issue,sha:s.source_sha,
  developer:'dev-qwen-01',reviewer:'review-qwen-01',acceptor:'accept-qwen-01'},
{repository:repo,event:'workflow_dispatch',permission:'write',
  ref:'refs/heads/main',run_id:44733554470});
assert.equal(original.outbox[0].id,s.action_id);
const intent=recordDispatchIntent(original,1,s.action_id,{
  status:'prepared',dispatch_id:s.action_id,
  issuer_run_id:44733618323,ticket_sha256:'5'.repeat(64)});
const dispatched=recordDispatch(intent,2,s.action_id,{
  status:'verified',dispatch_id:s.action_id,source_run_id:s.run_id});
const next=recordAttestedQwenTrackedSourceFailure(dispatched,3,proof);
validateDevelopmentState(next);
assert.equal(next.version,4);
assert.equal(next.outbox[0].status,'failed');
assert.equal(next.outbox[0].receipt.failure_code,s.failure_code);
assert.equal(next.outbox[1].status,'pending');
assert.equal(next.outbox[1].attempts,0);
assert.equal(next.outbox[1].id,qwenTrackedSourceSuccessorId(s.issue,s.action_id,s.run_id));
assert.deepEqual(next.outbox[1].task,dispatched.outbox[0].task);
for(const delta of [
  {source_run_id:s.run_id+1},
  {source_attempt:2},
  {failure_code:'qwen_native_sealing_public_key_missing'},
]){
  const forged={...next,outbox:next.outbox.map((item,i)=>i===0?{
    ...item,receipt:{...item.receipt,...delta},
  }:item)};
  assert.throws(()=>validateDevelopmentState(forged),/invalid authenticated failure receipt/);
}
for(const bad of [{issue:3785},{run_id:s.run_id+1},
  {verified:false},{source_sha:'0'.repeat(40)},{attempt:2},
  {failure_code:'native_sdk_sandbox_unavailable'}])
  assert.throws(()=>recordAttestedQwenTrackedSourceFailure(dispatched,3,{...proof,...bad}),
    /agent outbox/);
assert.throws(()=>recordAttestedQwenTrackedSourceFailure(dispatched,2,proof),
  /agent outbox/);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-tracked-source-failure-store-'));
const remote=path.join(root,'store.git'),work=path.join(root,'work');
const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{
  encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,
  env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
}).trim();
try{
  execFileSync('git',['init','--bare',remote],{stdio:'ignore'});
  execFileSync('git',['clone',remote,work],{stdio:'ignore'});
  git(work,'config','user.name','Nession CLI Recovery Test');
  git(work,'config','user.email','nession-test@example.invalid');
  git(work,'checkout','--orphan','agent-store');
  git(work,'commit','--allow-empty','-m','initialize test Store');
  git(work,'push','-u','origin','agent-store');
  for(const [prev,state] of [[0,original],[1,intent],[2,dispatched]]){
    writeIssueWorkflowState(work,state,prev);
    git(work,'add','-A');git(work,'commit','-m','Issue state '+state.version);
    git(work,'push','origin','agent-store');
  }
  const result=recoverAttestedQwenTrackedSourceFailure({remote:'file://'+remote,source:proof});
  assert.equal(result.status,'recovered');
  assert.equal(result.state_version,4);
  assert.equal(result.action_id,next.outbox[1].id);
  const replay=recoverAttestedQwenTrackedSourceFailure({remote:'file://'+remote,source:proof});
  assert.equal(replay.status,'replayed');
  assert.equal(replay.action_id,result.action_id);
  git(work,'pull','--ff-only','origin','agent-store');
  assert.deepEqual(readIssueWorkflowState(work,s.issue).state,next);
  assert.throws(()=>recoverAttestedQwenTrackedSourceFailure({
    remote:'file://'+remote,source:{...proof,run_id:3}}),
    /trusted dispatch Store/);
  // A second invocation cannot invent another pending successor.
  assert.equal(readIssueWorkflowState(work,s.issue).state.outbox.length,2);
}finally{fs.rmSync(root,{recursive:true,force:true});}
console.log('Qwen tracked-source rejected Run: signed Run/Job/Artifact/log, Store v3->v4 CAS, replay and negative provenance passed');
