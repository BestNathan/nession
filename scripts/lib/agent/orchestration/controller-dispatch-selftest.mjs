#!/usr/bin/env node
// #2010 main-owned trusted dispatch authority, key separation and fail-closed tests.
import assert from 'node:assert/strict';
import {assertDispatchAuthority,deriveDispatchKey,parseDispatchKey,sourceAllowed,CONTROLLED_DISPATCH_COMMENT,CONTROLLED_RECOVERY_COMMENT,CONTROLLED_NATIVE_RECOVERY_COMMENT,CONTROLLED_REVIEW_RECOVERY_COMMENT,CONTROLLED_REPAIR_BIND_COMMENT,
  CONTROLLED_REPAIR_DISPATCH_COMMENT,CONTROLLED_REPAIR_FAILURE_COMMENT,
  CONTROLLED_REPAIR_RETRY_COMMENT,QWEN_V2_DISPATCH_RE,REVIEW_DISPATCH_RE,
  REPAIR_DISPATCH_RE,assertOwnerQwenRepairDispatchRole,
  REVIEWER_PREMODEL_RECOVERY_COMMENT,
  assertOwnerReviewDispatchRole}
  from './controller-dispatch.mjs';
import {CONTROLLED_ORIGINAL_PUBLICATION} from '../publisher/publication-readback.mjs';
import {SOURCE as QWEN_KEY_FAILURE,
  SOURCE_V2 as QWEN_KEY_FAILURE_V2,
  SOURCE_V3 as QWEN_KEY_FAILURE_V3} from './qwen-preflight-failure.mjs';
import {CONTROLLED_V2_CONTINUATION,CONTROLLED_V2_CONTINUATION_COMMENT} from './development-resume.mjs';

const sha='a'.repeat(40),actionId='b'.repeat(64),issue=1997,runId=12345;
const environment={
  GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'BestNathan/nession',
  GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW:'Agent / Controller Dispatch',
  GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_ACTOR:'BestNathan',
  GITHUB_SHA:sha,GITHUB_RUN_ID:String(runId),GITHUB_RUN_ATTEMPT:'1',
};
const event={repository:{full_name:'BestNathan/nession'},
  ref:'refs/heads/main',inputs:{issue_number:String(issue),action_id:actionId}};
const run={id:runId,run_attempt:1,event:'workflow_dispatch',
  path:'.github/workflows/agent-controller-dispatch.yml',
  name:'Agent / Controller Dispatch',actor:{login:'BestNathan'},
  head_branch:'main',head_sha:sha,
  repository:{full_name:'BestNathan/nession'},
  head_repository:{full_name:'BestNathan/nession'}};
const valid={environment,event,run,issue,actionId};
assert.equal(assertDispatchAuthority(valid).issuer_run_id,runId);
// Workflow input schema now includes a bot-only locator with default "0".
// Existing Owner/manual dispatch must remain valid with the new default.
assert.equal(assertDispatchAuthority({...valid,event:{...event,
  inputs:{...event.inputs,source_publisher_run_id:'0',
    recovery_run_id:'0'}}}).issue,issue);
assert.throws(()=>assertDispatchAuthority({...valid,event:{...event,
  inputs:{...event.inputs,source_publisher_run_id:'43607502468',
    recovery_run_id:'0'}}}),/authenticated owner\/main/);
const botWake={...valid,environment:{...environment,GITHUB_ACTOR:'github-actions[bot]'},
  run:{...run,actor:{login:'github-actions[bot]'}},
  issue:3433,actionId:'c'.repeat(64),
  event:{...event,inputs:{issue_number:'3433',action_id:'c'.repeat(64),
    source_publisher_run_id:'43607502468',recovery_run_id:'0'}}};
const verifiedPublisherWake={issue:3433,action_id:'c'.repeat(64),
  source_publisher_run_id:43607502468,pr_head_sha:'a'.repeat(40)};
assert.equal(assertDispatchAuthority({...botWake,
  publisherWakeProof:verifiedPublisherWake}).issue,3433);
