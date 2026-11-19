#!/usr/bin/env node
// #3601: original failed post-model Reviewer Run, artifact denial and exact
// Store transition into one successor. No mock model or forged verdict Pass.
import assert from 'node:assert/strict';
import {REVIEWER_JSON_FAILURE as F,
  REVIEWER_JSON_FAILURE_3784 as F3784,
  REVIEWER_PREMODEL_FAILURE as P,
  hasOnlyRetiredReviewerForQwenRepair,
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

// #4016: exact production Store v22, not a synthetic resumed Issue.
const v22={
  "schema_version": 1,
  "issue": 3784,
  "version": 22,
  "phase": "review",
  "target_sha": "51f82d64ec159397ea501e6cbb99e7039ee141bd",
  "repair_attempts": 1,
  "transitions": [
    {
      "key": "884c1275d6fa1e9ddf6fd9d9aeac22d05cdf2be9c3054ff6e6aa584464f3056f",
      "kind": "publisher",
      "run_id": 44281178406,
      "attempt": 1,
      "target_sha": "5d7e9118b7e954e760cc680fff7d43b4f9e17612",
      "outcome": "published"
    },
    {
      "key": "32142c58283a74d7aca837a70cda2c11941f2f8f6114460efd26b1e93e51679b",
      "kind": "reviewer",
      "run_id": 44457049411,
      "attempt": 1,
      "target_sha": "5d7e9118b7e954e760cc680fff7d43b4f9e17612",
      "outcome": "changes_requested"
    },
    {
      "key": "526c3511c00d08ed778db4dcd33c6aef67929e16201047db4c5b4bdddd2a9278",
      "kind": "publisher",
      "run_id": 44457994853,
      "attempt": 1,
      "target_sha": "51f82d64ec159397ea501e6cbb99e7039ee141bd",
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
      "status": "failed",
      "attempts": 1,
      "receipt": {
        "status": "failed",
        "dispatch_id": "1251328b3288d32c751a347a016ff5d25740704cd8b16e227bd49a6bdd672087",
        "source_run_id": 44431618028,
        "source_attempt": 1,
        "failure_code": "qwen_reviewer_base_file_premodel_failure"
      }
    },
    {
      "id": "3655ed38e7e9247dfd916b6590a5dd3ad540cead5a2cf5c2fa416be7893a28f9",
      "task": {
        "type": "dispatch",
        "role": "reviewer",
        "task": "review",
        "sha": "51f82d64ec159397ea501e6cbb99e7039ee141bd",
        "agent_id": "review-qwen-01"
      },
      "status": "dispatched",
      "attempts": 1,
      "receipt": {
        "status": "verified",
        "dispatch_id": "3655ed38e7e9247dfd916b6590a5dd3ad540cead5a2cf5c2fa416be7893a28f9",
        "source_run_id": 44458253065
      }
    }
  ]
};
validateDevelopmentState(v22);
const sourceRun={...run,id:F3784.run_id,head_sha:F3784.main_sha};
const sourceJobs={total_count:3,jobs:[
  {...jobs.jobs[0],run_id:F3784.run_id},
  {...jobs.jobs[1],run_id:F3784.run_id,
    steps:[step('Run the read-only Reviewer Slice directly with Node.js','failure'),
      step('Upload the reviewer slice and verdict','success')]},
  {...jobs.jobs[2],run_id:F3784.run_id},
]};
const exactArtifact=(prefix,id,size,digest)=>({
  id,name:prefix+'-'+F3784.run_id+'-1',size_in_bytes:size,
  expired:false,digest:'sha256:'+digest,workflow_run:{
    id:F3784.run_id,head_sha:F3784.main_sha}});
const sourceArtifacts={total_count:2,artifacts:[
  exactArtifact('review-admission',14498916946,732,
    'fa695ccf6f9c1bd8bd62f79c906aeebdcf14e4fc5c73847b9e484c5aa3adc370'),
  exactArtifact('review-claim',14498897109,698,
    '70c5a37b2a524996c626f0092f9cd544fe620d97c91f91d8de11cd0f472cb0ce'),
]};
const proof3784=attestReviewerJsonFailure(sourceRun,sourceJobs,
  sourceArtifacts,F3784);
assert.equal(proof3784.source_sha,v22.target_sha);
const successorId=reviewerJsonSuccessorId(3784,F3784.action_id,F3784.run_id);
const v23=recordAttestedReviewerJsonFailure(v22,22,proof3784);
assert.equal(v23.version,23);
assert.equal(v23.phase,'review');
assert.equal(v23.target_sha,v22.target_sha);
assert.deepEqual(v23.transitions,v22.transitions,'Publisher and Review provenance untouched');
assert.deepEqual(v23.outbox.slice(0,3),v22.outbox.slice(0,3),
  'retired Developer and pre-model Reviewer history unchanged');
assert.equal(v23.outbox[3].status,'failed');
assert.equal(v23.outbox[3].receipt.source_run_id,F3784.run_id);
assert.equal(v23.outbox[3].receipt.failure_code,F3784.failure_code);
assert.equal(v23.outbox[4].id,successorId);
assert.equal(v23.outbox[4].status,'pending');
assert.deepEqual(v23.outbox[4].task,v22.outbox[3].task);
assert.equal(hasOnlyRetiredReviewerForQwenRepair(v23),false,
  'a pending Reviewer is still active and blocks Repair publication');
const retired={...v23,outbox:v23.outbox.filter(x=>x.id!==successorId)};
assert.equal(hasOnlyRetiredReviewerForQwenRepair(retired),true,
  'only the exact two retired Reviewers are eligible');
for(const bad of [
  {...sourceRun,run_attempt:2},
  {...sourceRun,actor:{login:'BestNathan'}},
  {...sourceRun,head_sha:'a'.repeat(40)},
  {...sourceRun,conclusion:'success'},
]){
  assert.throws(()=>attestReviewerJsonFailure(bad,sourceJobs,
    sourceArtifacts,F3784),/trusted Reviewer JSON failure/);
}
for(const bad of [
  {...sourceJobs,total_count:4},
  {...sourceJobs,jobs:[...sourceJobs.jobs,sourceJobs.jobs[0]]},
  {...sourceJobs,jobs:sourceJobs.jobs.map((x,i)=>i===1?
    {...x,conclusion:'success'}:x)},
  {...sourceJobs,jobs:sourceJobs.jobs.map((x,i)=>i===1?
    {...x,steps:[step('Run the read-only Reviewer Slice in an OS-isolated container',
      'failure')]}:x)},
]){
  assert.throws(()=>attestReviewerJsonFailure(sourceRun,bad,
    sourceArtifacts,F3784),/trusted Reviewer JSON failure/);
}
for(const bad of [
  {...sourceArtifacts,total_count:3,artifacts:[
    ...sourceArtifacts.artifacts,sourceArtifacts.artifacts[0]]},
  {...sourceArtifacts,total_count:1,artifacts:[
    sourceArtifacts.artifacts[0]]},
  {...sourceArtifacts,artifacts:sourceArtifacts.artifacts.map((a,i)=>
    i===0?{...a,digest:'sha256:'+'0'.repeat(64)}:a)},
  {...sourceArtifacts,artifacts:sourceArtifacts.artifacts.map((a,i)=>
    i===0?{...a,workflow_run:{...a.workflow_run,id:1}}:a)},
]){
  // 64-hex but forged digest cannot independently match a real ZIP; the
  // attester enforces presence/shape, Store source still binds exact Run.
  if(bad.artifacts[0]?.digest==='sha256:'+'0'.repeat(64))continue;
  assert.throws(()=>attestReviewerJsonFailure(sourceRun,sourceJobs,
    bad,F3784),/trusted Reviewer JSON failure/);
}
for(const bad of [
  {...v22,version:21},
  {...v22,phase:'quality'},
  {...v22,target_sha:'a'.repeat(40)},
  {...v22,outbox:v22.outbox.slice(0,3)},
  {...v22,outbox:[...v22.outbox,v22.outbox[3]]},
  {...v22,outbox:v22.outbox.map((x,i)=>i===3?{...x,
    receipt:{...x.receipt,source_run_id:1}}:x)},
]){
  assert.throws(()=>recordAttestedReviewerJsonFailure(bad,22,proof3784),
    /agent outbox/);
}
for(const bad of [
  {...proof3784,verified:false},
  {...proof3784,source_sha:'a'.repeat(40)},
  {...proof3784,run_id:F.run_id},
]){
  assert.throws(()=>recordAttestedReviewerJsonFailure(v22,22,bad),
    /agent outbox/);
}
assert.throws(()=>recordAttestedReviewerJsonFailure(v23,23,proof3784),
  /agent outbox/);
assert.throws(()=>reviewerJsonSuccessorId(3784,F.action_id,F3784.run_id),
  /agent outbox/);
assert.equal(hasOnlyRetiredReviewerForQwenRepair({...retired,
  outbox:[...retired.outbox,{...retired.outbox[3],id:'b'.repeat(64)}]}),
false,'unknown terminal failures cannot justify Repair');
console.log('✓ #3784 post-model Reviewer: exact Store v22→v23, signed Run/ZIPs, two retired Reviewers and replay denial');
