import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDevelopment,recordDispatch,failedDispatch,acceptTaskResult,
  acceptPublisherPublication,reconcileOutbox,validateDevelopmentState } from './outbox.mjs';
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

// #2252: a trusted publication retires the real #1997 v16 Developer proposal
// chain (including the ordinal-3 resume #2137 forbids re-dispatching) and
// enqueues exactly one Reviewer action bound to the published PR head.
{
  const fixture=JSON.parse(readFileSync(
    'scripts/lib/agent/publisher/fixtures/1997-v16-state.json','utf8'));
  const prHead='3d8e3807cc01f6082734b8d0ba458217c28f60a4';
  const published={kind:'publisher',outcome:'published',issue:1997,
    run_id:39609600546,run_attempt:1,target_sha:prHead};
  const trusted={workflow_run_id:39609600546,attempt:1,issue:1997,
    source_sha:prHead,role:'publisher'};
  assert.equal(fixture.version,16);
  assert.equal(fixture.phase,'ready');
  const live=reconcileOutbox(fixture).pending;
  assert.equal(live.length,1);
  assert.ok(live[0].id.startsWith('fea8efa4'));
  assert.throws(()=>acceptPublisherPublication(fixture,17,published,trusted,registry),
    /stale state CAS/);
  assert.throws(()=>acceptPublisherPublication(fixture,16,
    {...published,next_role:'developer'},trusted,registry),/model cannot/);
  assert.throws(()=>acceptPublisherPublication(fixture,16,published,
    {...trusted,role:'developer'},registry),/authenticated publication/);
  assert.throws(()=>acceptPublisherPublication(fixture,16,published,
    {...trusted,source_sha:'f'.repeat(40)},registry),/authenticated publication|untrusted source provenance/);
  const handed=acceptPublisherPublication(fixture,16,published,trusted,registry);
  assert.equal(handed.version,17);
  assert.equal(handed.phase,'review');
  assert.equal(handed.target_sha,prHead);
  assert.equal(handed.outbox.some(x=>x.id.startsWith('fea8efa4')),false);
  const pending=reconcileOutbox(handed).pending;
  assert.equal(pending.length,1);
  assert.equal(pending[0].task.role,'reviewer');
  assert.equal(pending[0].task.task,'review');
  assert.equal(pending[0].task.sha,prHead);
  assert.equal(pending[0].task.agent_id,fixture.assignments.reviewer);
  // The failed historical run that is independent of the superseded chain
  // remains live for audit; the chain's yielded ancestors and attested failed
  // sibling are retired with it (immutable prior state versions keep them).
  assert.equal(handed.outbox.some(x=>x.id.startsWith('95b467a9')),true);
  assert.equal(handed.outbox.some(x=>x.id.startsWith('3f4abb86')),false);
  assert.equal(acceptPublisherPublication(handed,handed.version,published,trusted,registry),handed);
  assert.throws(()=>acceptPublisherPublication(handed,handed.version,
    {...published,target_sha:'f'.repeat(40)},{...trusted,source_sha:'f'.repeat(40)},registry),
    /conflicting publication replay/);
  assert.throws(()=>acceptPublisherPublication(handed,handed.version,
    {...published,run_id:39609600547,target_sha:'f'.repeat(40)},
    {...trusted,workflow_run_id:39609600547,source_sha:'f'.repeat(40)},registry),
    /ready proposal phase/);
  const unknownReviewer={...fixture,assignments:{...fixture.assignments,reviewer:'review-ghost-01'}};
  assert.throws(()=>acceptPublisherPublication(unknownReviewer,16,published,trusted,registry),
    /role or ID is not registered/);
  const inFlight=recordDispatch(fixture,16,live[0].id,{status:'accepted',dispatch_id:live[0].id});
  assert.throws(()=>acceptPublisherPublication(inFlight,inFlight.version,published,trusted,registry),
    /in-flight dispatch/);
  const ambiguous={...fixture,outbox:[...fixture.outbox,{id:'2'.repeat(64),
    task:{type:'dispatch',role:'developer',task:'implement',sha:'a'.repeat(40),
      agent_id:'dev-cursor-01'},status:'pending',attempts:0,receipt:null}]};
  assert.throws(()=>acceptPublisherPublication(ambiguous,16,published,trusted,registry),
    /exactly one pending Developer proposal/);
  // #2262: an owner-authorized override binds a different registered Reviewer,
  // and the queued action targets that identity; identity negatives fail closed.
  const overridden=acceptPublisherPublication(fixture,16,
    {...published,reviewer_agent_id:'review-qwen-01'},trusted,registry);
  assert.equal(overridden.assignments.reviewer,'review-qwen-01');
  assert.equal(overridden.transitions.find(x=>x.kind==='publisher').reviewer_agent_id,
    'review-qwen-01');
  const boundPending=reconcileOutbox(overridden).pending;
  assert.equal(boundPending.length,1);
  assert.equal(boundPending[0].task.agent_id,'review-qwen-01');
  assert.equal(acceptPublisherPublication(overridden,overridden.version,
    {...published,reviewer_agent_id:'review-qwen-01'},trusted,registry),overridden);
  for(const [reviewerAgentId,matcher] of [
    ['review-ghost-01',/not a registered reviewer/],
    ['dev-cursor-01',/not a registered reviewer/],
    ['review-cursor-01',/already assigned/],
  ]) assert.throws(()=>acceptPublisherPublication(fixture,16,
    {...published,reviewer_agent_id:reviewerAgentId},trusted,registry),matcher);
  assert.throws(()=>acceptPublisherPublication(overridden,overridden.version,
    published,trusted,registry),/conflicting publication replay/);
}

const symlinkDir=mkdtempSync(path.join(os.tmpdir(),'agent-outbox-symlink-'));
try {
  mkdirSync(path.join(symlinkDir,'workflows'));
  symlinkSync(os.tmpdir(),path.join(symlinkDir,'workflows','issues'));
  assert.throws(()=>writeIssueWorkflowState(symlinkDir,
    startDevelopment(registry,request,permission),0),/unsafe directory/);
} finally {rmSync(symlinkDir,{recursive:true,force:true});}
validateDevelopmentState(state);
console.log('agent Issue outbox: durable CAS, trusted result transitions and replay fixtures passed');
