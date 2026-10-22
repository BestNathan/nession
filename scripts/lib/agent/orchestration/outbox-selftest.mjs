import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDevelopment,recordDispatch,failedDispatch,acceptTaskResult,
  reconcileOutbox,validateDevelopmentState } from './outbox.mjs';
import { readIssueWorkflowState, writeIssueWorkflowState,issueStatePath } from './state-store.mjs';
import { advanceWorkflow } from './transition.mjs';

const registry=JSON.parse(readFileSync('automation/agents/registry.json','utf8'));
const issue=1696;
const request={issue,sha:'a'.repeat(40),developer:'dev-cursor-01',
  reviewer:'review-cursor-01',acceptor:'accept-cursor-01'};
const permission={repository:'BestNathan/nession',event:'workflow_dispatch',
  permission:'write',ref:'refs/heads/main',run_id:1001};
let state=startDevelopment(registry,request,permission);
assert.equal(state.phase,'ready');
assert.equal(state.version,1);
assert.equal(reconcileOutbox(state).pending.length,1);
assert.deepEqual(startDevelopment(registry,request,permission),state);
assert.throws(()=>startDevelopment(registry,request,{...permission,ref:'refs/heads/untrusted'}),/unauthorized/);
assert.throws(()=>startDevelopment(registry,{...request,developer:'review-cursor-01'},permission),/role or ID/);
assert.throws(()=>startDevelopment(registry,{...request,sha:'main'},permission),/unauthorized/);
assert.throws(()=>startDevelopment(registry,request,{...permission,permission:'read'}),/unauthorized/);

