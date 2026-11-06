import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import { startDevelopment,recordDispatch,failedDispatch,acceptTaskResult,
  acceptPublisherPublication,reconcileOutbox,validateDevelopmentState,
  recordControlledReviewerRecoveryIntent,bindVerifiedRepairCheckpoint } from './outbox.mjs';
import { readIssueWorkflowState, writeIssueWorkflowState,issueStatePath } from './state-store.mjs';
import { advanceWorkflow } from './transition.mjs';
import {attestCrossPhaseRepairFacts,readPublishedRepairCheckpoint} from './repair-checkpoint.mjs';

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
// #1997 one-shot Reviewer recovery: immutable original skipped Run and
// bounded no-redelivery intent; replay, forged SHA or wrong Action fail closed.
const reviewId='555b3351ddb8c7ddbc23ba789f8a8a9560a01cc3112834f15492382e13af4434';
const reviewSha='3d8e3807cc01f6082734b8d0ba458217c28f60a4';
const legacy={
  schema_version:1,issue:1997,version:19,phase:'review',target_sha:reviewSha,
  repair_attempts:0,transitions:[{kind:'publisher',run_id:39609600546,
    attempt:1,outcome:'published',target_sha:reviewSha}],
  assignments:{developer:'dev-cursor-01',reviewer:'review-qwen-01',
    acceptor:'accept-cursor-01'},
  outbox:[{id:reviewId,task:{type:'dispatch',role:'reviewer',task:'review',
    sha:reviewSha,agent_id:'review-qwen-01'},status:'dispatched',
    attempts:1,receipt:{status:'verified',dispatch_id:reviewId,
      source_run_id:39943178597}}],
};
validateDevelopmentState(legacy);
const recovery={kind:'controlled_review_recovery_intent',
  skipped_run_id:39943178597,issuer_run_id:902,
  ticket_sha256:'a'.repeat(64),source_verified:true};
const fenced=recordControlledReviewerRecoveryIntent(legacy,19,reviewId,recovery);
assert.equal(fenced.version,20);
assert.equal(fenced.outbox[0].receipt.source_run_id,39943178597);
assert.equal(fenced.outbox[0].receipt.reviewer_recovery.ticket_sha256,
  recovery.ticket_sha256);
assert.equal(validateDevelopmentState(fenced),fenced);
assert.throws(()=>recordControlledReviewerRecoveryIntent(fenced,20,reviewId,
  recovery),/historical Reviewer recovery target has changed/);
assert.throws(()=>recordControlledReviewerRecoveryIntent(legacy,19,
  'f'.repeat(64),recovery),/historical Reviewer recovery target has changed/);
assert.throws(()=>recordControlledReviewerRecoveryIntent(legacy,19,reviewId,
  {...recovery,source_verified:false}),/unverified historical/);
assert.throws(()=>recordControlledReviewerRecoveryIntent({...legacy,
  target_sha:'b'.repeat(40)},19,reviewId,recovery),/target has changed/);
assert.throws(()=>validateDevelopmentState({...fenced,outbox:[{...fenced.outbox[0],
  receipt:{...fenced.outbox[0].receipt,reviewer_recovery:{
    ...fenced.outbox[0].receipt.reviewer_recovery,ticket_sha256:'bad'}}}]}),
  /unbound controlled Reviewer recovery/);
// #1997 real v22 Review→Repair history was published AFTER the Developer
// Slice chain was pruned. A new task cannot pretend to have a yielded parent.
const repairAction='d899dfc9367cdc9d98a6dcbcd7e55ce2d962f1d72e54abf0d61b0dd7e308009d';
const publishedSha='3d8e3807cc01f6082734b8d0ba458217c28f60a4';
const oldSource='220266b9233ec97b1beacbc54e5cc7f82d3cece2';
const preRepair={
  schema_version:1,issue:1997,version:22,phase:'repair',target_sha:publishedSha,
  repair_attempts:1,
  transitions:[
    {kind:'publisher',run_id:39609600546,attempt:1,
      target_sha:publishedSha,outcome:'published'},
    {kind:'reviewer',run_id:41962609841,attempt:1,
      target_sha:publishedSha,outcome:'changes_requested'}],
  assignments:{developer:'dev-cursor-01',reviewer:'review-qwen-01',
    acceptor:'accept-cursor-01'},
  outbox:[{id:repairAction,task:{type:'dispatch',role:'developer',
    task:'repair',sha:publishedSha,resume:true,agent_id:'dev-cursor-01'},
    status:'pending',attempts:0,receipt:null}],
};
validateDevelopmentState(preRepair);
const repairProof={verified:true,checkpoint_version:3,
  checkpoint_commit_sha:'eb891ee2154d02ddb758d50f0f694e70a343ffdf',
  ciphertext_sha256:'7afed3f229d371b850fda3fcc77fb0f601f2c588ccab6210d878b2f7501321a0',
  source_sha:oldSource,source_run_id:39448549052};
