#!/usr/bin/env node
// #3601: original failed post-model Reviewer Run, artifact denial and exact
// Store transition into one successor. No mock model or forged verdict Pass.
import assert from 'node:assert/strict';
import {REVIEWER_JSON_FAILURE as F,REVIEWER_PREMODEL_FAILURE as P,
  validateDevelopmentState,reviewerJsonSuccessorId,
  recordAttestedReviewerJsonFailure} from './outbox.mjs';
import {attestReviewerJsonFailure} from './reviewer-json-failure.mjs';
const repo={full_name:'BestNathan/nession'};
const run={id:F.run_id,run_attempt:1,name:'Agent / Review',
  path:'.github/workflows/agent-review.yml',
  event:'workflow_dispatch',actor:{login:'github-actions[bot]'},
  head_branch:'main',head_sha:F.main_sha,status:'completed',
  conclusion:'failure',repository:repo,head_repository:repo};
const step=(name,conclusion)=>({name,status:'completed',conclusion});
const job=(name,conclusion,steps)=>({name,run_id:F.run_id,run_attempt:1,
  status:'completed',conclusion,steps});
const jobs={total_count:3,jobs:[
  job('prepare','success',[step('Prepare the reviewer admission','success')]),
  job('review','failure',[
    step('Run the read-only Reviewer Slice in an OS-isolated container','failure'),
    step('Upload the reviewer slice and verdict','success')]),
  job('notify-metrics','skipped',[])]};
const artifact=prefix=>({id:prefix==='review-claim'?123:124,
  name:prefix+'-'+F.run_id+'-1',size_in_bytes:1800,expired:false,
  digest:'sha256:'+'a'.repeat(64),workflow_run:{
    id:F.run_id,head_sha:F.main_sha}});
const artifacts={total_count:2,artifacts:[
  artifact('review-admission'),artifact('review-claim')]};
const proof=attestReviewerJsonFailure(run,jobs,artifacts);
assert.deepEqual(proof,{verified:true,issue:F.issue,action_id:F.action_id,
  run_id:F.run_id,attempt:1,source_sha:F.source_sha,
  failure_code:F.failure_code});
for(const bad of [
  {run:{...run,conclusion:'success'}},
  {run:{...run,actor:{login:'BestNathan'}}},
  {run:{...run,head_sha:'b'.repeat(40)}},
  {run:{...run,run_attempt:2}},
  {jobs:{...jobs,jobs:[...jobs.jobs,job('bad','success',[])]}},
  {jobs:{...jobs,jobs:jobs.jobs.map(j=>j.name==='review'?
    {...j,conclusion:'success'}:j)}},
  {jobs:{...jobs,jobs:jobs.jobs.map(j=>j.name==='prepare'?
    {...j,conclusion:'failure'}:j)}},
  {jobs:{...jobs,jobs:jobs.jobs.map(j=>j.name==='review'?
    {...j,steps:[step('Prepare the reviewer admission','failure')]}:j)}},
  {artifacts:{total_count:3,artifacts:[...artifacts.artifacts,
    artifact('reviewer-slice')]}},
  {artifacts:{total_count:1,artifacts:artifacts.artifacts.slice(0,1)}},
  {artifacts:{total_count:2,artifacts:artifacts.artifacts.map((a,i)=>
    i===0?{...a,digest:'bad'}:a)}},
  {artifacts:{total_count:2,artifacts:artifacts.artifacts.map((a,i)=>
    i===0?{...a,workflow_run:{...a.workflow_run,id:1}}:a)}},
])assert.throws(()=>attestReviewerJsonFailure(
  bad.run??run,bad.jobs??jobs,bad.artifacts??artifacts),
  /trusted Reviewer JSON failure/);

const A=P.source_sha,B=F.source_sha;
const old={id:P.action_id,task:{type:'dispatch',role:'reviewer',
  task:'review',sha:A,agent_id:'review-qwen-01'},
  status:'failed',attempts:1,receipt:{status:'failed',
    dispatch_id:P.action_id,source_run_id:P.run_id,source_attempt:1,
    failure_code:P.failure_code}};
const current={id:F.action_id,task:{type:'dispatch',role:'reviewer',
  task:'review',sha:B,agent_id:'review-qwen-01'},
  status:'dispatched',attempts:1,receipt:{status:'verified',
    dispatch_id:F.action_id,source_run_id:F.run_id}};
const state={schema_version:1,issue:F.issue,version:16,phase:'review',
  target_sha:B,repair_attempts:1,
  transitions:[
    {key:'a'.repeat(64),kind:'publisher',run_id:P.publisher_run_id,
      attempt:1,target_sha:A,outcome:'published'},
    {key:'b'.repeat(64),kind:'reviewer',run_id:43669396046,
      attempt:1,target_sha:A,outcome:'changes_requested'},
    {key:'c'.repeat(64),kind:'publisher',run_id:F.publisher_run_id,
      attempt:1,target_sha:B,outcome:'published',
      write_ahead_publisher_run_id:43678506569}],
  assignments:{developer:'dev-qwen-01',reviewer:'review-qwen-01',
    acceptor:'accept-qwen-01'},outbox:[old,current]};
validateDevelopmentState(state);
const id=reviewerJsonSuccessorId(F.issue,F.action_id,F.run_id);
assert.match(id,/^[a-f0-9]{64}$/);
const next=recordAttestedReviewerJsonFailure(state,16,proof);
assert.equal(next.version,17);
assert.equal(next.phase,'review');
assert.equal(next.target_sha,B);
assert.deepEqual(next.outbox[0],old);
assert.equal(next.outbox[1].status,'failed');
assert.equal(next.outbox[1].receipt.failure_code,F.failure_code);
assert.equal(next.outbox[1].receipt.source_run_id,F.run_id);
assert.equal(next.outbox[2].id,id);
assert.equal(next.outbox[2].status,'pending');
assert.deepEqual(next.outbox[2].task,current.task);
assert.equal(next.outbox[2].receipt,null);
assert.deepEqual(next.transitions,state.transitions);
for(const bad of [
  {state:{...state,version:17}},
  {state:{...state,target_sha:A}},
  {state:{...state,phase:'repair'}},
  {state:{...state,outbox:[current]}},
  {state:{...state,outbox:[old,{...current,receipt:{
    ...current.receipt,source_run_id:F.run_id+1}}]}},
  {state:{...state,transitions:state.transitions.slice(0,-1)}},
  {proof:{...proof,issue:F.issue+1}},
  {proof:{...proof,action_id:'0'.repeat(64)}},
  {proof:{...proof,run_id:F.run_id+1}},
  {proof:{...proof,verified:false}},
])assert.throws(()=>recordAttestedReviewerJsonFailure(
  bad.state??state,16,bad.proof??proof),/agent outbox/);
assert.throws(()=>recordAttestedReviewerJsonFailure(next,17,proof),
  /agent outbox/);
assert.throws(()=>reviewerJsonSuccessorId(F.issue,F.action_id,
  F.run_id+1),/agent outbox/);
console.log('Qwen Reviewer malformed JSON failure: exact immutable Run/Jobs/Artifacts, Store v16->v17 one successor, all spoof/replay negatives pass');
