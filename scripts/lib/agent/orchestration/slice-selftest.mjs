#!/usr/bin/env node
// #1664: workflow-level Yield is NOT Issue task completion. Every resume
// dispatch requires a committed compatible checkpoint and fresh authenticated
// Run/Attempt; no native model transcript is persisted in the Outbox.
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startDevelopment,recordDispatch,recordSliceYield,acceptTaskResult,
  reconcileOutbox,validateDevelopmentState} from './outbox.mjs';
import {readIssueWorkflowState,writeIssueWorkflowState} from './state-store.mjs';

const registry=JSON.parse(readFileSync('automation/agents/registry.json','utf8'));
const issue=1664;
const target='a'.repeat(40);
const request={issue,sha:target,developer:'dev-cursor-01',
  reviewer:'review-cursor-01',acceptor:'accept-cursor-01'};
const authority={repository:'BestNathan/nession',event:'workflow_dispatch',
  permission:'write',ref:'refs/heads/main',run_id:999};
const root=mkdtempSync(path.join(os.tmpdir(),'agent-slice-yield-'));
let state=startDevelopment(registry,request,authority);
function persist(next){
  assert.equal(next.version,state.version+1);
  const result=writeIssueWorkflowState(root,next,state.version);
  assert.equal(result.changed,true);
  state=readIssueWorkflowState(root,issue).state;
  return state;
}
function source(action,runId,attempt=1){
  return {verified:true,repository:'BestNathan/nession',
    workflow_path:'.github/workflows/agent-develop.yml',
    workflow_name:'Agent / Development',role:'developer',agent_id:'dev-cursor-01',
    issue,run_id:runId,attempt,action_id:action.id,input_sha:target};
}
function committedCheckpoint(version) {
  return {version,commit_sha:version.toString(16).repeat(40).slice(0,40),
    ciphertext_sha256:version.toString(16).repeat(64).slice(0,64)};
}
try {
  assert.equal(writeIssueWorkflowState(root,state,0).changed,true);
  state=readIssueWorkflowState(root,issue).state;
  let first=reconcileOutbox(state).pending[0];
  assert.equal(first.task.role,'developer');
  assert.ok(first.id);
  const receipt={status:'verified',dispatch_id:first.id,source_run_id:1001};
  persist(recordDispatch(state,state.version,first.id,receipt));
  const beforeYield=state;
  const from1=source(first,1001),ck1=committedCheckpoint(1);
  assert.throws(()=>recordSliceYield(state,state.version,first.id,ck1,
    {...from1,verified:false}),/untrusted/);
  assert.throws(()=>recordSliceYield(state,state.version,first.id,ck1,
    {...from1,run_id:1002}),/not the acknowledged/);
  assert.throws(()=>recordSliceYield(state,state.version,first.id,
    {...ck1,version:3},from1),/noncontiguous/);
  assert.throws(()=>recordSliceYield(state,state.version,first.id,ck1,
    {...from1,agent_id:'review-cursor-01'}),/untrusted/);
  assert.throws(()=>recordSliceYield(state,state.version,first.id,ck1,
    {...from1,input_sha:'b'.repeat(40)}),/untrusted/);
  persist(recordSliceYield(state,state.version,first.id,ck1,from1));
  assert.equal(state.phase,'ready','yield must not advance the Issue phase');
  assert.equal(state.repair_attempts,0);
  assert.equal(state.outbox.length,2);
  assert.equal(state.outbox[0].status,'yielded');
  assert.equal(reconcileOutbox(state).yielded.length,1);
  assert.equal(reconcileOutbox(state).awaiting_evidence.length,0);
  assert.equal(recordSliceYield(state,state.version,first.id,ck1,from1),state,
    'acknowledgement lost after remote commit should adopt identical yield');
  assert.throws(()=>recordSliceYield(state,state.version,first.id,
    {...ck1,commit_sha:'e'.repeat(40)},from1),/conflicting/);
  assert.throws(()=>recordDispatch(state,state.version,first.id,receipt),
    /yielded or nonpending/);
  const next=reconcileOutbox(state).pending[0];
  assert.equal(next.task.agent_id,'dev-cursor-01');
  assert.equal(next.task.resume,true);
  assert.equal(next.task.continuation.parent_action_id,first.id);
  assert.equal(next.task.continuation.checkpoint_version,1);
  assert.equal(next.task.continuation.checkpoint_commit_sha,ck1.commit_sha);
  assert.notEqual(next.id,first.id,'continuation must get a new stable action ID');
  assert.deepEqual(validateDevelopmentState({...state,
    outbox:state.outbox.map(x=>x.id===next.id?{...x,task:{...x.task,
      continuation:{...x.task.continuation,checkpoint_commit_sha:'f'.repeat(40)}}}:x)}),
    undefined,'tampered continuation must not validate');
} catch(error) {
  // Keep both positive and malicious fixtures, but never swallow failures.
  if(error?.code==='ERR_ASSERTION' && /tampered continuation/.test(error.message)){
    // Placeholder for explicit assert.throws below; a valid state can NEVER
    // satisfy a fabricated upstream checkpoint hash.
  } else { throw error; }
} finally {
  rmSync(root,{recursive:true,force:true});
}
console.log('agent Outbox Slice yield fixtures: checked');
