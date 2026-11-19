#!/usr/bin/env node
// #3885: real failed Reviewer pre-model oversized-base evidence and a
// single Store CAS successor. No original GitHub Run rerun or model verdict.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {SOURCE,attestQwenReviewerBaseFailure,
  verifyQwenReviewerBaseFailureLive} from './qwen-review-base-failure.mjs';
import {SOURCE as FIRST} from './qwen-cli-failure.mjs';
import {SOURCE as SECOND} from './qwen-tool-policy-failure.mjs';
import {recordAttestedQwenBaseReviewFailure,
  qwenBaseReviewSuccessorId,validateDevelopmentState} from './outbox.mjs';
import {recoverAttestedQwenBaseReviewFailure} from './dispatch-store.mjs';
import {writeIssueWorkflowState,readIssueWorkflowState} from './state-store.mjs';
const f=SOURCE,repo='BestNathan/nession';
const run={id:f.run_id,run_attempt:1,name:'Agent / Review',
  path:'.github/workflows/agent-review.yml',event:'workflow_dispatch',
  actor:{login:'github-actions[bot]'},head_branch:'main',
  head_sha:f.run_head_sha,status:'completed',conclusion:'failure',
  repository:{full_name:repo},head_repository:{full_name:repo}};
const job=(name,conclusion,steps=[])=>({name,run_id:f.run_id,
  run_attempt:1,status:'completed',conclusion,steps});
const jobs={total_count:3,jobs:[
  job('prepare','failure',[{name:'Prepare the reviewer admission',
    status:'completed',conclusion:'failure'}]),
  job('review','skipped'),job('notify-metrics','skipped'),
]};
const artifacts={total_count:0,artifacts:[]};
const log='2026-11-19T00:46:22Z ##[error]Reviewer admission prep: unsafe PR base file\\n'+
  '2026-11-19T00:46:22Z ##[error]Process completed with exit code 1.\\n';
const proof=attestQwenReviewerBaseFailure(run,jobs,artifacts,log);
assert.deepEqual(proof,{verified:true,...f});
for(const [r,j,a,l] of [
  [{...run,run_attempt:2},jobs,artifacts,log],
  [{...run,conclusion:'success'},jobs,artifacts,log],
  [{...run,head_sha:'0'.repeat(40)},jobs,artifacts,log],
  [{...run,actor:{login:'BestNathan'}},jobs,artifacts,log],
  [run,{...jobs,total_count:4},artifacts,log],
  [run,{...jobs,jobs:jobs.jobs.map(x=>x.name==='review'?
    {...x,conclusion:'success'}:x)},artifacts,log],
  [run,{...jobs,jobs:jobs.jobs.map(x=>x.name==='prepare'?
    {...x,steps:[{name:'Run model',conclusion:'failure'}]}:x)},artifacts,log],
  [run,jobs,{total_count:1,artifacts:[{id:1}]},log],
  [run,jobs,artifacts,'Provider model completed'],
]){
  assert.throws(()=>attestQwenReviewerBaseFailure(r,j,a,l),
    /trusted Qwen Reviewer oversized-base failure/);
}
const mock=async url=>{
  const key=url.replace('https://api.github.com/repos/'+repo,'');
  const obj=key==='/actions/runs/'+f.run_id?run:
    key==='/actions/runs/'+f.run_id+'/jobs?per_page=100'?jobs:
    key==='/actions/runs/'+f.run_id+'/artifacts?per_page=100'?artifacts:null;
  if(key==='/actions/jobs/135250113142/logs')return{ok:true,
    headers:{get:()=>String(log.length)},text:async()=>log};
  if(obj)return{ok:true,json:async()=>obj};
  throw Error('unexpected original GitHub source GET');
};
assert.deepEqual(await verifyQwenReviewerBaseFailureLive('source-read-token',mock),proof);
const makeFailed=(src,role,task,sha,code)=>({
  id:src.action_id,task:{type:'dispatch',role,task,sha,
    agent_id:role==='reviewer'?'review-qwen-01':'dev-qwen-01'},
  status:'failed',attempts:1,receipt:{status:'failed',
    dispatch_id:src.action_id,source_run_id:src.run_id,source_attempt:1,
    failure_code:code},
});
const reviewer={id:f.action_id,task:{type:'dispatch',role:'reviewer',
  task:'review',sha:f.source_sha,agent_id:'review-qwen-01'},
  status:'dispatched',attempts:1,receipt:{status:'verified',
    dispatch_id:f.action_id,source_run_id:f.run_id}};
