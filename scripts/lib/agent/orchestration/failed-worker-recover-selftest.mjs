#!/usr/bin/env node
import assert from 'node:assert/strict';
import {verifyKnownFailure,CONTROLLED_FAILED_RUN,CONTROLLED_FAILED_SHA}
  from './failed-worker-recover.mjs';
const sha=CONTROLLED_FAILED_SHA,id=CONTROLLED_FAILED_RUN;
const run={id,run_attempt:1,head_sha:sha,head_branch:'main',
  path:'.github/workflows/agent-develop.yml',name:'Agent / Development',
  event:'workflow_dispatch',status:'completed',conclusion:'failure',
  actor:{login:'github-actions[bot]'},
  repository:{full_name:'BestNathan/nession'},
  head_repository:{full_name:'BestNathan/nession'}};
const passed=[
  'Publish non-authoritative Worker Run claim before any model call',
  'Upload Worker claim for independent HMAC and Store reconciliation',
  'Require exact authenticated Run ID from immutable Store receipt',
  'Derive only the public RSA sealing key in isolated pre-model step',
  'Require pinned Cursor Provider and public-only Session sealing key',
].map(name=>({name,conclusion:'success'}));
const failStep={name:'Execute authenticated bounded real Developer slice',
  conclusion:'failure'};
const end={name:'Upload only encrypted native Session and bounded sanitized result',
  conclusion:'skipped'};
const job={id:118111376604,run_id:id,run_attempt:1,name:'developer',status:'completed',
  conclusion:'failure',steps:[...passed,failStep,end]};
const jobs={total_count:1,jobs:[job]};
const artifact={name:'development-worker-claim-'+id+'-1',
  expired:false,digest:'sha256:'+'a'.repeat(64),
  workflow_run:{id,head_sha:sha}};
const artifacts={total_count:1,artifacts:[artifact]};
assert.deepEqual(verifyKnownFailure(run,jobs,artifacts),{
  verified:true,issue:1997,run_id:id,attempt:1,
  failure_code:'native_sdk_sandbox_unavailable',
});
const rejects=(r=run,j=jobs,a=artifacts)=>{
  assert.throws(()=>verifyKnownFailure(r,j,a),/verified failure recovery/);
};
rejects({...run,conclusion:'success'});
rejects({...run,status:'in_progress'});
rejects({...run,run_attempt:2});
rejects({...run,id:id+1});
rejects({...run,head_sha:'b'.repeat(40)});
rejects({...run,actor:{login:'attacker'}});
rejects({...run,head_repository:{full_name:'fork/nession'}});
rejects(run,{total_count:2,jobs:[job,job]});
rejects(run,{total_count:1,jobs:[{...job,id:118111376605}]});
rejects(run,{total_count:1,jobs:[{...job,conclusion:'success'}]});
rejects(run,{total_count:1,jobs:[{...job,steps:[...passed,
  {...failStep,conclusion:'success'},end]}]});
rejects(run,{total_count:1,jobs:[{...job,steps:[
  {...passed[0],conclusion:'failure'},...passed.slice(1),failStep,end]}]});
rejects(run,{total_count:1,jobs:[{...job,steps:[
  ...passed,failStep,{...end,conclusion:'success'}]}]});
rejects(run,undefined,{total_count:2,artifacts:[artifact,artifact]});
rejects(run,undefined,{total_count:1,artifacts:[
  {...artifact,name:'development-worker-result-'+id+'-1'}]});
rejects(run,undefined,{total_count:1,artifacts:[
  {...artifact,workflow_run:{id:id+1,head_sha:sha}}]});
console.log('Trusted failed-run recovery: exact native Run, job stage, claim, fork/duplicate and model-outcome denial passed');
