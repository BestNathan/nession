#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {REVIEWER_PREMODEL_FAILURE as F,
  REVIEWER_PREMODEL_FAILURE_3784 as F3784,
  REVIEWER_PREMODEL_FAILURE_3784_C as FC,
  hasOnlyRetiredReviewerForQwenRepair,validateDevelopmentState,
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

// #4001: retain the exact real Store v12 fixture (not a synthetic reset).
// Recovery must work with BOTH already retired Developer actions in its Outbox.
const v12={
  "schema_version": 1,
  "issue": 3784,
  "version": 12,
  "phase": "review",
  "target_sha": "5d7e9118b7e954e760cc680fff7d43b4f9e17612",
  "repair_attempts": 0,
  "transitions": [
    {
      "key": "884c1275d6fa1e9ddf6fd9d9aeac22d05cdf2be9c3054ff6e6aa584464f3056f",
      "kind": "publisher",
      "run_id": 44281178406,
      "attempt": 1,
      "target_sha": "5d7e9118b7e954e760cc680fff7d43b4f9e17612",
      "outcome": "published"
    }
  ],
  "assignments": {
    "developer": "dev-qwen-01",
    "reviewer": "review-qwen-01",
    "acceptor": "accept-qwen-01"
  },
  "outbox": [
    {
      "id": "11ecfaa5fe0cc391b31f1d3ec5ce89cdb833856ad484f940b9e720da33282d34",
      "task": {
        "type": "dispatch",
        "role": "developer",
        "task": "implement",
        "sha": "76ed2d01195ad31ecdef97bc40ffa9f6d48427e6",
        "agent_id": "dev-qwen-01"
      },
      "status": "failed",
      "attempts": 1,
      "receipt": {
        "status": "failed",
        "dispatch_id": "11ecfaa5fe0cc391b31f1d3ec5ce89cdb833856ad484f940b9e720da33282d34",
        "source_run_id": 44250586057,
        "source_attempt": 1,
        "failure_code": "qwen_node_cli_invocation_failed"
      }
    },
    {
      "id": "3687526b2196cbad0db36ff935cc29a97f89d84e85494bdebe1c08503fa86549",
      "task": {
        "type": "dispatch",
        "role": "developer",
        "task": "implement",
        "sha": "76ed2d01195ad31ecdef97bc40ffa9f6d48427e6",
        "agent_id": "dev-qwen-01"
      },
      "status": "failed",
      "attempts": 1,
      "receipt": {
        "status": "failed",
        "dispatch_id": "3687526b2196cbad0db36ff935cc29a97f89d84e85494bdebe1c08503fa86549",
        "source_run_id": 44256663685,
        "source_attempt": 1,
        "failure_code": "qwen_native_readonly_discovery_rejected"
      }
    },
    {
      "id": "1251328b3288d32c751a347a016ff5d25740704cd8b16e227bd49a6bdd672087",
      "task": {
        "type": "dispatch",
        "role": "reviewer",
        "task": "review",
        "sha": "5d7e9118b7e954e760cc680fff7d43b4f9e17612",
        "agent_id": "review-qwen-01"
      },
      "status": "dispatched",
      "attempts": 1,
      "receipt": {
        "status": "verified",
        "dispatch_id": "1251328b3288d32c751a347a016ff5d25740704cd8b16e227bd49a6bdd672087",
        "source_run_id": 44431618028
      }
    }
  ]
};
const run3784={...run,id:F3784.run_id,head_sha:F3784.main_sha};
const jobs3784={...jobs,jobs:jobs.jobs.map(j=>({...j,run_id:F3784.run_id}))};
const proof3784=attestReviewerPremodelFailure(run3784,jobs3784,F3784);
validateDevelopmentState(v12);
assert.equal(proof3784.issue,3784);
assert.equal(proof3784.source_sha,v12.target_sha);
const v13=recordAttestedReviewerPremodelFailure(v12,12,proof3784);
const newAction=reviewerPremodelSuccessorId(3784,F3784.action_id,F3784.run_id);
assert.equal(v13.version,13);
assert.equal(v13.phase,'review');
assert.equal(v13.target_sha,v12.target_sha);
assert.deepEqual(v13.transitions,v12.transitions,'Publisher provenance untouched');
assert.deepEqual(v13.outbox.slice(0,2),v12.outbox.slice(0,2),
  'historical failed Developer receipts untouched');
assert.equal(v13.outbox[2].status,'failed');
assert.equal(v13.outbox[2].receipt.source_run_id,F3784.run_id);
assert.equal(v13.outbox[2].receipt.failure_code,F3784.failure_code);
assert.equal(v13.outbox[3].id,newAction);
assert.equal(v13.outbox[3].status,'pending');
assert.deepEqual(v13.outbox[3].task,v12.outbox[2].task);
assert.equal(hasOnlyRetiredReviewerForQwenRepair(v13),false,
  'active successor forbids new Repair Publisher');
const retiredOnly={...v13,outbox:v13.outbox.filter(x=>x.id!==newAction)};
assert.equal(hasOnlyRetiredReviewerForQwenRepair(retiredOnly),true,
  'known terminal failure must not block a later signed Repair');
