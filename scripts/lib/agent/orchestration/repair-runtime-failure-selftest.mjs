#!/usr/bin/env node
import assert from 'node:assert/strict';
import {verifyControlledRepairRuntimeFailure} from './repair-runtime-failure.mjs';
import {validateDevelopmentState,recordAttestedRepairRuntimeFailure,
  repairRuntimeSuccessorId} from './outbox.mjs';

const oldAction='d899dfc9367cdc9d98a6dcbcd7e55ce2d962f1d72e54abf0d61b0dd7e308009d';
const sha='3d8e3807cc01f6082734b8d0ba458217c28f60a4';
const sourceRun=42020432271;
const successor='ed14323e0466b23ec739a712ab63bfc16cbbbe225b1118a4cbeab64e419574a5';
const origin={checkpoint_version:3,
  checkpoint_commit_sha:'eb891ee2154d02ddb758d50f0f694e70a343ffdf',
  ciphertext_sha256:'7afed3f229d371b850fda3fcc77fb0f601f2c588ccab6210d878b2f7501321a0',
  source_sha:'220266b9233ec97b1beacbc54e5cc7f82d3cece2',source_run_id:39448549052};
const state={schema_version:1,issue:1997,version:25,phase:'repair',
  target_sha:sha,repair_attempts:1,
  transitions:[
    {key:'publisher:39609600546:1',kind:'publisher',run_id:39609600546,
      attempt:1,target_sha:sha,outcome:'published'},
    {key:'reviewer:41962609841:1',kind:'reviewer',run_id:41962609841,
      attempt:1,target_sha:sha,outcome:'changes_requested'},
  ],assignments:{developer:'dev-cursor-01',reviewer:'review-qwen-01',
    acceptor:'accept-cursor-01'},
  outbox:[{id:oldAction,task:{type:'dispatch',role:'developer',
    task:'repair',sha,agent_id:'dev-cursor-01',resume:true,
    repair_checkpoint:origin},status:'dispatched',attempts:1,
    receipt:{status:'verified',dispatch_id:oldAction,source_run_id:sourceRun}}],
};
validateDevelopmentState(state);
const step=(name,conclusion)=>({name,conclusion});
const job=(name,id,conclusion,steps)=>({
  name,id,run_id:sourceRun,run_attempt:1,status:'completed',conclusion,steps});
const run={id:sourceRun,run_attempt:1,
  head_sha:'d0dfdfe98e2d61bd37b5c64bf1d4bed19a3dfa40',
  head_branch:'main',path:'.github/workflows/agent-develop.yml',
  name:'Agent / Development',event:'workflow_dispatch',
  status:'completed',conclusion:'failure',actor:{login:'github-actions[bot]'},
  repository:{full_name:'BestNathan/nession'},
  head_repository:{full_name:'BestNathan/nession'}};
const jobs={total_count:3,jobs:[
  job('claim',127221529476,'success',[
    step('Publish non-authoritative Worker Run claim before any model call','success'),
    step('Upload Worker claim for independent HMAC and Store reconciliation','success')]),
  job('restore',127221604872,'success',[
    step('Authenticate exact resumed Run from the committed Store','success'),
    step('Rewrap committed native checkpoint in trusted isolated process','success'),
    step('Upload encrypted native transfer for the same admitted Run','success')]),
  job('developer',127221738966,'failure',[
    step('Require exact authenticated Run ID from immutable Store receipt','success'),
    step('Derive only the public RSA sealing key in isolated pre-model step','success'),
    step('Require pinned Cursor Provider and public-only Session sealing key','success'),
    step('Download only same-Run trusted encrypted native transfer','success'),
    step('Restore native bytes and synchronize live Issue before model','success'),
    step('Stage only the exact authenticated published PR Git tree for Repair','success'),
    step('Execute real Developer in isolated Docker with no host credentials','failure'),
    step('Upload canonical immutable Agent telemetry','skipped'),
    step('Upload only encrypted native Session and bounded sanitized result','skipped')]),
]};
const artifacts={total_count:2,artifacts:[
  {name:'development-worker-claim-42020432271-1',
   digest:'sha256:4529b6b0271bdd78844b306dd3fd602258838387972c2ade7530c4fdd6285492',
   expired:false,workflow_run:{id:sourceRun,head_sha:run.head_sha}},
  {name:'development-native-transfer-42020432271-1',
   digest:'sha256:32c7fcf77fd27c57fbfdcfcd72ecf70552b7f2690e04328dcbf0aee503d0f167',
   expired:false,workflow_run:{id:sourceRun,head_sha:run.head_sha}},
]};
const log='2026-11-05T11:38:23.4845487Z Error initializing ignore mapping for .gitignore: Error: Ripgrep path not configured. Call configureRipgrepPath() at startup.\n'+
  '2026-11-05T11:38:23.9381506Z ##[error]bounded Developer: real native read/edit Provider outcome missing\n';
