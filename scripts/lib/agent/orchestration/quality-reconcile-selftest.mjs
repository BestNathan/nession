import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {planQualityReconciliation,stageQualityReconciliation} from './quality-reconcile.mjs';
import {readIssueWorkflowState,writeIssueWorkflowState,issueStatePath} from './state-store.mjs';

const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const repo='BestNathan/nession',sha='a'.repeat(40),issue=1696,prNumber=2001;
const reviewerAction='b'.repeat(64),qualityAction='c'.repeat(64);
const state={schema_version:1,issue,version:1,phase:'quality',target_sha:sha,repair_attempts:0,
  transitions:[
    {key:'d'.repeat(64),kind:'publisher',run_id:100,attempt:1,target_sha:sha,outcome:'published'},
    {key:'e'.repeat(64),kind:'reviewer',run_id:101,attempt:1,target_sha:sha,outcome:'approved'},
  ],
  assignments:{developer:'dev-qwen-01',reviewer:'review-qwen-01',acceptor:'accept-qwen-01'},
  outbox:[{id:qualityAction,task:{type:'verify',gate:'quality',sha,agent_id:null},
    status:'pending',attempts:0,receipt:null}]};
const receipt={schema_version:2,kind:'authenticated_agent_task_result',issue,action_id:reviewerAction,
  result:{kind:'reviewer',issue,run_id:101,run_attempt:1,target_sha:sha,
    outcome:'approved',task_id:reviewerAction},
  source:{repository:repo,path:'.github/workflows/agent-review.yml',name:'Agent / Review',
    run_id:101,attempt:1,event:'workflow_dispatch',ref:'refs/heads/main',issue,
    task_id:reviewerAction,agent_id:'review-qwen-01',input_sha:sha,output_sha:sha,verified:true},
  artifact:{id:1001,digest:'sha256:'+'f'.repeat(64),json_sha256:'1'.repeat(64),
    source_run_id:101,source_run_attempt:1},
  acceptance_result:null,implementing_pr:{repository:repo,number:prNumber,head_sha_at_attestation:sha,
    relation:'trusted_pr_head_at_result_attestation'}};
const pr={number:prNumber,state:'open',head:{sha,ref:'agent/1696/qwen-fixture',repo:{full_name:repo,id:1}},
  base:{ref:'staging',repo:{full_name:repo,id:1}}};
const run={id:102,run_attempt:1,name:'CI / Quality Gate',path:'.github/workflows/ci-quality.yml',
  event:'pull_request',head_sha:sha,head_branch:pr.head.ref,status:'completed',conclusion:'success',
  created_at:'2026-01-01T00:00:00Z',repository:{full_name:repo},head_repository:{full_name:repo},
  pull_requests:[{number:prNumber,head:{sha,ref:pr.head.ref,repo:{id:1}},
    base:{ref:'staging',repo:{id:1}}}]};
function job(id,name,step,conclusion='success'){
  return {id,name,run_id:102,run_attempt:1,status:'completed',conclusion,
    steps:step?[{name:step,status:'completed',conclusion:'success'}]:[]};
}
const jobs=[
  job(1,'scope','Classify the exact PR or main-push change'),
  job(2,'web-check','Enforce applicable Quality results at the stable check name'),
  job(3,'instruction-check',null,'skipped'),
  job(4,'workflow-check',null,'skipped'),
  job(5,'rust-check','Verify Rust and required repository gates'),
  job(6,'tooling-check',null,'skipped'),
  job(7,'web-tests',null,'skipped'),
];
// A skipped job is an inapplicable outcome, not fabricated execution.
// Use the canonical Rust required-step spelling supplied by the attestor.
jobs[4].steps[0].name="Verify Rust and Acceptance Gates";
function reader({listed=[run],readback=run,jobList=jobs,firstPr=pr,lastPr=firstPr,
    owningIssue={number:issue,state:'open'}}={}){
  let pulls=0;
  return async endpoint=>{
    if(endpoint.endsWith('/pulls/'+prNumber))return ++pulls===1?firstPr:lastPr;
    if(endpoint.endsWith('/issues/'+issue))return owningIssue;
    if(endpoint.includes('/actions/workflows/ci-quality.yml/runs?'))
      return {total_count:listed.length,workflow_runs:listed};
    if(endpoint.endsWith('/actions/runs/102/attempts/1/jobs?per_page=100'))
      return {total_count:jobList.length,jobs:jobList};
    if(endpoint.endsWith('/actions/runs/102'))return readback;
    throw Error('unexpected endpoint '+endpoint);
  };
}
const plan=(overrides={})=>planQualityReconciliation({state,expectedVersion:1,
  reviewerReceipt:receipt,request:reader(),registry,...overrides});

