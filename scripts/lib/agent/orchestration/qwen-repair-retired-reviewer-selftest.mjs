#!/usr/bin/env node
// #3592: a trusted but terminal failed Reviewer preflight Run remains an
// immutable audit record and cannot block a later signed Repair publication.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {REVIEWER_PREMODEL_FAILURE as F,validateDevelopmentState,
  hasOnlyRetiredReviewerForQwenRepair,acceptAttestedQwenRepairPublication}
  from './outbox.mjs';

const A=F.source_sha,B='b'.repeat(40),REPO='BestNathan/nession';
const repairId='bdba0198ff28b74b8b1acdaaadfb8106d7fcc054a86cfc98c0f9d93b9f70a856';
const old={id:F.action_id,task:{type:'dispatch',role:'reviewer',
  task:'review',sha:A,agent_id:'review-qwen-01'},
  status:'failed',attempts:1,receipt:{status:'failed',
    dispatch_id:F.action_id,source_run_id:F.run_id,source_attempt:1,
    failure_code:F.failure_code}};
const repair={id:repairId,task:{type:'dispatch',role:'developer',
  task:'repair',sha:A,resume:true,agent_id:'dev-qwen-01',
  repair_checkpoint:{checkpoint_version:1,
    checkpoint_commit_sha:'c'.repeat(40),
    ciphertext_sha256:'d'.repeat(64),source_sha:'e'.repeat(40),
    source_run_id:43578706212}},
  status:'dispatched',attempts:1,receipt:{status:'verified',
    dispatch_id:repairId,source_run_id:43677482758}};
const state={schema_version:1,issue:F.issue,version:13,phase:'repair',
  target_sha:A,repair_attempts:1,transitions:[
    {key:'a'.repeat(64),kind:'publisher',run_id:F.publisher_run_id,
      attempt:1,target_sha:A,outcome:'published'},
    {key:'b'.repeat(64),kind:'reviewer',run_id:43669396046,
      attempt:1,target_sha:A,outcome:'changes_requested'},
  ],assignments:{developer:'dev-qwen-01',reviewer:'review-qwen-01',
    acceptor:'accept-qwen-01'},outbox:[old,repair]};
const registry=JSON.parse(fs.readFileSync(
  'automation/agents/registry.json','utf8'));
validateDevelopmentState(state);
assert.equal(hasOnlyRetiredReviewerForQwenRepair(state),true);
assert.equal(hasOnlyRetiredReviewerForQwenRepair({...state,
  outbox:[repair]}),true);
const publisherRun=43678506569;
const event={kind:'publisher',outcome:'published',issue:F.issue,
  run_id:publisherRun,run_attempt:1,target_sha:B};
const trusted={role:'publisher',workflow_run_id:publisherRun,attempt:1,
  issue:F.issue,source_sha:B,developer_action_id:repairId,
  developer_run_id:43677482758,developer_attempt:1,
  developer_source_sha:A,checkpoint_commit_sha:'f'.repeat(40),
  original_publisher_run_id:F.publisher_run_id,pr_number:3530,
  pr_previous_sha:A};
const published=acceptAttestedQwenRepairPublication(
  state,state.version,event,trusted,registry);
assert.equal(published.version,14);
assert.equal(published.phase,'review');
assert.equal(published.target_sha,B);
assert.equal(published.outbox.length,2);
assert.equal(published.outbox[0].status,'failed');
assert.deepEqual(published.outbox[0],old);
assert.equal(published.outbox[1].task.role,'reviewer');
assert.equal(published.outbox[1].status,'pending');
assert.equal(published.outbox[1].task.sha,B);
assert.equal(published.transitions.at(-1).run_id,publisherRun);
for(const wrong of [
  {...old,status:'pending',attempts:0,receipt:null},
  {...old,status:'dispatched',receipt:{status:'verified',
    dispatch_id:F.action_id,source_run_id:F.run_id}},
  {...old,id:'0'.repeat(64)},
  {...old,receipt:{...old.receipt,source_run_id:F.run_id+1}},
  {...old,receipt:{...old.receipt,failure_code:'forged'}},
  {...old,task:{...old.task,sha:B}},
]){
  assert.equal(hasOnlyRetiredReviewerForQwenRepair({...state,
    outbox:[wrong,repair]}),false);
  assert.throws(()=>acceptAttestedQwenRepairPublication(
    {...state,outbox:[wrong,repair]},state.version,event,trusted,registry),
  /agent outbox/);
}
assert.equal(hasOnlyRetiredReviewerForQwenRepair({
  ...state,outbox:[old,{...old,id:'1'.repeat(64)},repair]}),false);
assert.equal(hasOnlyRetiredReviewerForQwenRepair({
  ...state,issue:F.issue+1}),false);
assert.throws(()=>acceptAttestedQwenRepairPublication(
  {...state,outbox:[old,{...old,id:'1'.repeat(64)},repair]},
  state.version,event,trusted,registry),/agent outbox/);
assert.throws(()=>acceptAttestedQwenRepairPublication(
  state,state.version,event,{...trusted,developer_run_id:1},registry),
  /agent outbox/);
assert.throws(()=>acceptAttestedQwenRepairPublication(
  state,state.version,event,{...trusted,pr_previous_sha:B},registry),
  /agent outbox/);
console.log('✓ signed Qwen Repair A->B: exact terminal Reviewer failure retained; active, forged, duplicate and unrelated Reviewer denied');