const proof=verifyControlledRepairRuntimeFailure(run,jobs,artifacts,log);
assert.deepEqual(proof,{verified:true,issue:1997,run_id:sourceRun,attempt:1,
  failure_code:'cursor_native_read_missing_uncommitted'});
assert.equal(repairRuntimeSuccessorId(1997,oldAction,sourceRun),successor);
const updated=recordAttestedRepairRuntimeFailure(state,25,oldAction,proof);
assert.equal(updated.version,26);
assert.equal(updated.phase,'repair');
assert.equal(updated.outbox.length,2);
assert.equal(updated.outbox[0].status,'failed');
assert.equal(updated.outbox[0].receipt.source_run_id,sourceRun);
assert.equal(updated.outbox[1].id,successor);
assert.equal(updated.outbox[1].status,'pending');
assert.deepEqual(updated.outbox[1].task,state.outbox[0].task);
assert.equal(state.outbox[0].status,'dispatched');
assert.throws(()=>recordAttestedRepairRuntimeFailure(updated,26,oldAction,proof));
assert.throws(()=>recordAttestedRepairRuntimeFailure(state,24,oldAction,proof));
for(const bad of [
  {...proof,verified:false},{...proof,run_id:sourceRun+1},
  {...proof,failure_code:'native_sdk_sandbox_unavailable'},
])assert.throws(()=>recordAttestedRepairRuntimeFailure(state,25,oldAction,bad));
for(const bad of [
  {version:26},{phase:'review'},
  {outbox:[{...state.outbox[0],status:'dispatching'}]},
  {outbox:[{...state.outbox[0],receipt:{...state.outbox[0].receipt,
    source_run_id:sourceRun+1}}]},
])assert.throws(()=>recordAttestedRepairRuntimeFailure({...state,...bad},25,oldAction,proof));
for(const altered of [
  {run:{...run,conclusion:'success'}},
  {run:{...run,head_sha:'f'.repeat(40)}},
  {run:{...run,actor:{login:'attacker'}}},
  {jobs:{...jobs,jobs:[...jobs.jobs.slice(0,2),
    {...jobs.jobs[2],conclusion:'success'}]}},
  {jobs:{...jobs,jobs:[...jobs.jobs.slice(0,2),
    {...jobs.jobs[2],steps:jobs.jobs[2].steps.map(s=>s.name.includes('Upload only encrypted')?
      {...s,conclusion:'success'}:s)}]}},
  {artifacts:{...artifacts,total_count:3}},
  {artifacts:{...artifacts,artifacts:artifacts.artifacts.map((a,i)=>
    i?{...a,digest:'sha256:'+'f'.repeat(64)}:a)}},
  {developerLog:'failed job without exact diagnostic'},
])assert.throws(()=>verifyControlledRepairRuntimeFailure(
  altered.run??run,altered.jobs??jobs,altered.artifacts??artifacts,
  altered.developerLog??log));
console.log('Trusted Repair failure: exact Run/Artifact/Stage proof, bounded CAS successor, no blind POST');
