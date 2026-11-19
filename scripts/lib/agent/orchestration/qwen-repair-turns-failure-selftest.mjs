#!/usr/bin/env node
// #3885: the REAL v29 second native Qwen Repair failed after v2 Restore.
// Failure evidence must be read-only, source-pinned and replay-safe. A model
// cannot create a new Action or update Store by claiming it ran out of turns.
import assert from 'node:assert/strict';
import {SOURCE as F,verifyQwenRepairTurnsFailure}
  from './qwen-repair-turns-failure.mjs';
import {recordAttestedQwenRepairTurnsFailure,qwenRepairTurnsSuccessorId,
  validateDevelopmentState,recordDispatchIntent,recordDispatch,
  acceptAttestedQwenRepairPublication} from './outbox.mjs';
import fs from 'node:fs';

const original={
  "schema_version": 1,
  "issue": 3784,
  "version": 29,
  "phase": "repair",
  "target_sha": "51f82d64ec159397ea501e6cbb99e7039ee141bd",
  "repair_attempts": 2,
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
    },
    {
      "key": "2c81d01d5c1fc431108dc555b34b1fb4d29f9d050e89bd51e89a4839a1956c30",
      "kind": "reviewer",
      "run_id": 44466992692,
      "attempt": 1,
      "target_sha": "51f82d64ec159397ea501e6cbb99e7039ee141bd",
      "outcome": "changes_requested"
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
      "status": "failed",
      "attempts": 1,
      "receipt": {
        "status": "failed",
        "dispatch_id": "3655ed38e7e9247dfd916b6590a5dd3ad540cead5a2cf5c2fa416be7893a28f9",
        "source_run_id": 44458253065,
        "source_attempt": 1,
        "failure_code": "qwen_reviewer_out_of_scope_finding_post_model"
      }
    },
    {
      "id": "5107e565bc70480fc49f726033d1185888b19f80d79a282eb53583d966d581e8",
      "task": {
        "type": "dispatch",
        "role": "developer",
        "task": "repair",
        "sha": "51f82d64ec159397ea501e6cbb99e7039ee141bd",
        "resume": true,
        "agent_id": "dev-qwen-01",
        "repair_checkpoint": {
          "checkpoint_version": 2,
          "checkpoint_commit_sha": "5abbda5ec5bb7979b3990cc7fcc21295ab2be9c2",
          "ciphertext_sha256": "adb6d2437f2de6b209f9df0b93cf6fb7950c26b561550a747189015e69e6c510",
          "source_sha": "5d7e9118b7e954e760cc680fff7d43b4f9e17612",
          "source_run_id": 44457696317
        }
      },
      "status": "dispatched",
      "attempts": 1,
      "receipt": {
        "status": "verified",
        "dispatch_id": "5107e565bc70480fc49f726033d1185888b19f80d79a282eb53583d966d581e8",
        "source_run_id": 44470557905
      }
    }
  ]
};
validateDevelopmentState(original);
const repo={full_name:'BestNathan/nession'};
const run={id:F.run_id,run_attempt:1,status:'completed',
  conclusion:'failure',name:'Agent / Development',
  path:'.github/workflows/agent-develop.yml',event:'workflow_dispatch',
  head_branch:'main',head_sha:F.run_head_sha,actor:{login:'github-actions[bot]'},
  repository:repo,head_repository:repo};
const step=(name,conclusion)=>({name,conclusion});
const makeJob=(name,conclusion,id,steps=[])=>({
  name,id,run_id:F.run_id,run_attempt:1,status:'completed',
  conclusion,steps});
const jobs={total_count:6,jobs:[
  makeJob('claim','success',135378698251),
  makeJob('qwen-restore','success',135378824035,[
    step('Require exact signed resumed Qwen Worker Store ACK','success'),
    step('Rewrap immutable original native Qwen checkpoint without any writer token','success'),
    step('Upload only authenticated recipient-bound Qwen ciphertext','success')]),
  makeJob('restore','skipped',135378825795),
  makeJob('developer','skipped',135378826085),
  makeJob('qwen-developer','failure',135378976890,[
    step('Require exact signed Qwen Store ACK before any model or source checkout','success'),
    step('Attest latest committed Qwen Reviewer Issue comment before Repair','success'),
    step('Restore Qwen native Session before Node model execution','success'),
    step('Execute Store-admitted Qwen Developer directly with Node.js','failure'),
    step('Upload canonical real Qwen Developer telemetry','success'),
    step('Upload only bounded patch and encrypted native Session','skipped'),
    step('Remove private transient restored Session and Issue data','success')]),
  makeJob('wake-qwen-result','skipped',135379419251),
]};
const art=(name,id,digest,size)=>({name,id,digest,size_in_bytes:size,
  expired:false,workflow_run:{id:F.run_id,head_sha:F.run_head_sha}});