const boundRepair=bindVerifiedRepairCheckpoint(preRepair,22,repairAction,repairProof);
assert.equal(boundRepair.version,23);
assert.equal(boundRepair.phase,'repair');
assert.equal(boundRepair.outbox[0].id,repairAction);
assert.equal(boundRepair.outbox[0].status,'pending');
assert.equal(boundRepair.outbox[0].task.repair_checkpoint.source_sha,oldSource);
assert.equal(boundRepair.outbox[0].task.sha,publishedSha);
assert.deepEqual(bindVerifiedRepairCheckpoint(boundRepair,23,repairAction,repairProof),boundRepair);
assert.equal(preRepair.version,22);
assert.equal(preRepair.outbox[0].task.repair_checkpoint,undefined);
for(const altered of [
  {...repairProof,verified:false},
  {...repairProof,source_sha:publishedSha},
  {...repairProof,source_run_id:0},
  {...repairProof,checkpoint_version:0},
  {...repairProof,ciphertext_sha256:'bad'},
  {...repairProof,checkpoint_commit_sha:'bad'},
  {...repairProof,extra:true},
])assert.throws(()=>bindVerifiedRepairCheckpoint(preRepair,22,repairAction,altered));
for(const altered of [
  {...preRepair,phase:'quality'},
  {...preRepair,outbox:[{...preRepair.outbox[0],status:'dispatching'}]},
  {...preRepair,outbox:[...preRepair.outbox,preRepair.outbox[0]]},
])assert.throws(()=>bindVerifiedRepairCheckpoint(altered,22,repairAction,repairProof));
assert.throws(()=>bindVerifiedRepairCheckpoint(preRepair,23,repairAction,repairProof),/stale/);
assert.throws(()=>bindVerifiedRepairCheckpoint(boundRepair,23,repairAction,
  {...repairProof,source_run_id:39448549053}),/conflicting Repair checkpoint origin/);
for(const bad of [
  {task:{...boundRepair.outbox[0].task,repair_checkpoint:{
    ...boundRepair.outbox[0].task.repair_checkpoint,source_sha:publishedSha}}},
  {task:{...boundRepair.outbox[0].task,repair_checkpoint:{
    ...boundRepair.outbox[0].task.repair_checkpoint,source_run_id:0}}},
  {task:{...boundRepair.outbox[0].task,task:'implement'}},
]){
  assert.throws(()=>validateDevelopmentState({...boundRepair,
    outbox:[{...boundRepair.outbox[0],...bad}]}),
    /invalid cross-phase Repair checkpoint/);
}
// The trusted source reader must correlate the actual historical yielded
// Worker, checkpoint head, encrypted object, and immutable Run record.
const historicalYield={
  schema_version:1,issue:1997,version:16,phase:'ready',target_sha:null,
  repair_attempts:0,transitions:[],
  assignments:preRepair.assignments,
  outbox:[{id:'dac10d570c30557fe629b8605ecb44d33335eb967e24a52931467ac7b93b5e31',
    task:{type:'dispatch',role:'developer',task:'implement',
      sha:oldSource,agent_id:'dev-cursor-01'},
    status:'yielded',attempts:1,receipt:{
      status:'yielded',dispatch_id:'dac10d570c30557fe629b8605ecb44d33335eb967e24a52931467ac7b93b5e31',
      source_run_id:39448549052,source_attempt:1,
      checkpoint_version:3,
      checkpoint_commit_sha:repairProof.checkpoint_commit_sha,
      ciphertext_sha256:repairProof.ciphertext_sha256}}],
};
const path3='roles/developer/dev-cursor-01/issues/1997/checkpoints/00000003.json';
const checkpointHead={version:3,checkpoint_path:path3,
  ciphertext_sha256:repairProof.ciphertext_sha256};