for(const change of [
  {...run3784,run_attempt:2},
  {...run3784,actor:{login:'BestNathan'}},
  {...run3784,head_sha:'f'.repeat(40)},
  {...run3784,conclusion:'success'},
]){
  assert.throws(()=>attestReviewerPremodelFailure(change,jobs3784,F3784),
    /trusted Reviewer pre-model failure/);
}
for(const wrongJobs of [
  {...jobs3784,total_count:2},
  {...jobs3784,jobs:jobs3784.jobs.map((x,i)=>i===1?{...x,conclusion:'success'}:x)},
  {...jobs3784,jobs:jobs3784.jobs.map((x,i)=>i===0?{...x,
    steps:[{name:'Run model',status:'completed',conclusion:'failure'}]}:x)},
]){
  assert.throws(()=>attestReviewerPremodelFailure(run3784,wrongJobs,F3784),
    /trusted Reviewer pre-model failure/);
}
for(const variant of [
  {...v12,version:11},
  {...v12,target_sha:'a'.repeat(40)},
  {...v12,outbox:[...v12.outbox,v12.outbox[2]]},
  {...v12,outbox:v12.outbox.map((x,i)=>i===2?{...x,
    receipt:{...x.receipt,source_run_id:1}}:x)},
  {...v12,outbox:v12.outbox.map((x,i)=>i===0?{...x,status:'pending',receipt:null}:x)},
]){
  assert.throws(()=>recordAttestedReviewerPremodelFailure(variant,12,proof3784),
    /agent outbox/);
}
for(const bad of [
  {...proof3784,verified:false},
  {...proof3784,source_sha:'f'.repeat(40)},
  {...proof3784,action_id:F.action_id},
]){
  assert.throws(()=>recordAttestedReviewerPremodelFailure(v12,12,bad),
    /agent outbox/);
}
assert.throws(()=>recordAttestedReviewerPremodelFailure(v13,13,proof3784),
  /agent outbox/);
assert.throws(()=>reviewerPremodelSuccessorId(3784,F.action_id,F3784.run_id),
  /agent outbox/);
console.log('✓ #3784 Reviewer pre-model: authentic v12→v13, exact SHA, unique successor, forgery and replay denial');


// #4097: immutable real Store v35, third-cycle Owner-published PR-C. No
// authored Reviewer verdict or synthetic reset may stand in for this source.
const v35=JSON.parse(readFileSync(new URL(
  './fixtures/issue-3784-reviewer-v35.json',import.meta.url),'utf8'));
validateDevelopmentState(v35);
const runC={...run,id:FC.run_id,head_sha:FC.main_sha};
const jobsC={...jobs,jobs:jobs.jobs.map(j=>({...j,run_id:FC.run_id}))};
const proofC=attestReviewerPremodelFailure(runC,jobsC,FC);
assert.equal(proofC.action_id,FC.action_id);
assert.equal(v35.version,FC.state_version);
assert.equal(v35.target_sha,FC.source_sha);
const v36=recordAttestedReviewerPremodelFailure(v35,35,proofC);
const successorC=reviewerPremodelSuccessorId(3784,FC.action_id,FC.run_id);
assert.equal(v36.version,36);
assert.equal(v36.target_sha,v35.target_sha);
assert.deepEqual(v36.transitions,v35.transitions);
assert.equal(v36.outbox.length,v35.outbox.length+1);
assert.deepEqual(v36.outbox.slice(0,-2),v35.outbox.slice(0,-1));
assert.equal(v36.outbox.at(-2).status,'failed');
assert.deepEqual(v36.outbox.at(-2).receipt,{
  status:'failed',dispatch_id:FC.action_id,
  source_run_id:FC.run_id,source_attempt:1,failure_code:FC.failure_code});
assert.equal(v36.outbox.at(-1).id,successorC);
assert.equal(v36.outbox.at(-1).status,'pending');
assert.deepEqual(v36.outbox.at(-1).task,v35.outbox.at(-1).task);
for(const delta of [
  {run_attempt:2},{event:'issue_comment'},
  {actor:{login:'BestNathan'}},{head_sha:'f'.repeat(40)},
  {conclusion:'success'},{name:'Agent / Development'},
])assert.throws(()=>attestReviewerPremodelFailure(
  {...runC,...delta},jobsC,FC),/trusted Reviewer pre-model failure/);
for(const mutated of [
  {...jobsC,total_count:4},
  {...jobsC,jobs:jobsC.jobs.map((j,i)=>i===0?{...j,conclusion:'success'}:j)},
  {...jobsC,jobs:jobsC.jobs.map((j,i)=>i===1?{...j,conclusion:'failure'}:j)},
  {...jobsC,jobs:jobsC.jobs.map((j,i)=>i===0?{...j,steps:[
    {name:'Run model',status:'completed',conclusion:'failure'}]}:j)},
])assert.throws(()=>attestReviewerPremodelFailure(runC,mutated,FC),
  /trusted Reviewer pre-model failure/);
for(const delta of [
  {version:36},{phase:'repair'},
  {target_sha:'b66bdec2a59a5480cf11a3d6e61c05d33d951044'},
  {repair_attempts:1},
  {transitions:v35.transitions.slice(0,4)},
  {transitions:v35.transitions.map((t,i)=>i===4
    ?{...t,write_ahead_publisher_run_id:44495243036}:t)},
  {outbox:v35.outbox.map((x,i)=>i===5
    ?{...x,receipt:{...x.receipt,source_run_id:1}}:x)},
  {outbox:v35.outbox.map((x,i)=>i===0
    ?{...x,status:'pending',receipt:null}:x)},
])assert.throws(()=>recordAttestedReviewerPremodelFailure(
  {...v35,...delta},35,proofC),/agent outbox/);
for(const delta of [
  {verified:false},{run_id:FC.run_id+1},
  {source_sha:'b66bdec2a59a5480cf11a3d6e61c05d33d951044'},
  {failure_code:'forged'},
])assert.throws(()=>recordAttestedReviewerPremodelFailure(
  v35,35,{...proofC,...delta}),/agent outbox/);
assert.throws(()=>recordAttestedReviewerPremodelFailure(v36,36,proofC),
  /agent outbox/);
console.log('✓ #4097 real Store v35→v36 exactly one pre-model Reviewer successor, replay/forgery denial');
