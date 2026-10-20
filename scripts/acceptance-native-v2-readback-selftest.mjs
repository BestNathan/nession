#!/usr/bin/env node
// Authenticated, public metadata only; no native JSONL, Provider keys or model calls.
import assert from 'node:assert/strict';
import {nativeReadbackEligible,nativeReadbackAncestryReady,
  verifyNativeV2Lineage,attestNativeRecoveryReadback} from './acceptance-development-readback.mjs';

const v13={"schema_version":1,"issue":1997,"version":13,"phase":"ready","target_sha":null,"repair_attempts":0,"transitions":[],"assignments":{"developer":"dev-cursor-01","reviewer":"review-cursor-01","acceptor":"accept-cursor-01"},"outbox":[{"id":"95b467a90a33b503dc19fb59f3a50378860e6e1eaa2961a0929ca97ae020edae","task":{"type":"dispatch","role":"developer","task":"implement","sha":"220266b9233ec97b1beacbc54e5cc7f82d3cece2","agent_id":"dev-cursor-01"},"status":"failed","attempts":1,"receipt":{"status":"failed","dispatch_id":"95b467a90a33b503dc19fb59f3a50378860e6e1eaa2961a0929ca97ae020edae","source_run_id":39267659650,"source_attempt":1,"failure_code":"native_sdk_sandbox_unavailable"}},{"id":"85b69a9de06b02eb78f8a3a15d14b58a43ffc83ee6b1f5db11b9b541cfec9656","task":{"type":"dispatch","role":"developer","task":"implement","sha":"220266b9233ec97b1beacbc54e5cc7f82d3cece2","agent_id":"dev-cursor-01"},"status":"yielded","attempts":1,"receipt":{"status":"yielded","dispatch_id":"85b69a9de06b02eb78f8a3a15d14b58a43ffc83ee6b1f5db11b9b541cfec9656","source_run_id":39288961865,"source_attempt":1,"checkpoint_version":1,"checkpoint_commit_sha":"d812e3655c0ad6337b1003aa0c1794c12335adb0","ciphertext_sha256":"a42220e24ed5ff587ed6173b662a75856f62e5a16561274cb616325b150f4107"}},{"id":"3f4abb86785d41dbb771edbab1c400841d3d0e60335358332307b75e1d36c1c8","task":{"type":"dispatch","role":"developer","task":"implement","sha":"220266b9233ec97b1beacbc54e5cc7f82d3cece2","agent_id":"dev-cursor-01","resume":true,"continuation":{"parent_action_id":"85b69a9de06b02eb78f8a3a15d14b58a43ffc83ee6b1f5db11b9b541cfec9656","ordinal":1,"checkpoint_version":1,"checkpoint_commit_sha":"d812e3655c0ad6337b1003aa0c1794c12335adb0","ciphertext_sha256":"a42220e24ed5ff587ed6173b662a75856f62e5a16561274cb616325b150f4107"}},"status":"failed","attempts":1,"receipt":{"status":"failed","dispatch_id":"3f4abb86785d41dbb771edbab1c400841d3d0e60335358332307b75e1d36c1c8","source_run_id":39376331942,"source_attempt":1,"failure_code":"native_cursor_agent_not_found_before_send"}},{"id":"6a84244ca028a93f8c057ab23852bb21c3906d485e4c16ccab661104c31d750e","task":{"type":"dispatch","role":"developer","task":"implement","sha":"220266b9233ec97b1beacbc54e5cc7f82d3cece2","agent_id":"dev-cursor-01","resume":true,"continuation":{"parent_action_id":"85b69a9de06b02eb78f8a3a15d14b58a43ffc83ee6b1f5db11b9b541cfec9656","ordinal":1,"checkpoint_version":1,"checkpoint_commit_sha":"d812e3655c0ad6337b1003aa0c1794c12335adb0","ciphertext_sha256":"a42220e24ed5ff587ed6173b662a75856f62e5a16561274cb616325b150f4107"}},"status":"yielded","attempts":1,"receipt":{"status":"yielded","dispatch_id":"6a84244ca028a93f8c057ab23852bb21c3906d485e4c16ccab661104c31d750e","source_run_id":39396836009,"source_attempt":1,"checkpoint_version":2,"checkpoint_commit_sha":"f9abdeca3cc26780fb0a7b2ed7000d2dd28cf142","ciphertext_sha256":"ae089e6b7b1743a9afdb78814ba716be024ccde9da0a1ddfbc965601f2691f1e"}},{"id":"dac10d570c30557fe629b8605ecb44d33335eb967e24a52931467ac7b93b5e31","task":{"type":"dispatch","role":"developer","task":"implement","sha":"220266b9233ec97b1beacbc54e5cc7f82d3cece2","agent_id":"dev-cursor-01","resume":true,"continuation":{"parent_action_id":"6a84244ca028a93f8c057ab23852bb21c3906d485e4c16ccab661104c31d750e","ordinal":2,"checkpoint_version":2,"checkpoint_commit_sha":"f9abdeca3cc26780fb0a7b2ed7000d2dd28cf142","ciphertext_sha256":"ae089e6b7b1743a9afdb78814ba716be024ccde9da0a1ddfbc965601f2691f1e"}},"status":"pending","attempts":0,"receipt":null}]};
const r={
  checkpoint_version:2,
  action_id:'6a84244ca028a93f8c057ab23852bb21c3906d485e4c16ccab661104c31d750e',
  run_id:39396836009,attempt:1,
  worker_sha:'2f75869833fb43ec54e88b560226f8913a6beac3',
  source_sha:'220266b9233ec97b1beacbc54e5cc7f82d3cece2',
  session_id:'agent-7d5b4a61-1476-4ce7-a38a-82907aa3b1a6',
  checkpoint_commit_sha:'f9abdeca3cc26780fb0a7b2ed7000d2dd28cf142',
  ciphertext_sha256:'ae089e6b7b1743a9afdb78814ba716be024ccde9da0a1ddfbc965601f2691f1e',
};
assert.equal(nativeReadbackEligible(2010,'staging'),true);
assert.equal(nativeReadbackEligible(2045,'post-merge'),true);
assert.equal(nativeReadbackEligible(2038,'post-merge'),true);
assert.equal(nativeReadbackEligible(2041,'post-merge'),true);
for(const x of [[1997,'post-merge'],[2045,'staging'],[2041,'pr'],[2053,'post-merge'],[1664,'post-merge'],[2010,'pr']])
  assert.equal(nativeReadbackEligible(...x),false);
