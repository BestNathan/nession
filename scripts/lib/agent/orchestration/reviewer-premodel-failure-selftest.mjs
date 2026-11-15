#!/usr/bin/env node
import assert from 'node:assert/strict';
import {REVIEWER_PREMODEL_FAILURE as F,validateDevelopmentState,
  recordAttestedReviewerPremodelFailure,reviewerPremodelSuccessorId}
  from './outbox.mjs';
import {attestReviewerPremodelFailure} from './reviewer-premodel-failure.mjs';
const REPO='BestNathan/nession';
const run={id:F.run_id,run_attempt:1,name:'Agent / Review',
  path:'.github/workflows/agent-review.yml',event:'workflow_dispatch',
  actor:{login:'github-actions[bot]'},head_branch:'main',
  head_sha:F.main_sha,status:'completed',conclusion:'failure',
  repository:{full_name:REPO},head_repository:{full_name:REPO}};
const job=(name,conclusion,steps=[])=>({name,run_id:F.run_id,
  run_attempt:1,status:'completed',conclusion,steps});
const jobs={total_count:3,jobs:[
  job('prepare','failure',[{name:'Prepare the reviewer admission',
    status:'completed',conclusion:'failure'}]),
  job('review','skipped'),job('notify-metrics','skipped'),
]};
const proof=attestReviewerPremodelFailure(run,jobs);
assert.equal(proof.verified,true);
for(const [source,observation] of [
  [{...run,event:'push'},jobs],
  [{...run,run_attempt:2},jobs],
  [{...run,actor:{login:'BestNathan'}},jobs],
  [{...run,head_sha:'f'.repeat(40)},jobs],
  [{...run,status:'in_progress'},jobs],
  [{...run,conclusion:'success'},jobs],
  [run,{...jobs,total_count:2}],
  [run,{...jobs,jobs:[jobs.jobs[0],jobs.jobs[1],jobs.jobs[1]]}],
  [run,{...jobs,jobs:jobs.jobs.map((x,i)=>i===1?{...x,conclusion:'success'}:x)}],
  [run,{...jobs,jobs:jobs.jobs.map((x,i)=>i===0?{...x,
    steps:[{...x.steps[0],name:'Run model'}]}:x)}],
])assert.throws(()=>attestReviewerPremodelFailure(source,observation),
  /trusted Reviewer pre-model failure/);
const item={id:F.action_id,task:{type:'dispatch',role:'reviewer',
  task:'review',sha:F.source_sha,agent_id:'review-qwen-01'},
  status:'dispatched',attempts:1,receipt:{status:'verified',
    dispatch_id:F.action_id,source_run_id:F.run_id}};
const state={schema_version:1,issue:F.issue,version:6,phase:'review',
  target_sha:F.source_sha,repair_attempts:0,
  transitions:[{key:'a'.repeat(64),kind:'publisher',
    run_id:F.publisher_run_id,attempt:1,target_sha:F.source_sha,
    outcome:'published'}],
  assignments:{developer:'dev-qwen-01',reviewer:'review-qwen-01',
    acceptor:'accept-qwen-01'},outbox:[item]};
validateDevelopmentState(state);
const next=recordAttestedReviewerPremodelFailure(state,6,proof);
const successor=reviewerPremodelSuccessorId(F.issue,F.action_id,F.run_id);
assert.equal(next.version,7);
assert.equal(next.phase,'review');
assert.equal(next.outbox[0].status,'failed');
assert.equal(next.outbox[0].receipt.source_run_id,F.run_id);
assert.equal(next.outbox[1].id,successor);
assert.equal(next.outbox[1].status,'pending');
assert.equal(next.outbox[1].attempts,0);
assert.deepEqual(next.outbox[1].task,item.task);
for(const bad of [
  {version:7},{phase:'quality'},{target_sha:'b'.repeat(40)},
  {outbox:[{...item,attempts:2}]},
  {outbox:[{...item,receipt:{...item.receipt,source_run_id:1}}]},
  {transitions:[]},{outbox:[...state.outbox,...state.outbox]},
])assert.throws(()=>recordAttestedReviewerPremodelFailure(
  {...state,...bad},6,proof),/agent outbox/);
for(const bad of [
  {...proof,verified:false},{...proof,run_id:1},
  {...proof,source_sha:'b'.repeat(40)},
])assert.throws(()=>recordAttestedReviewerPremodelFailure(
  state,6,bad),/agent outbox/);
assert.throws(()=>recordAttestedReviewerPremodelFailure(next,7,proof),
  /agent outbox/);
console.log('✓ Reviewer pre-model failure: exact 3 Jobs, immutable Store successor, replay/forgery denial');