for(const bad of [
  {publisherWakeProof:null},
  {publisherWakeProof:{...verifiedPublisherWake,issue:3434}},
  {publisherWakeProof:{...verifiedPublisherWake,action_id:'d'.repeat(64)}},
  {publisherWakeProof:{...verifiedPublisherWake,source_publisher_run_id:1}},
  {event:{...botWake.event,inputs:{...botWake.event.inputs,recovery_run_id:'1'}}},
  {environment:{...botWake.environment,GITHUB_ACTOR:'untrusted'}},
  {run:{...botWake.run,actor:{login:'BestNathan'}}},
])assert.throws(()=>assertDispatchAuthority({...botWake,...bad}),
  /authenticated owner\/main/);
// Explicit owner/main dispatch mode: normal requests retain the original
// two-input contract. Only the single independently attested failed Qwen
// Run may carry an optional recovery_run_id; no arbitrary Job retry.
const qwenRecovery={...valid,issue:QWEN_KEY_FAILURE.issue,
  actionId:QWEN_KEY_FAILURE.action_id,
  event:{...event,inputs:{
    issue_number:String(QWEN_KEY_FAILURE.issue),
    action_id:QWEN_KEY_FAILURE.action_id,
    recovery_run_id:String(QWEN_KEY_FAILURE.run_id),
  }}};
assert.equal(assertDispatchAuthority(qwenRecovery).issue,2817);
const qwenRecoveryV2={...valid,issue:QWEN_KEY_FAILURE_V2.issue,
  actionId:QWEN_KEY_FAILURE_V2.action_id,
  event:{...event,inputs:{
    issue_number:String(QWEN_KEY_FAILURE_V2.issue),
    action_id:QWEN_KEY_FAILURE_V2.action_id,
    recovery_run_id:String(QWEN_KEY_FAILURE_V2.run_id),
  }}};
assert.equal(assertDispatchAuthority(qwenRecoveryV2).issue,2817);
for(const input of [
  {...qwenRecoveryV2.event.inputs,recovery_run_id:'42339656511'},
  {...qwenRecoveryV2.event.inputs,action_id:QWEN_KEY_FAILURE.action_id},
])assert.throws(()=>assertDispatchAuthority({...qwenRecoveryV2,
  event:{...qwenRecoveryV2.event,inputs:input}}),/authenticated owner\/main/);
const qwenRecoveryV3={...valid,issue:QWEN_KEY_FAILURE_V3.issue,
  actionId:QWEN_KEY_FAILURE_V3.action_id,
  event:{...event,inputs:{
    issue_number:String(QWEN_KEY_FAILURE_V3.issue),
    action_id:QWEN_KEY_FAILURE_V3.action_id,
    recovery_run_id:String(QWEN_KEY_FAILURE_V3.run_id),
  }}};
assert.equal(assertDispatchAuthority(qwenRecoveryV3).issue,2817);
for(const input of [
  {...qwenRecoveryV3.event.inputs,recovery_run_id:'42342792436'},
  {...qwenRecoveryV3.event.inputs,action_id:QWEN_KEY_FAILURE_V2.action_id},
])assert.throws(()=>assertDispatchAuthority({...qwenRecoveryV3,
  event:{...qwenRecoveryV3.event,inputs:input}}),/authenticated owner\/main/);
assert.equal(assertDispatchAuthority({...valid,event:{...event,
  inputs:{...event.inputs,recovery_run_id:'0'}}}).issue,issue);
for(const input of [
  {...qwenRecovery.event.inputs,recovery_run_id:'42187623196'},
  {...qwenRecovery.event.inputs,action_id:'f'.repeat(64)},
  {...qwenRecovery.event.inputs,unexpected:'hello'},
])assert.throws(()=>assertDispatchAuthority({...qwenRecovery,
  event:{...qwenRecovery.event,inputs:input}}),/authenticated owner\/main/);
assert.throws(()=>assertDispatchAuthority({...qwenRecovery,
  environment:{...environment,GITHUB_ACTOR:'untrusted'}}),
  /authenticated owner\/main/);