const sha='a'.repeat(40),sources=['b'.repeat(40),'c'.repeat(40),'d'.repeat(40)];
let calls=0;
const runner=(status,failIndex=1)=>(cmd,args)=>{
  assert.equal(cmd,'git');
  assert.deepEqual(args.slice(0,4),['-C','/repo','merge-base','--is-ancestor']);
  calls++;
  if(status!==0&&calls===failIndex){const e=new Error('git exit '+status);e.status=status;throw e;}
};
assert.equal(nativeReadbackAncestryReady('/repo',sha,sources,runner(0)),true);
assert.equal(calls,3);
calls=0;
assert.equal(nativeReadbackAncestryReady('/repo',sha,sources,runner(1)),false);
assert.equal(calls,1,'invalid ancestor cannot authorize later proof sources');
calls=0;
assert.throws(()=>nativeReadbackAncestryReady('/repo',sha,sources,runner(128)),
  /source ancestry check unavailable/);
assert.throws(()=>nativeReadbackAncestryReady('/repo','invalid',sources,runner(0)),/invalid/);
assert.throws(()=>nativeReadbackAncestryReady('/repo',sha,['bad',...sources],runner(0)),/invalid/);
assert.equal(verifyNativeV2Lineage({...r,checkpoint_version:1},v13),false);
assert.equal(verifyNativeV2Lineage({...r,checkpoint_version:3},v13),false);
assert.equal(verifyNativeV2Lineage(r,v13),true);
// Independently attest the historically failed Run. A state-level failed flag
// cannot itself prove GitHub executed the original Agent.resume-before-send.
const failureRun={id:39376331942,run_attempt:1,
  head_sha:'fdcfd3b6e40f891a7ef601c3539609113b2f4f5e',
  head_branch:'main',path:'.github/workflows/agent-develop.yml',
  name:'Agent / Development',event:'workflow_dispatch',status:'completed',conclusion:'failure',
  actor:{login:'github-actions[bot]'},repository:{full_name:'BestNathan/nession'},
  head_repository:{full_name:'BestNathan/nession'}};
const failureJob=(name,id,conclusion,steps)=>({name,id,run_id:39376331942,
  run_attempt:1,status:'completed',conclusion,
  steps:steps.map(([n,c])=>({name:n,conclusion:c}))});