const artifacts={total_count:3,artifacts:[
  art('development-worker-claim-44470557905-1',14503412956,
    'sha256:4d306f6adc8a1b06166e53aa26fd921e868bb5b39dd1cedaa0fc6b91df972573',1487),
  art('development-qwen-transfer-44470557905-1',14503923166,
    'sha256:236c43bb922c3a25d77d0c61976271893f8e18d894d040bca7c54e8340b0830d',250551),
  art('agent-telemetry-developer-44470557905-1',14503778718,
    'sha256:1eab4608abf7922583b7d29944338e08f62ecc17c4b136169be20978fdec5009',797),
]};
const log='##[error]Qwen Developer: Qwen CLI failed (status=1, terminal=other, '+
  'subtype=error_max_turns, provider_result_error=true, '+
  'stderr_category=model); raw model output withheld\n'+
  '##[error]Process completed with exit code 1.\n';
const proof=verifyQwenRepairTurnsFailure(run,jobs,artifacts,log);
assert.deepEqual(proof,{verified:true,issue:F.issue,action_id:F.action_id,
  run_id:F.run_id,attempt:1,source_sha:F.source_sha,
  run_head_sha:F.run_head_sha,failure_code:F.failure_code});
for(const wrong of [
  {run:{...run,run_attempt:2}},
  {run:{...run,id:1}},
  {run:{...run,actor:{login:'BestNathan'}}},
  {run:{...run,head_sha:F.source_sha}},
  {run:{...run,event:'issue_comment'}},
  {run:{...run,conclusion:'success'}},
  {jobs:{...jobs,total_count:7}},
  {jobs:{...jobs,jobs:jobs.jobs.map(x=>
    x.name==='qwen-developer'?{...x,conclusion:'success'}:x)}},
  {jobs:{...jobs,jobs:jobs.jobs.map(x=>
    x.name==='qwen-restore'?{...x,conclusion:'skipped'}:x)}},
  {jobs:{...jobs,jobs:jobs.jobs.map(x=>
    x.name==='qwen-developer'?{...x,steps:x.steps.map(s=>
      s.name.startsWith('Execute Store-admitted')
      ?{...s,conclusion:'success'}:s)}:x)}},
  {jobs:{...jobs,jobs:jobs.jobs.map(x=>
    x.name==='qwen-developer'?{...x,steps:x.steps.filter(s=>
      !s.name.includes('Upload only bounded'))}:x)}},
  {artifacts:{...artifacts,total_count:4}},
  {artifacts:{...artifacts,artifacts:artifacts.artifacts.map((x,i)=>
    i?{...x,digest:'sha256:'+'f'.repeat(64)}:x)}},
  {artifacts:{...artifacts,artifacts:artifacts.artifacts.slice(0,2)}},
  {log:log.replace('error_max_turns','success')},
  {log:'Qwen CLI failed with sensitive model output'},
]){
  assert.throws(()=>verifyQwenRepairTurnsFailure(
    wrong.run??run,wrong.jobs??jobs,wrong.artifacts??artifacts,
    wrong.log??log),/authenticated Qwen Repair turns failure/);
}