const commentEnvironment={...environment,GITHUB_EVENT_NAME:'issue_comment'};
const commentEvent={
  action:'created',repository:{full_name:'BestNathan/nession'},
  issue:{number:1997},
  comment:{id:98765,user:{login:'BestNathan'},body:CONTROLLED_DISPATCH_COMMENT},
};
const commentValid={...valid,environment:commentEnvironment,event:commentEvent,
  issue:1997,actionId:'95b467a90a33b503dc19fb59f3a50378860e6e1eaa2961a0929ca97ae020edae',
  run:{...run,event:'issue_comment'}};
assert.equal(assertDispatchAuthority(commentValid).issue,1997);
// Exact owner/main GitHub issue_comment route for the fresh #1974
// producer fixture. The requested Action is still checked against Store
// Outbox by the same canonical dispatch preflight; no free-form dispatch.
const canaryAction='d'.repeat(64);
const canaryComment='/nession qwen-v2-dispatch issue=3001 action='+canaryAction;
assert.equal(QWEN_V2_DISPATCH_RE.exec(canaryComment)?.[1],canaryAction);
const canaryEvent={
  action:'created',repository:{full_name:'BestNathan/nession'},
  issue:{number:3001,state:'open'},
  comment:{id:888001,body:canaryComment,user:{login:'BestNathan'}},
};
const canaryValid={...valid,environment:commentEnvironment,
  event:canaryEvent,issue:3001,actionId:canaryAction,
  run:{...run,event:'issue_comment'}};
assert.equal(assertDispatchAuthority(canaryValid).issue,3001);
for(const change of [
  {event:{...canaryEvent,issue:{number:3002,state:'open'}}},
  {event:{...canaryEvent,issue:{number:3001,state:'closed'}}},
  {event:{...canaryEvent,comment:{...canaryEvent.comment,id:0}}},
  {event:{...canaryEvent,comment:{...canaryEvent.comment,
    user:{login:'external'}}}},
  {event:{...canaryEvent,comment:{...canaryEvent.comment,
    body:canaryComment+' '}}},
  {event:{...canaryEvent,action:'edited'}},
  {event:{...canaryEvent,repository:{full_name:'foreign/repo'}}},
  {issue:1997},
  {actionId:'e'.repeat(64)},
  {environment:{...commentEnvironment,GITHUB_ACTOR:'external'}},
  {environment:{...commentEnvironment,GITHUB_RUN_ATTEMPT:'2'}},
])
  assert.throws(()=>assertDispatchAuthority({...canaryValid,...change}),
    /authenticated owner\/main/);

const actualAction=await import('./outbox.mjs').then(m=>
  m.failedDeveloperRetryActionId(1997,
  '95b467a90a33b503dc19fb59f3a50378860e6e1eaa2961a0929ca97ae020edae',
  39267659650));
const recovery={...commentValid,actionId:actualAction,
  event:{...commentEvent,comment:{...commentEvent.comment,body:CONTROLLED_RECOVERY_COMMENT}}};
assert.equal(assertDispatchAuthority(recovery).action_id,actualAction);
assert.throws(()=>assertDispatchAuthority({...recovery,
  actionId:commentValid.actionId}),/authenticated owner\/main/);
assert.throws(()=>assertDispatchAuthority({...recovery,
  event:{...recovery.event,comment:{...recovery.event.comment,body:CONTROLLED_RECOVERY_COMMENT+' '}}}),/authenticated owner\/main/);

for(const event of [
  {...commentEvent,action:'edited'},
  {...commentEvent,issue:{number:2010}},
  {...commentEvent,issue:{number:1997,pull_request:{url:'https://evil'}}},
  {...commentEvent,comment:{...commentEvent.comment,user:{login:'fork'}}},
  {...commentEvent,comment:{...commentEvent.comment,body:'/nession dispatch issue=1998'}},
])assert.throws(()=>assertDispatchAuthority({...commentValid,event}),/authenticated owner\/main/);
assert.throws(()=>assertDispatchAuthority({...commentValid,
  environment:{...commentEnvironment,GITHUB_ACTOR:'fork'}}),/authenticated owner\/main/);
