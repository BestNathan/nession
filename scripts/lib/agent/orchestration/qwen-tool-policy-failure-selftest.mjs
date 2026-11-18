#!/usr/bin/env node
// #3885: exact second failed Qwen Node Run with real read-only Grep, source
// verifier negatives and append-only Store v6->v7 successor/replay.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {SOURCE,verifyQwenToolPolicyFailure,verifyQwenToolPolicyFailureLive}
  from './qwen-tool-policy-failure.mjs';
import {SOURCE as FIRST} from './qwen-cli-failure.mjs';
import {startDevelopment,recordDispatchIntent,recordDispatch,
  recordAttestedQwenCliFailure,qwenCliSuccessorId,
  recordAttestedQwenToolFailure,qwenToolSuccessorId,validateDevelopmentState}
  from './outbox.mjs';
import {recoverAttestedQwenToolFailure} from './dispatch-store.mjs';
import {writeIssueWorkflowState,readIssueWorkflowState} from './state-store.mjs';

const repo='BestNathan/nession',s=SOURCE;
const run={id:s.run_id,run_attempt:1,head_sha:s.run_head_sha,
  head_branch:'main',path:'.github/workflows/agent-develop.yml',
  name:'Agent / Development',event:'workflow_dispatch',
  status:'completed',conclusion:'failure',actor:{login:'github-actions[bot]'},
  repository:{full_name:repo},head_repository:{full_name:repo}};
const step=(name,conclusion)=>({name,conclusion,status:'completed'});
const qwen={id:134640077758,run_id:s.run_id,run_attempt:1,
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
  {id:134639887980,name:'claim',status:'completed',conclusion:'success'},
  qwen,...['qwen-restore','restore','developer','wake-qwen-result'].map((name,i)=>({
    id:i+3,name,status:'completed',conclusion:'skipped'}))
]};
const artifacts={total_count:2,artifacts:[
  {id:14406396956,name:'development-worker-claim-'+s.run_id+'-1',
    digest:'sha256:50cef1cbb0b5b4eed518a6a8f61ec7524616e27a9a6af3990c517ae7bcb9eac2',
    expired:false,size_in_bytes:1010,
    workflow_run:{id:s.run_id,head_sha:s.run_head_sha}},
  {id:14405618537,name:'agent-telemetry-developer-'+s.run_id+'-1',
    digest:'sha256:03196d3fc7fe549d40b8d151742a5d87a9fe2f884e5af0e4a7db876833ab157d',
    expired:false,size_in_bytes:874,
    workflow_run:{id:s.run_id,head_sha:s.run_head_sha}},
]};
const log='2026-11-18T07:11:03Z ##[error]Qwen Developer source: required actual restricted native Read/Edit evidence missing\n'+
  '2026-11-18T07:11:03Z ##[error]Process completed with exit code 1.\n';
const proof=verifyQwenToolPolicyFailure(run,jobs,artifacts,log);
assert.deepEqual(proof,{verified:true,...s});
for(const [r,j,a,l] of [
  [{...run,run_attempt:2},jobs,artifacts,log],
  [{...run,conclusion:'success'},jobs,artifacts,log],
  [{...run,actor:{login:'attacker'}},jobs,artifacts,log],
  [{...run,head_sha:'0'.repeat(40)},jobs,artifacts,log],
  [run,{...jobs,total_count:7},artifacts,log],
  [run,{...jobs,jobs:jobs.jobs.map(x=>x.name==='qwen-developer'?
    {...x,steps:x.steps.map(t=>t.name.startsWith('Execute Store-admitted')?
      {...t,conclusion:'success'}:t)}:x)},artifacts,log],
  [run,jobs,{...artifacts,total_count:3},log],
  [run,jobs,{...artifacts,artifacts:artifacts.artifacts.map(x=>({
    ...x,digest:'sha256:'+'a'.repeat(64)}))},log],
  [run,jobs,artifacts,'The model succeeded'],
])assert.throws(()=>verifyQwenToolPolicyFailure(r,j,a,l),
  /trusted Qwen readonly-tool recovery/);
const mock=async url=>{
  const key=url.replace('https://api.github.com/repos/'+repo,'');
  const data=key==='/actions/runs/'+s.run_id?run:
    key==='/actions/runs/'+s.run_id+'/jobs?per_page=100'?jobs:
    key==='/actions/runs/'+s.run_id+'/artifacts?per_page=100'?artifacts:null;
  if(key==='/actions/jobs/134640077758/logs')return {ok:true,
    headers:{get:()=>String(log.length)},text:async()=>log};
  if(data)return {ok:true,json:async()=>data};
  throw Error('unexpected GitHub evidence read '+key);
};
assert.deepEqual(await verifyQwenToolPolicyFailureLive('token-for-fixture',mock),proof);
const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const first=startDevelopment(registry,{issue:s.issue,sha:s.source_sha,
  developer:'dev-qwen-01',reviewer:'review-qwen-01',acceptor:'accept-qwen-01'},
  {repository:repo,event:'workflow_dispatch',permission:'write',
    ref:'refs/heads/main',run_id:44250414354});
