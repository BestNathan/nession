#!/usr/bin/env node
// #4211: fail-closed exact real Qwen Reviewer post-model policy denial,
// State v19->v20, one successor and Git CAS replay. No Provider invocation.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {REVIEWER_TOOL_FAILURE_4065 as F,recordAttestedReviewerToolFailure,
  reviewerToolSuccessorId,validateDevelopmentState} from './outbox.mjs';
import {attestReviewerToolFailure4065,verifyReviewerToolFailure4065Live}
  from './reviewer-tool-failure-4065.mjs';
import {recoverAttestedReviewerToolFailure4065} from './dispatch-store.mjs';
import {readIssueWorkflowState} from './state-store.mjs';

const repo='BestNathan/nession';
const original=JSON.parse(fs.readFileSync(new URL('./fixtures/issue-4065-reviewer-v19.json',
  import.meta.url),'utf8'));
validateDevelopmentState(original);
const run={id:F.run_id,run_attempt:1,name:'Agent / Review',
  path:'.github/workflows/agent-review.yml',head_sha:F.main_sha,
  head_branch:'main',event:'workflow_dispatch',actor:{login:'github-actions[bot]'},
  status:'completed',conclusion:'failure',
  repository:{full_name:repo},head_repository:{full_name:repo}};
const step=(name,conclusion)=>({name,status:'completed',conclusion});
const jobs={total_count:3,jobs:[
  {name:'prepare',id:136428618296,run_id:F.run_id,status:'completed',
    conclusion:'success',steps:[step('Prepare the reviewer admission','success')]},
  {name:'review',id:136428975706,run_id:F.run_id,status:'completed',
    conclusion:'failure',steps:[step('Run the read-only Reviewer Slice directly with Node.js','failure')]},
  {name:'notify-metrics',id:136432056095,run_id:F.run_id,status:'completed',
    conclusion:'skipped'},
]};
const artifacts={total_count:2,artifacts:[
  {id:14649063663,name:'review-admission-'+F.run_id+'-1',
    digest:'sha256:ef6672ace1b6533e7a07517c9f16cbfa7dcc9f3747652ddbc774bb4e3790fc32',
    expired:false,size_in_bytes:1275,workflow_run:{id:F.run_id,head_sha:F.main_sha}},
  {id:14650262447,name:'review-claim-'+F.run_id+'-1',
    digest:'sha256:4ebf9b52b50b1723457d444177360a2d70677ff34983608acd95eb29c621c96a',
    expired:false,size_in_bytes:847,workflow_run:{id:F.run_id,head_sha:F.main_sha}},
]};
const log='Reviewer Slice: write/shell tool observed in a read-only review\n'+
  'Process completed with exit code 1.';
const proof=attestReviewerToolFailure4065(run,jobs,artifacts,log);
assert.deepEqual(proof,{verified:true,issue:F.issue,action_id:F.action_id,
  run_id:F.run_id,attempt:1,source_sha:F.source_sha,failure_code:F.failure_code});