const continuation={...commentValid,
  actionId:'3f4abb86785d41dbb771edbab1c400841d3d0e60335358332307b75e1d36c1c8',
  event:{...commentEvent,comment:{...commentEvent.comment,body:'/nession resume issue=1997 checkpoint=1'}}};
assert.equal(assertDispatchAuthority(continuation).action_id,continuation.actionId);
const continuationV2={...continuation,actionId:CONTROLLED_V2_CONTINUATION,
  event:{...commentEvent,comment:{...commentEvent.comment,body:CONTROLLED_V2_CONTINUATION_COMMENT}}};
assert.equal(assertDispatchAuthority(continuationV2).action_id,CONTROLLED_V2_CONTINUATION);
for(const bad of [
  {actionId:continuation.actionId},
  {event:{...continuationV2.event,comment:{...continuationV2.event.comment,
    body:'/nession resume issue=1997 checkpoint=3'}}},
  {event:{...continuationV2.event,comment:{...continuationV2.event.comment,
    body:CONTROLLED_V2_CONTINUATION_COMMENT+' '}}},
  {event:{...continuationV2.event,comment:{...continuationV2.event.comment,
    user:{login:'fork'}}}},
  {issue:1998},
])assert.throws(()=>assertDispatchAuthority({...continuationV2,...bad}),
  /authenticated owner\/main/);
for(const patch of [{actionId:actualAction},
  {event:{...continuation.event,comment:{...continuation.event.comment,body:'/nession resume issue=1997 checkpoint=2'}}},
  {event:{...continuation.event,comment:{...continuation.event.comment,user:{login:'fork'}}}},
])assert.throws(()=>assertDispatchAuthority({...continuation,...patch}),/authenticated owner\/main/);
const nativeId=await import('./outbox.mjs').then(m=>m.nativeResumeSuccessorId(1997,
  continuation.actionId,39376331942));
const nativeRecovery={...continuation,actionId:nativeId,
  event:{...continuation.event,comment:{...continuation.event.comment,
    body:CONTROLLED_NATIVE_RECOVERY_COMMENT}}};
assert.equal(assertDispatchAuthority(nativeRecovery).action_id,nativeId);
assert.throws(()=>assertDispatchAuthority({...nativeRecovery,actionId:continuation.actionId}),/authenticated owner\/main/);
assert.throws(()=>assertDispatchAuthority({...nativeRecovery,event:{...nativeRecovery.event,
  comment:{...nativeRecovery.event.comment,body:CONTROLLED_NATIVE_RECOVERY_COMMENT+' '}}}),/authenticated owner\/main/);
// #3550: a missed Publisher wake can be recovered by an exact authenticated
// Owner comment, bound to the existing initialized Store Reviewer Outbox.
// Parsing only a command prefix or a mismatched Issue is never authority.
const currentReviewerAction='66a3bf916ce573adda08135524a2bb6d4db2a0a2125cab0bfdce2664e78614b6';
const currentReviewCommand='/nession dispatch-review issue=3433 action='+currentReviewerAction;
assert.deepEqual(REVIEW_DISPATCH_RE.exec(currentReviewCommand)?.slice(1),
  ['3433',currentReviewerAction]);
const ownerReviewEvent={...commentEvent,
  issue:{number:3433,state:'open'},
  comment:{...commentEvent.comment,body:currentReviewCommand}};
const ownerReview={...commentValid,event:ownerReviewEvent,
  issue:3433,actionId:currentReviewerAction};
assert.equal(assertDispatchAuthority(ownerReview).action_id,currentReviewerAction);
assert.doesNotThrow(()=>assertOwnerReviewDispatchRole(true,'reviewer'));
assert.doesNotThrow(()=>assertOwnerReviewDispatchRole(false,'developer'));
assert.throws(()=>assertOwnerReviewDispatchRole(true,'developer'),
  /non-Reviewer Outbox role/);
