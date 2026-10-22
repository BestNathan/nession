#!/usr/bin/env node
// Deterministic historical-v9 fixture: immutable Store lineage, NO Provider invocation.
import assert from 'node:assert/strict';
import {validateDevelopmentState,recordAttestedNativeResumeFailure,
  nativeResumeSuccessorId,recordDispatch,recordSliceYield,reconcileOutbox} from './outbox.mjs';

const original={"schema_version":1,"issue":1997,"version":9,"phase":"ready","target_sha":null,"repair_attempts":0,"transitions":[],"assignments":{"developer":"dev-cursor-01","reviewer":"review-cursor-01","acceptor":"accept-cursor-01"},"outbox":[{"id":"95b467a90a33b503dc19fb59f3a50378860e6e1eaa2961a0929ca97ae020edae","task":{"type":"dispatch","role":"developer","task":"implement","sha":"220266b9233ec97b1beacbc54e5cc7f82d3cece2","agent_id":"dev-cursor-01"},"status":"failed","attempts":1,"receipt":{"status":"failed","dispatch_id":"95b467a90a33b503dc19fb59f3a50378860e6e1eaa2961a0929ca97ae020edae","source_run_id":39267659650,"source_attempt":1,"failure_code":"native_sdk_sandbox_unavailable"}},{"id":"85b69a9de06b02eb78f8a3a15d14b58a43ffc83ee6b1f5db11b9b541cfec9656","task":{"type":"dispatch","role":"developer","task":"implement","sha":"220266b9233ec97b1beacbc54e5cc7f82d3cece2","agent_id":"dev-cursor-01"},"status":"yielded","attempts":1,"receipt":{"status":"yielded","dispatch_id":"85b69a9de06b02eb78f8a3a15d14b58a43ffc83ee6b1f5db11b9b541cfec9656","source_run_id":39288961865,"source_attempt":1,"checkpoint_version":1,"checkpoint_commit_sha":"d812e3655c0ad6337b1003aa0c1794c12335adb0","ciphertext_sha256":"a42220e24ed5ff587ed6173b662a75856f62e5a16561274cb616325b150f4107"}},{"id":"3f4abb86785d41dbb771edbab1c400841d3d0e60335358332307b75e1d36c1c8","task":{"type":"dispatch","role":"developer","task":"implement","sha":"220266b9233ec97b1beacbc54e5cc7f82d3cece2","agent_id":"dev-cursor-01","resume":true,"continuation":{"parent_action_id":"85b69a9de06b02eb78f8a3a15d14b58a43ffc83ee6b1f5db11b9b541cfec9656","ordinal":1,"checkpoint_version":1,"checkpoint_commit_sha":"d812e3655c0ad6337b1003aa0c1794c12335adb0","ciphertext_sha256":"a42220e24ed5ff587ed6173b662a75856f62e5a16561274cb616325b150f4107"}},"status":"dispatched","attempts":1,"receipt":{"status":"verified","dispatch_id":"3f4abb86785d41dbb771edbab1c400841d3d0e60335358332307b75e1d36c1c8","source_run_id":39376331942}}]};
const copy=x=>structuredClone(x);
const oldId='3f4abb86785d41dbb771edbab1c400841d3d0e60335358332307b75e1d36c1c8';
const run=39376331942;
const source={verified:true,issue:1997,run_id:run,attempt:1,
  failure_code:'native_cursor_agent_not_found_before_send'};
assert.equal(validateDevelopmentState(original).version,9);
const id=nativeResumeSuccessorId(1997,oldId,run);
assert.notEqual(id,oldId);
for(const patch of [{verified:false},{run_id:run+1},{attempt:2},
  {issue:1998},{failure_code:'native_sdk_sandbox_unavailable'}]){
  assert.throws(()=>recordAttestedNativeResumeFailure(original,9,oldId,
    {...source,...patch}),/unverified|unsupported/);
}
assert.throws(()=>nativeResumeSuccessorId(1997,oldId,run+1),/unsupported/);
assert.throws(()=>recordAttestedNativeResumeFailure(original,10,oldId,source),/stale/);
const wrong=copy(original);
wrong.outbox.at(-1).receipt.source_run_id=run+1;
assert.throws(()=>recordAttestedNativeResumeFailure(wrong,9,oldId,source),/unverified/);
const forged=copy(original);
forged.outbox.at(-1).task.continuation.checkpoint_commit_sha='f'.repeat(40);
assert.throws(()=>recordAttestedNativeResumeFailure(forged,9,oldId,source),/unbound/);
const next=recordAttestedNativeResumeFailure(original,9,oldId,source);
assert.equal(next.version,10);
assert.equal(original.version,9,'no in-place mutation');
assert.equal(next.outbox.length,original.outbox.length+1);
assert.equal(next.outbox.at(-2).id,oldId);
assert.equal(next.outbox.at(-2).status,'failed');
assert.equal(next.outbox.at(-2).receipt.source_run_id,run);
assert.equal(next.outbox.at(-1).status,'pending');
assert.equal(next.outbox.at(-1).id,id);
assert.deepEqual(next.outbox.at(-1).task,original.outbox.at(-1).task);
assert.equal(reconcileOutbox(next).pending.filter(a=>a.id===id).length,1);
assert.throws(()=>recordAttestedNativeResumeFailure(next,10,oldId,source),/already recovered/);
assert.throws(()=>validateDevelopmentState({...next,outbox:[
  ...next.outbox,{...next.outbox.at(-1),id:'f'.repeat(64)}]}),/unbound/);
const replay=copy(next);
replay.outbox.at(-2).status='dispatched';
replay.outbox.at(-2).receipt=copy(original.outbox.at(-1).receipt);
assert.throws(()=>validateDevelopmentState(replay),/unbound/);
const fork=copy(next);
fork.outbox.at(-1).task.continuation.checkpoint_version=2;
assert.throws(()=>validateDevelopmentState(fork),/unbound/);
const dispatched=recordDispatch(next,10,id,{status:'verified',
  dispatch_id:id,source_run_id:run+100});
assert.equal(dispatched.version,11);
const checkpoint={version:2,commit_sha:'a'.repeat(40),
  ciphertext_sha256:'b'.repeat(64)};
const worker={verified:true,repository:'BestNathan/nession',
  workflow_path:'.github/workflows/agent-develop.yml',
  workflow_name:'Agent / Development',role:'developer',agent_id:'dev-cursor-01',
  issue:1997,run_id:run+100,attempt:1,action_id:id,
  input_sha:'220266b9233ec97b1beacbc54e5cc7f82d3cece2'};
assert.throws(()=>recordSliceYield(dispatched,11,id,{...checkpoint,version:3},worker),/noncontiguous/);
const yielded=recordSliceYield(dispatched,11,id,checkpoint,worker);
assert.equal(yielded.version,12);
assert.equal(reconcileOutbox(yielded).pending.length,1);
assert.equal(reconcileOutbox(yielded).pending[0].task.continuation.ordinal,2);
assert.equal(validateDevelopmentState(yielded).version,12);
console.log('Native Resume Recovery: v9 CAS, one successor, replay/fork denial, v2 lineage fixtures passed');