// Quality before Reviewer: the attested result is reusable only after the
// canonical Reviewer transition creates the pending verification action.
assert.equal((await plan({state:{...state,phase:'review'},request:async()=>assert.fail('unexpected REST')})).status,'pending');
// Reviewer before Quality: pending observation is harmless; later same-head
// success converges through the same trusted source and single transition.
assert.equal((await plan({request:reader({listed:[]})})).status,'pending');
assert.equal((await plan({request:reader({listed:[{...run,conclusion:'failure'}]})})).status,'pending');
const verified=await plan();
assert.equal(verified.status,'verified',JSON.stringify(verified));
assert.equal(verified.acknowledged.outbox[0].receipt.source_run_id,102);
assert.equal(verified.next.phase,'acceptance');
assert.equal(verified.next.outbox[0].task.gate,'sc-acceptance');
assert.equal(verified.next.transitions.at(-1).run_id,102);
assert.equal(verified.next.transitions.at(-1).target_sha,sha);
assert.equal(verified.next.transitions.at(-1).attempt,1);
assert.equal((await plan({state:verified.next,expectedVersion:verified.next.version})).status,'pending');
for(const overrides of [
  {listed:[{...run,pull_requests:[]}]},
  {listed:[{...run,pull_requests:[{...run.pull_requests[0],number:prNumber+1}]}]},
  {listed:[{...run,head_sha:'2'.repeat(40)}]},
  {listed:[{...run,head_branch:'unrelated'}]},
  {jobList:jobs.map(j=>j.id===2?{...j,conclusion:'failure'}:j)},
  {jobList:jobs.map(j=>j.id===2?{...j,run_attempt:2}:j)},
  {readback:{...run,run_attempt:2}},
  {readback:{...run,id:103}},
  {firstPr:{...pr,state:'closed'}},
  {lastPr:{...pr,head:{...pr.head,sha:'2'.repeat(40)}}},
  {owningIssue:{number:issue+1,state:'open'}},
]){
  assert.equal((await plan({request:reader(overrides)})).status,'pending');
}
await assert.rejects(plan({expectedVersion:2}),/stale state CAS/);
await assert.rejects(plan({reviewerReceipt:{...receipt,issue:issue+1}}),/provenance|current approved/);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nession-quality-reconcile-test-'));
try{
  writeIssueWorkflowState(root,state,0);
  const original=fs.readFileSync(path.join(root,issueStatePath(issue,1)),'utf8');
  assert.equal(stageQualityReconciliation(root,verified).length,4);
  const actual=readIssueWorkflowState(root,issue);
  assert.equal(actual.version,3);
  assert.equal(actual.state.phase,'acceptance');
  assert.equal(fs.readFileSync(path.join(root,issueStatePath(issue,1)),'utf8'),original);
  assert.throws(()=>stageQualityReconciliation(root,verified),/stale state CAS/);
}finally{fs.rmSync(root,{recursive:true,force:true});}
console.log('Quality reconciliation: two arrival orders, exact PR/Run/Attempt and immutable CAS fixtures passed');

await import('./acceptance-reconcile-selftest.mjs');
