#!/usr/bin/env node
// #4016: authenticated #3784 / PR #3919 second Reviewer post-model failure.
// Exact immutable agent-store v22 fixture, three GitHub Jobs, two Artifacts;
// no Issue/PR/Store write and no model verdict substitution.
import assert from 'node:assert/strict';
import {REVIEWER_JSON_FAILURE_3784 as F,
  REVIEWER_PREMODEL_FAILURE_3784 as P,
  validateDevelopmentState,reviewerJsonSuccessorId,
  recordAttestedReviewerJsonFailure,
  hasOnlyRetiredReviewerForQwenRepair} from './outbox.mjs';
import {attestReviewerJsonFailure} from './reviewer-json-failure.mjs';

const original={
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
validateDevelopmentState(original);
const repository={full_name:'BestNathan/nession'};
const run={id:F.run_id,run_attempt:1,name:'Agent / Review',
  path:'.github/workflows/agent-review.yml',event:'workflow_dispatch',
  actor:{login:'github-actions[bot]'},head_branch:'main',
  head_sha:F.main_sha,status:'completed',conclusion:'failure',
  repository,head_repository:repository};
const step=(name,conclusion)=>({name,status:'completed',conclusion});
const job=(name,conclusion,steps)=>({name,run_id:F.run_id,run_attempt:1,
  status:'completed',conclusion,steps});
const listing={total_count:3,jobs:[
  job('prepare','success',[
    step('Prepare the reviewer admission','success')]),
  job('review','failure',[
    step('Run the read-only Reviewer Slice directly with Node.js','failure'),
    step('Upload the canonical Agent result artifact','success')]),
  job('notify-metrics','skipped',[]),
]};
const artifact=(kind,id)=>({id,
  name:kind+'-'+F.run_id+'-1',size_in_bytes:2500,expired:false,
  digest:'sha256:'+'a'.repeat(64),
  workflow_run:{id:F.run_id,head_sha:F.main_sha}});
const artifacts={total_count:2,artifacts:[
  artifact('review-admission',123),artifact('review-claim',124)]};
const proof=attestReviewerJsonFailure(run,listing,artifacts);
assert.deepEqual(proof,{verified:true,issue:F.issue,action_id:F.action_id,
  run_id:F.run_id,attempt:1,source_sha:F.source_sha,
  failure_code:F.failure_code});
for(const bad of [
  {run:{...run,id:F.run_id+1}},
  {run:{...run,run_attempt:2}},
  {run:{...run,head_sha:'0'.repeat(40)}},
  {run:{...run,actor:{login:'attacker'}}},
  {run:{...run,event:'issue_comment'}},
  {run:{...run,conclusion:'success'}},
  {jobs:{...listing,jobs:[...listing.jobs,job('extra','success',[])]}},
  {jobs:{...listing,jobs:listing.jobs.map(j=>j.name==='review'?
    {...j,conclusion:'success'}:j)}},
  {jobs:{...listing,jobs:listing.jobs.map(j=>j.name==='prepare'?
    {...j,conclusion:'failure'}:j)}},
  {jobs:{...listing,jobs:listing.jobs.map(j=>j.name==='review'?
    {...j,steps:[step('Run the read-only Reviewer Slice in an OS-isolated container','failure')]}:j)}},
  {artifacts:{...artifacts,total_count:3,artifacts:[
    ...artifacts.artifacts,artifact('agent-result',125)]}},
  {artifacts:{total_count:1,artifacts:artifacts.artifacts.slice(0,1)}},
  {artifacts:{total_count:2,artifacts:artifacts.artifacts.map((a,i)=>
    i?{...a,digest:'wrong'}:a)}},
  {artifacts:{total_count:2,artifacts:artifacts.artifacts.map((a,i)=>
    i?{...a,workflow_run:{...a.workflow_run,head_sha:'0'.repeat(40)}}:a)}},
])assert.throws(()=>attestReviewerJsonFailure(
  bad.run??run,bad.jobs??listing,bad.artifacts??artifacts),
  /trusted Reviewer JSON failure/);

const id=reviewerJsonSuccessorId(F.issue,F.action_id,F.run_id);
const recovered=recordAttestedReviewerJsonFailure(original,22,proof);
assert.equal(recovered.version,23);
assert.equal(recovered.phase,'review');
assert.equal(recovered.target_sha,F.source_sha);
assert.deepEqual(recovered.transitions,original.transitions);
assert.deepEqual(recovered.outbox.slice(0,3),original.outbox.slice(0,3));
assert.equal(recovered.outbox.length,5);
assert.equal(recovered.outbox[3].id,F.action_id);
assert.equal(recovered.outbox[3].status,'failed');
assert.equal(recovered.outbox[3].receipt.source_run_id,F.run_id);
assert.equal(recovered.outbox[3].receipt.failure_code,F.failure_code);
assert.equal(recovered.outbox[4].id,id);
assert.equal(recovered.outbox[4].status,'pending');
assert.deepEqual(recovered.outbox[4].task,original.outbox[3].task);
assert.equal(recovered.outbox[4].receipt,null);
assert.equal(recovered.outbox[2].id,P.action_id);

for(const change of [
  {state:{...original,version:23}},
  {state:{...original,phase:'repair'}},
  {state:{...original,target_sha:'0'.repeat(40)}},
  {state:{...original,transitions:original.transitions.slice(0,-1)}},
  {state:{...original,outbox:original.outbox.slice(1)}},
  {state:{...original,outbox:original.outbox.map((a,i)=>
    i===3?{...a,receipt:{...a.receipt,source_run_id:999}}:a)}},
  {proof:{...proof,issue:3433}},
  {proof:{...proof,run_id:999}},
  {proof:{...proof,source_sha:'0'.repeat(40)}},
  {proof:{...proof,verified:false}},
]){
  assert.throws(()=>recordAttestedReviewerJsonFailure(
    change.state??original,22,change.proof??proof),/agent outbox/);
}
assert.throws(()=>recordAttestedReviewerJsonFailure(recovered,23,proof),
  /agent outbox/);
assert.throws(()=>reviewerJsonSuccessorId(F.issue,F.action_id,F.run_id+1),
  /agent outbox/);

const retired=recovered.outbox.filter(x=>x.task.role==='reviewer'&&
  x.status==='failed');
assert.equal(retired.length,2);
assert.equal(hasOnlyRetiredReviewerForQwenRepair({
  ...recovered,outbox:retired}),true);
for(const bad of [
  {...retired[1],status:'dispatched'},
  {...retired[1],receipt:{...retired[1].receipt,source_run_id:1}},
  {...retired[1],id:'0'.repeat(64)},
  {...retired[1],task:{...retired[1].task,sha:'0'.repeat(40)}},
]){
  assert.equal(hasOnlyRetiredReviewerForQwenRepair({
    ...recovered,outbox:[retired[0],bad]}),false);
}
assert.equal(hasOnlyRetiredReviewerForQwenRepair({...recovered,
  outbox:[...retired,retired[1]]}),false);
console.log('✓ #3784 Reviewer post-model failure: exact GitHub Run/3 Jobs/2 Artifacts, real v22→v23 CAS, two retired Reviewers, forgery and replay denied');