for(const [r,j,a,l] of [
  [{...run,run_attempt:2},jobs,artifacts,log],
  [{...run,head_sha:'f'.repeat(40)},jobs,artifacts,log],
  [{...run,actor:{login:'attacker'}},jobs,artifacts,log],
  [{...run,conclusion:'success'},jobs,artifacts,log],
  [run,{...jobs,total_count:4},artifacts,log],
  [run,{...jobs,jobs:jobs.jobs.map(x=>x.name==='review'?
    {...x,steps:[step('Run the read-only Reviewer Slice directly with Node.js','success')]}:x)},
    artifacts,log],
  [run,jobs,{...artifacts,total_count:3},log],
  [run,jobs,{...artifacts,artifacts:artifacts.artifacts.map(x=>({...x,
    digest:'sha256:'+'f'.repeat(64)}))},log],
  [run,jobs,artifacts,'Review finished successfully'],
]){
  assert.throws(()=>attestReviewerToolFailure4065(r,j,a,l),
    /trusted Reviewer tool-policy failure/);
}
const mock=async url=>{
  const tail=url.replace('https://api.github.com/repos/'+repo,'');
  const obj=tail==='/actions/runs/'+F.run_id?run:
    tail==='/actions/runs/'+F.run_id+'/jobs?per_page=100'?jobs:
    tail==='/actions/runs/'+F.run_id+'/artifacts?per_page=100'?artifacts:null;
  if(tail==='/actions/jobs/136428975706/logs')return {ok:true,
    headers:{get:()=>String(log.length)},text:async()=>log};
  if(obj)return {ok:true,json:async()=>obj};
  throw Error('unexpected GitHub request');
};
assert.deepEqual(await verifyReviewerToolFailure4065Live('signed-source-read',mock),proof);
const next=recordAttestedReviewerToolFailure(original,19,proof);
validateDevelopmentState(next);
assert.equal(next.version,20);
assert.equal(next.phase,'review');
assert.equal(next.outbox.length,4);
assert.equal(next.outbox.find(o=>o.id===F.action_id).status,'failed');
const id=reviewerToolSuccessorId(F.issue,F.action_id,F.run_id);
const successor=next.outbox.find(o=>o.id===id);
assert.equal(successor.status,'pending');
assert.deepEqual(successor.task,original.outbox.find(o=>o.id===F.action_id).task);
for(const invalid of [{attempt:2},{issue:4066},{action_id:'e'.repeat(64)},
  {run_id:F.run_id+1},{source_sha:'f'.repeat(40)},
  {verified:false},{failure_code:'qwen_reviewer_invalid_json_after_model'}])
  assert.throws(()=>recordAttestedReviewerToolFailure(original,19,{...proof,...invalid}),
    /agent outbox/);
assert.throws(()=>recordAttestedReviewerToolFailure(original,18,proof),/agent outbox/);
assert.throws(()=>recordAttestedReviewerToolFailure(next,20,proof),/agent outbox/);
for(const bad of [
  {...next,outbox:next.outbox.map(o=>o.id===F.action_id?{...o,
    receipt:{...o.receipt,source_run_id:F.run_id+1}}:o)},
  {...next,outbox:next.outbox.map(o=>o.id===F.action_id?{...o,
    receipt:{...o.receipt,source_attempt:2}}:o)},
])assert.throws(()=>validateDevelopmentState(bad),/invalid authenticated failure receipt/);

const root=fs.mkdtempSync(path.join(os.tmpdir(),'reviewer-tool-policy-4065-'));
const remote=path.join(root,'store.git'),work=path.join(root,'work');
const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{
  encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,
  env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
}).trim();
try{
  execFileSync('git',['init','--bare',remote],{stdio:'ignore'});
  execFileSync('git',['clone',remote,work],{stdio:'ignore'});
  git(work,'config','user.name','Reviewer Tool Fixture');
  git(work,'config','user.email','nession-fixture@example.invalid');
  git(work,'checkout','--orphan','agent-store');
  const bytes=JSON.stringify(original,null,2)+'\n';
  const rel='workflows/issues/4065/states/00000019.json';
  const full=path.join(work,rel);
  fs.mkdirSync(path.dirname(full),{recursive:true});
  fs.writeFileSync(full,bytes);
  fs.writeFileSync(path.join(work,'workflows/issues/4065/head.json'),
    JSON.stringify({version:19,path:rel,
      sha256:createHash('sha256').update(bytes).digest('hex')},null,2)+'\n');
  git(work,'add','-A');git(work,'commit','-m','Signed source v19 fixture');
  git(work,'push','-u','origin','agent-store');
  const first=recoverAttestedReviewerToolFailure4065({remote:'file://'+remote,source:proof});
  assert.equal(first.status,'recovered');
  assert.equal(first.state_version,20);
  assert.equal(first.action_id,id);
  const replay=recoverAttestedReviewerToolFailure4065({remote:'file://'+remote,source:proof});
  assert.equal(replay.status,'replayed');
  assert.equal(replay.action_id,id);
  git(work,'pull','--ff-only','origin','agent-store');
  assert.deepEqual(readIssueWorkflowState(work,4065).state,next);
  assert.throws(()=>recoverAttestedReviewerToolFailure4065({
    remote:'file://'+remote,source:{...proof,run_id:F.run_id+1}}),
    /trusted dispatch Store/);
  assert.equal(readIssueWorkflowState(work,4065).state.outbox.length,4);
}finally{fs.rmSync(root,{recursive:true,force:true});}
console.log('#4211 Reviewer tool-policy denial: exact signed source, Store v19->v20, replay and spoof negatives passed');
