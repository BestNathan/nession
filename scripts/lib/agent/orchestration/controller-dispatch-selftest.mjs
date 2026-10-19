#!/usr/bin/env node
// #2010 main-owned trusted dispatch authority, key separation and fail-closed tests.
import assert from 'node:assert/strict';
import {assertDispatchAuthority,deriveDispatchKey,parseDispatchKey}
  from './controller-dispatch.mjs';

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
