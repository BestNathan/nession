#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {startDevelopment,recordDispatch,recordAttestedDeveloperFailure,
  failedDeveloperRetryActionId,reconcileOutbox,validateDevelopmentState}
  from './outbox.mjs';
const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const run=39267659650;
const base=startDevelopment(registry,{
  issue:1997,sha:'220266b9233ec97b1beacbc54e5cc7f82d3cece2',
  developer:'dev-cursor-01',reviewer:'review-cursor-01',acceptor:'accept-cursor-01'
},{repository:'BestNathan/nession',event:'workflow_dispatch',
  permission:'write',ref:'refs/heads/main',run_id:39267610213});
const action=base.outbox[0].id;
const dispatched=recordDispatch(base,base.version,action,{
  status:'verified',dispatch_id:action,source_run_id:run,
});
const evidence={verified:true,issue:1997,run_id:run,
  attempt:1,failure_code:'native_sdk_sandbox_unavailable'};
const next=recordAttestedDeveloperFailure(dispatched,dispatched.version,action,evidence);
const fresh=failedDeveloperRetryActionId(1997,action,run);
assert.equal(next.version,dispatched.version+1);
assert.equal(next.outbox.length,2);
assert.equal(next.outbox[0].status,'failed');
assert.equal(next.outbox[0].receipt.source_run_id,run);
assert.equal(next.outbox[1].id,fresh);
assert.equal(next.outbox[1].status,'pending');
assert.deepEqual(next.outbox[1].task,dispatched.outbox[0].task);
assert.equal(reconcileOutbox(next).failed.length,1);
assert.equal(reconcileOutbox(next).pending.length,1);
assert.deepEqual(validateDevelopmentState(next),next);
for(const changed of [
  {...evidence,run_id:run+1},
  {...evidence,verified:false},
  {...evidence,issue:1998},
  {...evidence,attempt:2},
  {...evidence,failure_code:'http_204'},
  {...evidence,failure_code:'worker_timeout'},
  {...evidence,failure_code:'unknown'},
  {...evidence,role:'reviewer'},
])assert.throws(()=>recordAttestedDeveloperFailure(
  dispatched,dispatched.version,action,changed),/failure|source/);
assert.throws(()=>recordAttestedDeveloperFailure(
  dispatched,0,action,evidence),/stale/);
assert.throws(()=>recordAttestedDeveloperFailure(
  next,next.version,action,evidence),/failure recovery/);
assert.throws(()=>recordAttestedDeveloperFailure(
  base,base.version,action,evidence),/failure recovery/);
assert.throws(()=>failedDeveloperRetryActionId(1997,action,0),/identity/);
assert.throws(()=>validateDevelopmentState({...next,outbox:[
  {...next.outbox[0],receipt:{...next.outbox[0].receipt,
    failure_code:'unknown'}},next.outbox[1],
]}),/failure/);
console.log('Failed Worker: unique next Action ID, old immutable Run, CAS, duplicate, unknown/204 and forged evidence denial passed');