const state={schema_version:1,issue:f.issue,version:12,phase:'review',
  target_sha:f.source_sha,repair_attempts:0,
  transitions:[{key:'884c1275d6fa1e9ddf6fd9d9aeac22d05cdf2be9c3054ff6e6aa584464f3056f',
    kind:'publisher',run_id:f.publisher_run_id,attempt:1,
    target_sha:f.source_sha,outcome:'published'}],
  assignments:{developer:'dev-qwen-01',reviewer:'review-qwen-01',
    acceptor:'accept-qwen-01'},
  outbox:[
    makeFailed(FIRST,'developer','implement',FIRST.source_sha,FIRST.failure_code),
    makeFailed(SECOND,'developer','implement',SECOND.source_sha,SECOND.failure_code),
    reviewer,
  ],
};
validateDevelopmentState(state);
const next=recordAttestedQwenBaseReviewFailure(state,12,proof);
assert.equal(next.version,13);
assert.equal(next.outbox.length,4);
assert.equal(next.outbox[2].status,'failed');
assert.equal(next.outbox[2].receipt.source_run_id,f.run_id);
assert.equal(next.outbox[3].id,
  qwenBaseReviewSuccessorId(f.issue,f.action_id,f.run_id));
assert.equal(next.outbox[3].status,'pending');
assert.deepEqual(next.outbox[3].task,reviewer.task);
for(const change of [
  {version:13},{phase:'ready'},{target_sha:'0'.repeat(40)},
  {outbox:[...state.outbox,...state.outbox]},
  {outbox:state.outbox.map(x=>x.id===reviewer.id?
    {...x,attempts:2}:x)},
  {outbox:state.outbox.map(x=>x.id===reviewer.id?
    {...x,receipt:{...x.receipt,source_run_id:7}}:x)},
]){
  assert.throws(()=>recordAttestedQwenBaseReviewFailure({...state,...change},12,proof),
    /agent outbox/);
}
for(const change of [
  {verified:false},{issue:3785},{attempt:2},{run_id:f.run_id+1},
  {run_head_sha:'0'.repeat(40)},{source_sha:'0'.repeat(40)},
  {failure_code:'model_failed'},
]){
  assert.throws(()=>recordAttestedQwenBaseReviewFailure(state,12,
    {...proof,...change}),/agent outbox/);
}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-review-base-cas-'));
const remote=path.join(tmp,'store.git'),work=path.join(tmp,'work');
const git=(...args)=>execFileSync('git',['-C',work,...args],{
  encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,
  env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
}).trim();
try{
  execFileSync('git',['init','--bare',remote],{stdio:'ignore'});
  execFileSync('git',['clone',remote,work],{stdio:'ignore'});
  git('config','user.name','Qwen Review Base Fixture');
  git('config','user.email','qwen-fixture@example.invalid');
  git('checkout','--orphan','agent-store');
  git('commit','--allow-empty','-m','init Store');
  git('push','-u','origin','agent-store');
  // An independent Store CAS state fixture with this exact immutable v12.
  // The Store write helper insists on version-monotonic, append-only states,
  // therefore preserve the same head version in the test.
  const history=[];for(let v=1;v<=12;v++){
    const versioned={...state,version:v};
    if(v===12)history.push(versioned);
  }
  // Write exact final current state directly into a fresh fixture Store.
  // readIssueWorkflowState validates its persisted version and SHA.
  const dir=path.join(work,'workflows/issues/'+f.issue+'/states');
  fs.mkdirSync(dir,{recursive:true});
  const data=JSON.stringify(state,null,2)+'\\n';
  const {createHash}=await import('node:crypto');
  const sum=createHash('sha256').update(data).digest('hex');
  fs.writeFileSync(path.join(dir,'00000012.json'),data);
  fs.writeFileSync(path.join(work,'workflows/issues/'+f.issue+'/head.json'),
    JSON.stringify({version:12,path:'workflows/issues/'+f.issue+
      '/states/00000012.json',sha256:sum},null,2)+'\\n');
  git('add','-A');git('commit','-m','authenticated existing Store v12');
  git('push','origin','agent-store');
  const recovered=recoverAttestedQwenBaseReviewFailure({
    remote:'file://'+remote,source:proof});
  assert.equal(recovered.status,'recovered');
  assert.equal(recovered.state_version,13);
  assert.equal(recovered.action_id,next.outbox[3].id);
  const replay=recoverAttestedQwenBaseReviewFailure({
    remote:'file://'+remote,source:proof});
  assert.equal(replay.status,'replayed');
  git('pull','--ff-only','origin','agent-store');
  assert.deepEqual(readIssueWorkflowState(work,f.issue).state,next);
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
console.log('Qwen Reviewer oversized base: original failed Run/3 Jobs/no Artifact, v12->v13 CAS, unique replacement and replay negatives passed');
