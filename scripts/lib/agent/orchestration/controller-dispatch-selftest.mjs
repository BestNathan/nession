#!/usr/bin/env node
// #2010 main-owned trusted dispatch authority, key separation and fail-closed tests.
import assert from 'node:assert/strict';
import {assertDispatchAuthority,deriveDispatchKey,parseDispatchKey,CONTROLLED_DISPATCH_COMMENT,CONTROLLED_RECOVERY_COMMENT,CONTROLLED_NATIVE_RECOVERY_COMMENT}
  from './controller-dispatch.mjs';
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
  /authenticated owner\\/main/);
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
key.fill(0);
second.fill(0);
other.fill(0);
console.log('Controller dispatch: trusted run binding, fork/retry/role denial, HMAC domain separation passed');
