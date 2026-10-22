#!/usr/bin/env node
// #2010 deterministic attested Worker claim / HMAC / fork / replay boundary.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {startDevelopment,recordDispatch,recordSliceYield} from './outbox.mjs';
import {planGitHubDispatch} from './github-dispatch.mjs';
import {createWorkerClaim} from './worker-claim.mjs';
import {authenticateWorkerClaimRun,inspectWorkerClaimZip,verifyWorkerClaimForAck,
  eligiblePreflightRerun}
  from './worker-reconcile.mjs';

const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const issue=1997,sha='a'.repeat(40),mainSha='f'.repeat(40),
  now=Date.parse('2026-10-19T12:00:00Z'),key=Buffer.alloc(32,0x35);
const state=startDevelopment(registry,{
  issue,sha,developer:'dev-cursor-01',
  reviewer:'review-cursor-01',acceptor:'accept-cursor-01',
},{repository:'BestNathan/nession',event:'workflow_dispatch',
  permission:'write',ref:'refs/heads/main',run_id:9001});
const action=state.outbox[0];
const inputs=planGitHubDispatch(state,action.id,registry,{
  key,key_id:'main-controller',issuer_run_id:9001,now,ttl_ms:600000,
}).inputs;
const context={repository:'BestNathan/nession',ref:'refs/heads/main',
  event:'workflow_dispatch',workflow:'Agent / Development',
  actor:'github-actions[bot]',head_sha:mainSha,run_id:22022,attempt:1};
const claim=createWorkerClaim(inputs,context);
assert.equal(claim.source.run_id,22022);
assert.equal(claim.inputs.action_id,action.id);
assert.throws(()=>createWorkerClaim({...inputs,role:'reviewer'},context),/claim identity/);
assert.throws(()=>createWorkerClaim(inputs,{...context,actor:'fork-user'}),/claim identity/);
const run={id:22022,run_attempt:1,
  path:'.github/workflows/agent-develop.yml',name:'Agent / Development',
  event:'workflow_dispatch',head_branch:'main',head_sha:mainSha,
  actor:{login:'github-actions[bot]'},repository:{full_name:'BestNathan/nession'},
  head_repository:{full_name:'BestNathan/nession'},
  status:'completed',conclusion:'failure',
  created_at:new Date(now+1500).toISOString()};
const artifacts={artifacts:[{
  id:42,name:'development-worker-claim-22022-1',expired:false,
  digest:'sha256:'+'b'.repeat(64),size_in_bytes:1234,
  workflow_run:{id:22022,head_sha:mainSha},
}]};
assert.equal(authenticateWorkerClaimRun(run,artifacts).artifact_id,42);
for(const bad of [
  {...run,head_repository:{full_name:'attacker/fork'}},
  {...run,actor:{login:'attacker'}},
  {...run,path:'.github/workflows/agent-review.yml'},
  {...run,run_attempt:2},
  {...run,conclusion:'cancelled'},
])assert.throws(()=>authenticateWorkerClaimRun(bad,artifacts),/untrusted|Artifact/);
assert.throws(()=>authenticateWorkerClaimRun(run,{artifacts:[
  ...artifacts.artifacts,...artifacts.artifacts]}),/Artifact/);
assert.throws(()=>inspectWorkerClaimZip(Buffer.from('invalid'),
  'sha256:'+'0'.repeat(64),run),/digest/);
const issuer={id:9001,run_attempt:1,path:'.github/workflows/agent-controller-dispatch.yml',
  name:'Agent / Controller Dispatch',event:'workflow_dispatch',head_branch:'main',
  actor:{login:'BestNathan'},repository:{full_name:'BestNathan/nession'},
  head_repository:{full_name:'BestNathan/nession'},head_sha:mainSha};