for(const change of [
  {issue:1997},
  {actionId:'a'.repeat(64)},
  {event:{...ownerReviewEvent,issue:{number:3434,state:'open'}}},
  {event:{...ownerReviewEvent,issue:{number:3433,state:'closed'}}},
  {event:{...ownerReviewEvent,issue:{number:3433,state:'open',pull_request:{}}}},
  {event:{...ownerReviewEvent,comment:{...ownerReviewEvent.comment,
    body:currentReviewCommand+' '}}},
  {event:{...ownerReviewEvent,comment:{...ownerReviewEvent.comment,
    body:currentReviewCommand.replace('3433','03433')}}},
  {event:{...ownerReviewEvent,comment:{...ownerReviewEvent.comment,
    user:{login:'attacker'}}}},
  {environment:{...commentEnvironment,GITHUB_ACTOR:'attacker'}},
  {environment:{...commentEnvironment,GITHUB_REF:'refs/heads/staging'}},
  {event:{...ownerReviewEvent,action:'edited'}},
])assert.throws(()=>assertDispatchAuthority({...ownerReview,...change}),
  /authenticated owner\/main/);

const premodelRecovery={...ownerReview,
  event:{...ownerReviewEvent,comment:{...ownerReviewEvent.comment,
    body:REVIEWER_PREMODEL_RECOVERY_COMMENT}}};
assert.equal(assertDispatchAuthority(premodelRecovery).issue,3433);
for(const bad of [
  {actionId:'f'.repeat(64)},
  {issue:1997},
  {event:{...premodelRecovery.event,comment:{...premodelRecovery.event.comment,
    body:REVIEWER_PREMODEL_RECOVERY_COMMENT+' '}}},
  {event:{...premodelRecovery.event,comment:{...premodelRecovery.event.comment,
    user:{login:'external'}}}},
  {event:{...premodelRecovery.event,issue:{number:3434,state:'open'}}},
])assert.throws(()=>assertDispatchAuthority({...premodelRecovery,...bad}),
  /authenticated owner\/main/);

const qwenRepairAction='bdba0198ff28b74b8b1acdaaadfb8106d7fcc054a86cfc98c0f9d93b9f70a856';
const qwenRepairComment='/nession dispatch-repair issue=3433 action='+qwenRepairAction;
assert.deepEqual(REPAIR_DISPATCH_RE.exec(qwenRepairComment)?.slice(1),
  ['3433',qwenRepairAction]);
const qwenRepairEvent={...commentEvent,
  issue:{number:3433,state:'open'},
  comment:{...commentEvent.comment,body:qwenRepairComment}};
const qwenRepairValid={...commentValid,issue:3433,actionId:qwenRepairAction,
  event:qwenRepairEvent};
assert.equal(assertDispatchAuthority(qwenRepairValid).action_id,qwenRepairAction);
assert.doesNotThrow(()=>assertOwnerQwenRepairDispatchRole(true,'developer',
  {task:'repair',agent_id:'dev-qwen-01',resume:true}));
for(const task of [
  {task:'implement',agent_id:'dev-qwen-01',resume:true},
  {task:'repair',agent_id:'dev-qwen-01',resume:false},
  {task:'repair',agent_id:'dev-cursor-01',resume:true},
])assert.throws(()=>assertOwnerQwenRepairDispatchRole(true,'developer',task),
  /non-Repair Outbox action/);
assert.throws(()=>assertOwnerQwenRepairDispatchRole(true,'reviewer',
  {task:'review',agent_id:'review-qwen-01',resume:true}),
  /non-Repair Outbox action/);