const cp={schema_version:1,kind:'encrypted_agent_checkpoint',
  path:path3,identity:{role:'developer',agent_id:'dev-cursor-01',issue:1997},
  version:3,metadata:{provider:'cursor',source_sha:oldSource,
    session_id:'agent-7d5b4a61-1476-4ce7-a38a-82907aa3b1a6',
    harness_digest:'b'.repeat(64)},
  ciphertext_sha256:repairProof.ciphertext_sha256};
const sourceRun={schema_version:1,kind:'agent_checkpoint_run',
  role:'developer',agent_id:'dev-cursor-01',issue:1997,run_id:39448549052,
  attempt:1,version:3,source_sha:oldSource,
  workflow:'.github/workflows/agent-develop.yml',
  workflow_sha:'a'.repeat(40),checkpoint_path:path3,
  ciphertext_sha256:repairProof.ciphertext_sha256,
  harness_digest:cp.metadata.harness_digest};
const facts={current:preRepair,historical:historicalYield,
  head:checkpointHead,checkpoint:cp,run:sourceRun,
  checkpointCommitSha:repairProof.checkpoint_commit_sha,actionId:repairAction};
assert.deepEqual(attestCrossPhaseRepairFacts(facts),repairProof);
for(const bad of [
  {historical:{...historicalYield,outbox:[]}},
  {historical:{...historicalYield,outbox:[{...historicalYield.outbox[0],
    receipt:{...historicalYield.outbox[0].receipt,source_run_id:39448549053}}]}},
  {head:{...checkpointHead,version:2}},
  {checkpoint:{...cp,metadata:{...cp.metadata,source_sha:publishedSha}}},
  {checkpoint:{...cp,metadata:{...cp.metadata,provider:'unknown'}}},
  {run:{...sourceRun,source_sha:publishedSha}},
  {run:{...sourceRun,run_id:999}},
  {current:{...preRepair,transitions:[preRepair.transitions[0]]}},
  {checkpointCommitSha:'f'.repeat(40)},
])assert.throws(()=>attestCrossPhaseRepairFacts({...facts,...bad}),
  /trusted Repair checkpoint/);
// A real local Git object, not just a caller flag, owns the checkpoint
// creation commit and exact blob bytes in the production Store reader.
const repairStore=mkdtempSync(path.join(os.tmpdir(),'nession-repair-origin-git-'));
const g=(...args)=>execFileSync('git',['-C',repairStore,...args],{
  encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000}).trim();
try {
  g('init','-q','-b','agent-store');
  g('config','user.name','Repair Origin Fixture');
  g('config','user.email','repair@example.invalid');
  const absolute=relative=>path.join(repairStore,relative);
  const save=(relative,doc)=>{
    mkdirSync(path.dirname(absolute(relative)),{recursive:true});
    writeFileSync(absolute(relative),JSON.stringify(doc)+'\n');
  };
  save(path3,cp);
  g('add','-A');g('commit','-qm','immutable v3 checkpoint');
  const actualCommit=g('rev-parse','HEAD');
  const hist={...historicalYield,outbox:[{...historicalYield.outbox[0],
    receipt:{...historicalYield.outbox[0].receipt,
      checkpoint_commit_sha:actualCommit}}]};
  save(issueStatePath(1997,16),hist);
  save('roles/developer/dev-cursor-01/issues/1997/head.json',checkpointHead);
  save('roles/developer/dev-cursor-01/issues/1997/runs/39448549052-1.json',sourceRun);
  g('add','-A');g('commit','-qm','independent audited source records');
  const found=readPublishedRepairCheckpoint(repairStore,preRepair,repairAction);
  assert.deepEqual(found,{...repairProof,checkpoint_commit_sha:actualCommit});
  writeFileSync(absolute(path3),JSON.stringify({...cp,unexpected:true})+'\n');
  assert.throws(()=>readPublishedRepairCheckpoint(repairStore,preRepair,repairAction),
    /checkpoint bytes differ from original commit/);
}finally{rmSync(repairStore,{recursive:true,force:true});}
validateDevelopmentState(state);
console.log('agent Issue outbox: durable CAS, trusted result transitions and replay fixtures passed');