const next=recordAttestedQwenRepairTurnsFailure(original,29,proof);
assert.equal(next.version,30);
assert.equal(next.phase,'repair');
assert.equal(next.repair_attempts,2);
assert.deepEqual(next.transitions,original.transitions);
assert.equal(next.outbox.length,6);
assert.deepEqual(next.outbox.slice(0,4),original.outbox.slice(0,4));
assert.equal(next.outbox[4].id,F.action_id);
assert.equal(next.outbox[4].status,'failed');
assert.equal(next.outbox[4].receipt.source_run_id,F.run_id);
assert.equal(next.outbox[4].receipt.failure_code,F.failure_code);
const successor=next.outbox[5];
assert.equal(successor.id,qwenRepairTurnsSuccessorId(F.issue,F.action_id,F.run_id));
assert.equal(successor.status,'pending');
assert.equal(successor.attempts,0);
assert.equal(successor.receipt,null);
assert.deepEqual(successor.task,original.outbox[4].task);
assert.equal(successor.task.repair_checkpoint.checkpoint_version,2);
for(const wrong of [
  {state:{...original,version:28}},
  {state:{...original,phase:'review'}},
  {state:{...original,repair_attempts:3}},
  {state:{...original,target_sha:'f'.repeat(40)}},
  {state:{...original,transitions:original.transitions.slice(0,-1)}},
  {state:{...original,outbox:original.outbox.map((x,i)=>
     i===4?{...x,status:'pending',receipt:null,attempts:0}:x)}},
  {state:{...original,outbox:original.outbox.map((x,i)=>
     i===4?{...x,task:{...x.task,repair_checkpoint:{
       ...x.task.repair_checkpoint,checkpoint_version:1}}}:x)}},
  {proof:{...proof,verified:false}},
  {proof:{...proof,run_id:F.run_id+1}},
  {proof:{...proof,run_head_sha:'0'.repeat(40)}},
  {proof:{...proof,source_sha:'0'.repeat(40)}},
  {proof:{...proof,attempt:2}},
  {proof:{...proof,failure_code:'qwen_node_cli_invocation_failed'}},
]){
  assert.throws(()=>recordAttestedQwenRepairTurnsFailure(
    wrong.state??original,29,wrong.proof??proof),/agent outbox/);
}
assert.throws(()=>recordAttestedQwenRepairTurnsFailure(next,30,proof),
  /agent outbox/);
assert.throws(()=>qwenRepairTurnsSuccessorId(F.issue,F.action_id,F.run_id+1),
  /agent outbox/);
// The recovered v2 task may later publish a valid PR-C: its original PR-A
// issuer and latest PR-B issuer are distinct, as required for second Repair.
const prepared=recordDispatchIntent(next,30,successor.id,{
  status:'prepared',dispatch_id:successor.id,
  issuer_run_id:44480001000,ticket_sha256:'a'.repeat(64)});
const dispatched=recordDispatch(prepared,31,successor.id,{
  status:'verified',dispatch_id:successor.id,source_run_id:44480001001});
const shaC='e'.repeat(40),pubRun=44480001004;
const event={kind:'publisher',issue:F.issue,run_id:pubRun,run_attempt:1,
  target_sha:shaC,outcome:'published'};
const trusted={role:'publisher',workflow_run_id:pubRun,attempt:1,
  issue:F.issue,source_sha:shaC,
  developer_action_id:successor.id,developer_run_id:44480001001,
  developer_attempt:1,developer_source_sha:F.source_sha,
  checkpoint_commit_sha:'b'.repeat(40),
  original_publisher_run_id:44281178406,pr_number:3919,
  pr_previous_sha:F.source_sha};
const registry=JSON.parse(fs.readFileSync(
  'automation/agents/registry.json','utf8'));
const approved=acceptAttestedQwenRepairPublication(
  dispatched,32,event,trusted,registry);
assert.equal(approved.version,33);
assert.equal(approved.phase,'review');
assert.equal(approved.target_sha,shaC);
assert.equal(approved.outbox.find(x=>x.id===F.action_id)?.status,'failed');
assert.equal(approved.outbox.find(x=>x.id===successor.id),undefined);
assert.equal(approved.outbox.at(-1)?.task.role,'reviewer');
assert.equal(approved.transitions.at(-1)?.run_id,pubRun);
assert.equal(acceptAttestedQwenRepairPublication(
  approved,33,event,trusted,registry),approved);
for(const bad of [
  {...trusted,original_publisher_run_id:44480001003},
  {...trusted,pr_previous_sha:'f'.repeat(40)},
  {...trusted,developer_run_id:1},
]){
  assert.throws(()=>acceptAttestedQwenRepairPublication(
    dispatched,32,event,bad,registry),/agent outbox/);
}
console.log('✓ #3885 exact #3784 v29 native Repair max-turns failure, no-result artifact, v30 signed successor, v2 checkpoint, replay/forgery denial, second Publisher same-PR source');