for(const change of [
  {issue:1997},
  {actionId:'f'.repeat(64)},
  {event:{...qwenRepairEvent,issue:{number:3434,state:'open'}}},
  {event:{...qwenRepairEvent,issue:{number:3433,state:'closed'}}},
  {event:{...qwenRepairEvent,issue:{number:3433,state:'open',pull_request:{}}}},
  {event:{...qwenRepairEvent,action:'edited'}},
  {event:{...qwenRepairEvent,comment:{...qwenRepairEvent.comment,
    body:qwenRepairComment+' '}}},
  {event:{...qwenRepairEvent,comment:{...qwenRepairEvent.comment,
    user:{login:'other'}}}},
  {environment:{...commentEnvironment,GITHUB_ACTOR:'other'}},
])assert.throws(()=>assertDispatchAuthority({...qwenRepairValid,...change}),
  /authenticated owner\/main/);

const reviewRecover={...commentValid,
  actionId:'555b3351ddb8c7ddbc23ba789f8a8a9560a01cc3112834f15492382e13af4434',
  event:{...commentEvent,comment:{...commentEvent.comment,
    body:CONTROLLED_REVIEW_RECOVERY_COMMENT}}};
assert.equal(assertDispatchAuthority(reviewRecover).action_id,reviewRecover.actionId);
for(const patch of [
  {actionId:commentValid.actionId},
  {event:{...reviewRecover.event,comment:{...reviewRecover.event.comment,
    body:CONTROLLED_REVIEW_RECOVERY_COMMENT+' '}}},
  {event:{...reviewRecover.event,comment:{...reviewRecover.event.comment,
    user:{login:'untrusted'}}}},
  {environment:{...commentEnvironment,GITHUB_RUN_ATTEMPT:'2'}},
])assert.throws(()=>assertDispatchAuthority({...reviewRecover,...patch}),
  /authenticated owner\/main/);
const repairRetry='ed14323e0466b23ec739a712ab63bfc16cbbbe225b1118a4cbeab64e419574a5';
for(const command of [CONTROLLED_REPAIR_FAILURE_COMMENT,CONTROLLED_REPAIR_RETRY_COMMENT]){
  const original={...commentValid,actionId:repairRetry,
    event:{...commentValid.event,comment:{...commentValid.event.comment,
      body:command}}};
  assert.equal(assertDispatchAuthority(original).action_id,repairRetry);
  for(const wrong of [
    {...original,actionId:reviewRecover.actionId},
    {...original,event:{...original.event,comment:{...original.event.comment,
      body:command+' '}}},
    {...original,event:{...original.event,comment:{...original.event.comment,
      user:{login:'attacker'}}}},
  ])assert.throws(()=>assertDispatchAuthority(wrong),/authenticated owner\/main/);
}
const denied=[
  {environment:{...environment,GITHUB_REF:'refs/pull/12/merge'}},
  {environment:{...environment,GITHUB_ACTOR:'attacker'}},
  {environment:{...environment,GITHUB_REPOSITORY:'fork/repo'}},
  {environment:{...environment,GITHUB_RUN_ATTEMPT:'2'}},
  {event:{...event,ref:'refs/heads/feature'}},
  {event:{...event,inputs:{...event.inputs,role:'developer'}}},
  {event:{...event,inputs:{...event.inputs,issue_number:'1998'}}},
  {run:{...run,actor:{login:'attacker'}}},
  {run:{...run,head_sha:'c'.repeat(40)}},
  {run:{...run,head_repository:{full_name:'fork/repo'}}},
  {run:{...run,path:'.github/workflows/agent-issue-audit.yml'}},
  {run:{...run,run_attempt:2}},
  {actionId:'c'.repeat(64)},
];
for(const x of denied)assert.throws(
  ()=>assertDispatchAuthority({...valid,...x}),/authenticated owner\/main/);