const reader={getRun:async()=>issuer};
const valid={run,claim,key,reader};
const verified=await verifyWorkerClaimForAck(valid);
assert.equal(verified.ticket_sha256.length,64);
assert.equal(verified.source_run_id,run.id);
assert.equal(verified.action_id,action.id);
await assert.rejects(()=>verifyWorkerClaimForAck({...valid,key:Buffer.alloc(32,0x36)}),/HMAC/);
await assert.rejects(()=>verifyWorkerClaimForAck({...valid,reader:{
  getRun:async()=>({...issuer,head_sha:'0'.repeat(40)})}}),/issuer/);
await assert.rejects(()=>verifyWorkerClaimForAck({...valid,reader:{
  getRun:async()=>({...issuer,actor:{login:'other'}})}}),/issuer/);
await assert.rejects(()=>verifyWorkerClaimForAck({...valid,run:{
  ...run,created_at:new Date(now+1000000).toISOString()}}),/window/);
await assert.rejects(()=>verifyWorkerClaimForAck({...valid,claim:{
  ...claim,inputs:{...claim.inputs,agent_id:'dev-qwen-01'}}}),/claim/);
const failed={...run,conclusion:'failure',run_attempt:1};
const gateName='Require exact authenticated Run ID from immutable Store receipt';
const claimName='Upload Worker claim for independent HMAC and Store reconciliation';
const modelName='Execute authenticated bounded real Developer slice';
const beforeModel={total_count:1,jobs:[{run_id:run.id,name:'developer',
  status:'completed',conclusion:'failure',steps:[
    {name:claimName,conclusion:'success'},
    {name:gateName,conclusion:'failure'},
    {name:modelName,conclusion:'skipped'},
  ]}]};
assert.equal(eligiblePreflightRerun(failed,beforeModel),true);
for(const bad of [
  {run:{...failed,run_attempt:2}},
  {run:{...failed,conclusion:'success'}},
  {jobs:{...beforeModel,total_count:2}},
  {jobs:{jobs:[{...beforeModel.jobs[0],name:'unexpected'}],total_count:1}},
  {jobs:{jobs:[{...beforeModel.jobs[0],steps:[
    {name:claimName,conclusion:'success'},
    {name:gateName,conclusion:'failure'},
    {name:modelName,conclusion:'success'},
  ]}],total_count:1}},
  {jobs:{jobs:[{...beforeModel.jobs[0],steps:[
    {name:claimName,conclusion:'success'},
    {name:gateName,conclusion:'success'},
    {name:modelName,conclusion:'failure'},
  ]}],total_count:1}},
])assert.equal(eligiblePreflightRerun(bad.run??failed,bad.jobs??beforeModel),false);
console.log('Worker reconciliation: signed claim, original issuer, unique Run, fork and tamper denial passed');

const delivered=recordDispatch(state,state.version,action.id,
  {status:'verified',dispatch_id:action.id,source_run_id:run.id});
const yielded=recordSliceYield(delivered,delivered.version,action.id,
  {version:1,commit_sha:'c'.repeat(40),ciphertext_sha256:'d'.repeat(64)},
  {verified:true,repository:'BestNathan/nession',workflow_path:run.path,workflow_name:run.name,
    role:'developer',agent_id:'dev-cursor-01',issue,run_id:run.id,attempt:1,
    action_id:action.id,input_sha:sha});
const next=yielded.outbox.find(a=>a.status==='pending');
const nativePlan=planGitHubDispatch(yielded,next.id,registry,
  {key,key_id:'main-controller',issuer_run_id:9001,now,ttl_ms:600000});
const nativeClaim=createWorkerClaim(nativePlan.inputs,{...context,run_id:22023});
const nativeValid={...valid,run:{...run,id:22023},claim:nativeClaim};
assert.equal((await verifyWorkerClaimForAck(nativeValid)).source_run_id,22023);
await assert.rejects(()=>verifyWorkerClaimForAck({...nativeValid,claim:{...nativeClaim,
  inputs:{...nativeClaim.inputs,resume_from:'e30'}}}),/claim/);
console.log('Worker reconciliation rejects native resume input that differs from its HMAC-signed commitment');