const failureJobs={total_count:3,jobs:[
  failureJob('claim',118475197901,'success',[
    ['Publish non-authoritative Worker Run claim before any model call','success'],
    ['Upload Worker claim for independent HMAC and Store reconciliation','success']]),
  failureJob('restore',118475234505,'success',[
    ['Authenticate exact resumed Run from the committed Store','success'],
    ['Rewrap committed native checkpoint in trusted isolated process','success'],
    ['Upload encrypted native transfer for the same admitted Run','success']]),
  failureJob('developer',118475281078,'failure',[
    ['Require exact authenticated Run ID from immutable Store receipt','success'],
    ['Derive only the public RSA sealing key in isolated pre-model step','success'],
    ['Require pinned Cursor Provider and public-only Session sealing key','success'],
    ['Download only same-Run trusted encrypted native transfer','success'],
    ['Restore native bytes and synchronize live Issue before model','success'],
    ['Execute real Developer in isolated Docker with no host credentials','failure'],
    ['Upload canonical immutable Agent telemetry','skipped'],
    ['Upload only encrypted native Session and bounded sanitized result','skipped']]),
]};
const failedArtifact=name=>({name,expired:false,digest:'sha256:'+'a'.repeat(64),
  workflow_run:{id:39376331942,head_sha:failureRun.head_sha}});
const failureArtifacts={total_count:2,artifacts:[
  failedArtifact('development-worker-claim-39376331942-1'),
  failedArtifact('development-native-transfer-39376331942-1')]};
const failureLog='2026-10-20T05:43:22.8572143Z ##[error]Agent '+
  'agent-7d5b4a61-1476-4ce7-a38a-82907aa3b1a6 not found\n';
const originalHead={version:1,
  checkpoint_path:'roles/developer/dev-cursor-01/issues/1997/checkpoints/00000001.json',
  ciphertext_sha256:'a42220e24ed5ff587ed6173b662a75856f62e5a16561274cb616325b150f4107'};
const store={native_resume_verified:verifyNativeV2Lineage(r,v13),
  dispatch_history:{action_id:r.action_id,verified_worker_run_id:r.run_id,
    issuer_run_id:39396782160,states_and_source_bindings_verified:true},
  continuation_action_id:'dac10d570c30557fe629b8605ecb44d33335eb967e24a52931467ac7b93b5e31'};
const params={receipt:r,store,failedRun:failureRun,jobs:failureJobs,
  artifacts:failureArtifacts,log:failureLog,v1Head:originalHead,targetSha:'a'.repeat(40)};
const proof=attestNativeRecoveryReadback(params);
assert.equal(proof.kind,'verified_native_resume_recovery');
assert.equal(proof.original_failed_worker_run_id,39376331942);
assert.equal(proof.successor_worker_run_id,39396836009);
assert.equal(proof.parent_checkpoint_version,1);
assert.equal(proof.successor_checkpoint_version,2);
assert.equal(proof.target_sha,'a'.repeat(40));
assert.equal(proof.source_ancestry_verified,true);
assert.equal(proof.new_worker_dispatch_requested,false);
assert.equal(proof.publisher_or_full_repair_verified,false);
for(const patch of [
  {failedRun:{...failureRun,id:39376331943}},
  {failedRun:{...failureRun,run_attempt:2}},
  {failedRun:{...failureRun,head_repository:{full_name:'fork/evil'}}},
  {failedRun:{...failureRun,conclusion:'success'}},
  {log:failureLog.replace('not found','found')},
  {artifacts:{...failureArtifacts,total_count:3}},
  {v1Head:{...originalHead,version:2}},
  {receipt:{...r,run_id:39396836010}},
  {store:{...store,native_resume_verified:false}},
  {store:{...store,dispatch_history:{...store.dispatch_history,issuer_run_id:0}}},
  {targetSha:'invalid'},
])assert.throws(()=>attestNativeRecoveryReadback({...params,...patch}));
for(const patch of [
  {action_id:'f'.repeat(64)},{run_id:39396836010},
  {attempt:2},{worker_sha:'f'.repeat(40)}, {source_sha:'f'.repeat(40)},
  {session_id:'agent-fake'}, {checkpoint_commit_sha:'f'.repeat(40)},
  {ciphertext_sha256:'f'.repeat(64)},
])assert.throws(()=>verifyNativeV2Lineage({...r,...patch},v13),/native Session v2/);
const copy=x=>structuredClone(x);
for(const bad of [
  s=>{s.outbox.find(a=>a.id===r.action_id).receipt.source_run_id=42;},
  s=>{s.outbox.find(a=>a.id===r.action_id).receipt.checkpoint_version=3;},
  s=>{s.outbox.find(a=>a.id==='3f4abb86785d41dbb771edbab1c400841d3d0e60335358332307b75e1d36c1c8').receipt.source_run_id=42;},
  s=>{s.outbox.find(a=>a.id===r.action_id).task.continuation.checkpoint_version=2;},
]){const s=copy(v13);bad(s);assert.throws(()=>verifyNativeV2Lineage(r,s));}
console.log('Read-only native v2 Acceptance: stage and SHA ancestry boundaries, exact same-Agent Store lineage, tamper negatives passed');