const pem='-----BEGIN PRIVATE KEY-----\n'+('a'.repeat(256))+'\n-----END PRIVATE KEY-----';
const key=deriveDispatchKey(pem);
const second=deriveDispatchKey(pem),other=deriveDispatchKey(pem+'\n');
assert.equal(key.length,32);
assert.deepEqual(key,second);
assert.notDeepEqual(key,other);
assert.deepEqual(parseDispatchKey(key.toString('base64')),key);
assert.throws(()=>deriveDispatchKey('fake'),/private key/);
assert.throws(()=>parseDispatchKey('fake'),/HMAC|base64/);
// #2262 follow-up: Reviewer actions point at the published PR head, not a main
// ancestor; they must descend from the original published main SHA instead.
const repairAction='d899dfc9367cdc9d98a6dcbcd7e55ce2d962f1d72e54abf0d61b0dd7e308009d';
for(const command of [CONTROLLED_REPAIR_BIND_COMMENT,CONTROLLED_REPAIR_DISPATCH_COMMENT]){
  const repair={...commentValid,actionId:repairAction,
    event:{...commentValid.event,comment:{...commentValid.event.comment,body:command}}};
  assert.equal(assertDispatchAuthority(repair).action_id,repairAction);
  assert.throws(()=>assertDispatchAuthority({...repair,actionId:reviewRecover.actionId}),
    /authenticated owner\/main/);
  assert.throws(()=>assertDispatchAuthority({...repair,
    event:{...repair.event,comment:{...repair.event.comment,body:command+' '}}}),
    /authenticated owner\/main/);
}
const sourceSha='c'.repeat(40),publishedMain=CONTROLLED_ORIGINAL_PUBLICATION.publisher_main_sha;
const calls=[];
const accept=args=>{calls.push(args.join(' '));};
sourceAllowed(sourceSha,'developer',{run:accept,mainSha:'d'.repeat(40)});
assert.ok(calls.includes('merge-base --is-ancestor '+sourceSha+' '+'d'.repeat(40)));
calls.length=0;
sourceAllowed(sourceSha,'reviewer',{run:accept,mainSha:'d'.repeat(40)});
assert.ok(calls.includes('merge-base --is-ancestor '+publishedMain+' '+sourceSha));
const exactRepairSha='3d8e3807cc01f6082734b8d0ba458217c28f60a4';
const repairContext={task:'repair',sha:exactRepairSha,agent_id:'dev-cursor-01',
  repair_checkpoint:{source_sha:'220266b9233ec97b1beacbc54e5cc7f82d3cece2',
    source_run_id:39448549052}};
calls.length=0;
sourceAllowed(exactRepairSha,'developer',{run:accept,task:repairContext});
assert.ok(calls.includes('merge-base --is-ancestor '+publishedMain+' '+exactRepairSha));
assert.throws(()=>sourceAllowed(sourceSha,'developer',{run:accept,task:repairContext}),
  /exact authenticated published PR source/);
assert.throws(()=>sourceAllowed(exactRepairSha,'developer',{run:accept,
  task:{...repairContext,repair_checkpoint:{...repairContext.repair_checkpoint,
    source_run_id:39448549053}}}),/exact authenticated published PR source/);
const denyMerge=args=>{calls.push(args.join(' '));if(args[0]==='merge-base')throw Error('not ancestor');};
assert.throws(()=>sourceAllowed(sourceSha,'developer',{run:denyMerge,mainSha:'d'.repeat(40)}),
  /reachable trusted main ancestor/);
assert.throws(()=>sourceAllowed(sourceSha,'reviewer',{run:denyMerge,mainSha:'d'.repeat(40)}),
  /published branch history/);
assert.throws(()=>sourceAllowed(sourceSha,'acceptor',{run:accept}),/dispatch role/);
assert.throws(()=>sourceAllowed('main','reviewer',{run:accept}),/invalid dispatch source SHA/);
assert.throws(()=>sourceAllowed(sourceSha,'reviewer',{run:args=>{
  if(args[0]==='cat-file')throw Error('missing');}}),/not a commit/);
key.fill(0);
second.fill(0);
other.fill(0);
console.log('Controller dispatch: trusted run binding, fork/retry/role denial, HMAC domain separation passed');

// New signed Qwen Reviewer branch lookup shares the canonical dispatch Gate.
await import('./qwen-reviewer-source-selftest.mjs');
await import('./qwen-preflight-recovery-selftest.mjs');