const folder=mkdtempSync(path.join(os.tmpdir(),'agent-issue-outbox-'));
try {
  const committed=writeIssueWorkflowState(folder,state,0);
  assert.equal(committed.changed,true);
  assert.equal(committed.version,1);
  assert.equal(readIssueWorkflowState(folder,issue).state.phase,'ready');
  assert.equal(writeIssueWorkflowState(folder,state,0).changed,false);
  assert.throws(()=>writeIssueWorkflowState(folder,{...state,phase:'blocked'},0),/collision/);
  let counter=1234;
  function persist(next) {
    assert.equal(next.version,state.version+1);
    assert.equal(writeIssueWorkflowState(folder,next,state.version).changed,true);
    state=readIssueWorkflowState(folder,issue).state;
  }
  function firstPending() { return reconcileOutbox(state).pending[0]; }
  function deliver(item) {
    persist(recordDispatch(state,state.version,item.id,
      {status:'accepted',dispatch_id:item.id}));
    assert.equal(reconcileOutbox(state).awaiting_evidence.length,1);
    assert.equal(recordDispatch(state,state.version,item.id,
      {status:'accepted',dispatch_id:item.id}),state);
    assert.throws(()=>recordDispatch(state,state.version,item.id,
      {status:'accepted',dispatch_id:'0'.repeat(64)}),/invalid trusted/);
  }
  function result(kind,outcome,sha,fromSha,agentId,workflowPath,workflowName) {
    const item=reconcileOutbox(state).awaiting_evidence[0];
    assert.ok(item);
    const runId=counter++;
    const payload={kind,issue,run_id:runId,run_attempt:1,target_sha:sha,outcome,task_id:item.id};
    const source={repository:'BestNathan/nession',path:workflowPath,name:workflowName,
      run_id:runId,attempt:1,event:'workflow_dispatch',ref:'refs/heads/main',
      issue,task_id:item.id,agent_id:agentId,input_sha:fromSha,output_sha:sha,
      verified:true};
    return {payload,source};
  }

  const initial=firstPending();
  assert.equal(initial.task.role,'developer');
  assert.equal(initial.task.agent_id,'dev-cursor-01');
  assert.equal(initial.task.sha,'a'.repeat(40));
  persist(failedDispatch(state,state.version,initial.id));
  assert.equal(firstPending().id,initial.id);
  assert.equal(firstPending().attempts,1);
  deliver(firstPending());
  const implementation=result('developer','implementation_ready','b'.repeat(40),'a'.repeat(40),
    'dev-cursor-01','.github/workflows/agent-develop.yml','Agent / Development');
  assert.throws(()=>acceptTaskResult(state,state.version,implementation.payload,
    {...implementation.source,verified:false},registry),/untrusted/);
  assert.throws(()=>acceptTaskResult(state,state.version,implementation.payload,
    {...implementation.source,agent_id:'review-cursor-01'},registry),/wrong Agent/);
  assert.throws(()=>acceptTaskResult(state,state.version,
    {...implementation.payload,next_role:'merge'},implementation.source,registry),/invalid task result/);
  assert.throws(()=>acceptTaskResult(state,state.version,
    {...implementation.payload,run_attempt:2},implementation.source,registry),/mismatched source/);
  assert.throws(()=>acceptTaskResult(state,state.version,
    {...implementation.payload,task_id:'0'.repeat(64)},implementation.source,registry),/untrusted|task has not/);
  persist(acceptTaskResult(state,state.version,implementation.payload,implementation.source,registry));
  assert.equal(state.phase,'review');
  assert.equal(state.target_sha,'b'.repeat(40));
  assert.equal(firstPending().task.role,'reviewer');
  assert.throws(()=>acceptTaskResult(state,state.version,implementation.payload,
    implementation.source,registry),/not been dispatched|stale/);

  deliver(firstPending());
  const review=result('reviewer','changes_requested','b'.repeat(40),'b'.repeat(40),
    'review-cursor-01','.github/workflows/agent-review.yml','Agent / Review');
  assert.throws(()=>acceptTaskResult(state,state.version,review.payload,
    {...review.source,path:'.github/workflows/agent-develop.yml'},registry),/untrusted/);
  assert.throws(()=>acceptTaskResult(state,state.version,review.payload,
    {...review.source,input_sha:'d'.repeat(40)},registry),/exact source SHA/);
  persist(acceptTaskResult(state,state.version,review.payload,review.source,registry));
  assert.equal(state.phase,'repair');
  assert.equal(state.repair_attempts,1);
  assert.equal(firstPending().task.resume,true);
  assert.equal(firstPending().task.agent_id,'dev-cursor-01');

  deliver(firstPending());
  const repaired=result('developer','implementation_ready','c'.repeat(40),'b'.repeat(40),
    'dev-cursor-01','.github/workflows/agent-develop.yml','Agent / Development');
  persist(acceptTaskResult(state,state.version,repaired.payload,repaired.source,registry));
  assert.equal(state.phase,'review');
  deliver(firstPending());
  const approved=result('reviewer','approved','c'.repeat(40),'c'.repeat(40),
    'review-cursor-01','.github/workflows/agent-review.yml','Agent / Review');
  persist(acceptTaskResult(state,state.version,approved.payload,approved.source,registry));
  assert.equal(state.phase,'quality');
  assert.equal(firstPending().task.gate,'quality');
  deliver(firstPending());
  const quality=result('quality','passed','c'.repeat(40),'c'.repeat(40),
    null,'.github/workflows/ci-quality.yml','CI / Quality Gate');
  persist(acceptTaskResult(state,state.version,quality.payload,quality.source,registry));
  assert.equal(state.phase,'acceptance');
  assert.equal(firstPending().task.gate,'sc-acceptance');
  assert.equal(firstPending().task.when,'pr');
  deliver(firstPending());
  const acceptance=result('acceptance','passed','c'.repeat(40),'c'.repeat(40),
    null,'.github/workflows/acceptance-orchestrator.yml','Acceptance / Orchestrator');
  persist(acceptTaskResult(state,state.version,acceptance.payload,acceptance.source,registry));
  assert.equal(state.phase,'waiting-merge');
  assert.equal(firstPending().task.type,'notify');
  assert.notEqual(state.phase,'done');
  assert.equal(reconcileOutbox(state).awaiting_evidence.length,0);
  // A merge result is a separate trusted input. It never itself proves
  // post-merge Acceptance and cannot directly close a requirement.
  const merged={kind:'merge',outcome:'completed',issue,run_id:10001,run_attempt:1,
    target_sha:'d'.repeat(40)};
  const next=advanceWorkflow(state,merged,{workflow_run_id:10001,attempt:1,issue,
    source_sha:merged.target_sha,role:'merge'});
  assert.equal(next.state.phase,'post-merge-acceptance');
  assert.equal(next.actions[0].when,'merged');
  assert.equal(next.actions[0].gate,'sc-acceptance');

  assert.throws(()=>writeIssueWorkflowState(folder,{...state,version:state.version+2},
    state.version),/noncontiguous/);
  assert.throws(()=>writeIssueWorkflowState(folder,{...state,version:state.version+1},
    state.version-1),/CAS/);
  const badFile=path.join(folder,issueStatePath(issue,state.version));
  writeFileSync(badFile,'{"schema_version":1,"issue":1696}');
  assert.throws(()=>readIssueWorkflowState(folder,issue),/head target missing|digest mismatch|invalid state/);
} finally {rmSync(folder,{recursive:true,force:true});}

const symlinkDir=mkdtempSync(path.join(os.tmpdir(),'agent-outbox-symlink-'));
try {
  mkdirSync(path.join(symlinkDir,'workflows'));
  symlinkSync(os.tmpdir(),path.join(symlinkDir,'workflows','issues'));
  assert.throws(()=>writeIssueWorkflowState(symlinkDir,
    startDevelopment(registry,request,permission),0),/unsafe directory/);
} finally {rmSync(symlinkDir,{recursive:true,force:true});}
validateDevelopmentState(state);
console.log('agent Issue outbox: durable CAS, trusted result transitions and replay fixtures passed');