assert.equal(first.outbox[0].id,FIRST.action_id);
const intent1=recordDispatchIntent(first,1,FIRST.action_id,{
  status:'prepared',dispatch_id:FIRST.action_id,issuer_run_id:44250480096,
  ticket_sha256:'a'.repeat(64)});
const disp1=recordDispatch(intent1,2,FIRST.action_id,{
  status:'verified',dispatch_id:FIRST.action_id,source_run_id:FIRST.run_id});
const proof1={verified:true,...FIRST};
const failed1=recordAttestedQwenCliFailure(disp1,3,proof1);
const successorId=qwenCliSuccessorId(s.issue,FIRST.action_id,FIRST.run_id);
assert.equal(failed1.outbox[1].id,s.action_id);
assert.equal(successorId,s.action_id);
const intent2=recordDispatchIntent(failed1,4,s.action_id,{
  status:'prepared',dispatch_id:s.action_id,issuer_run_id:44256547683,
  ticket_sha256:'b'.repeat(64)});
const disp2=recordDispatch(intent2,5,s.action_id,{
  status:'verified',dispatch_id:s.action_id,source_run_id:s.run_id});
assert.equal(disp2.version,6);
const next=recordAttestedQwenToolFailure(disp2,6,proof);
validateDevelopmentState(next);
assert.equal(next.version,7);
assert.equal(next.outbox.length,3);
assert.equal(next.outbox[0].status,'failed');
assert.equal(next.outbox[1].status,'failed');
assert.equal(next.outbox[1].receipt.failure_code,s.failure_code);
assert.equal(next.outbox[2].status,'pending');
assert.equal(next.outbox[2].attempts,0);
assert.equal(next.outbox[2].id,qwenToolSuccessorId(s.issue,s.action_id,s.run_id));
assert.deepEqual(next.outbox[2].task,disp2.outbox[1].task);
for(const bad of [{run_id:s.run_id+1},{issue:3885},{verified:false},
  {attempt:2},{source_sha:'0'.repeat(40)},
  {failure_code:'qwen_node_cli_invocation_failed'}])
  assert.throws(()=>recordAttestedQwenToolFailure(disp2,6,{...proof,...bad}),
    /agent outbox/);
assert.throws(()=>recordAttestedQwenToolFailure(disp2,5,proof),
  /agent outbox/);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-discovery-store-'));
const remote=path.join(root,'store.git'),work=path.join(root,'work');
const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{
  encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,
  env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
}).trim();
try{
  execFileSync('git',['init','--bare',remote],{stdio:'ignore'});
  execFileSync('git',['clone',remote,work],{stdio:'ignore'});
  git(work,'config','user.name','Nession Tool Recovery Test');
  git(work,'config','user.email','nession-test@example.invalid');
  git(work,'checkout','--orphan','agent-store');
  git(work,'commit','--allow-empty','-m','initialize test Store');
  git(work,'push','-u','origin','agent-store');
  const history=[first,intent1,disp1,failed1,intent2,disp2];
  for(let i=0;i<history.length;i++){
    writeIssueWorkflowState(work,history[i],i);
    git(work,'add','-A');git(work,'commit','-m','state '+history[i].version);
    git(work,'push','origin','agent-store');
  }
  const restored=recoverAttestedQwenToolFailure({
    remote:'file://'+remote,source:proof});
  assert.equal(restored.status,'recovered');
  assert.equal(restored.state_version,7);
  assert.equal(restored.action_id,next.outbox[2].id);
  const replay=recoverAttestedQwenToolFailure({
    remote:'file://'+remote,source:proof});
  assert.equal(replay.status,'replayed');
  assert.equal(replay.action_id,restored.action_id);
  git(work,'pull','--ff-only','origin','agent-store');
  assert.deepEqual(readIssueWorkflowState(work,s.issue).state,next);
  assert.throws(()=>recoverAttestedQwenToolFailure({
    remote:'file://'+remote,source:{...proof,run_id:s.run_id+1}}),
    /trusted dispatch Store/);
  assert.equal(readIssueWorkflowState(work,s.issue).state.outbox.length,3);
}finally{fs.rmSync(root,{recursive:true,force:true});}
console.log('Qwen read-only Grep rejected Run: exact signed source, Store v6->v7 CAS, one successor and replay negatives pass');
