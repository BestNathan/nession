#!/usr/bin/env node
import assert from 'node:assert/strict';
import {verifyNativeResumeFailure,FAILED_RUN,FAILED_SHA,FAILED_AGENT}
  from './native-resume-failure.mjs';

const run={id:FAILED_RUN,run_attempt:1,head_sha:FAILED_SHA,head_branch:'main',
  path:'.github/workflows/agent-develop.yml',name:'Agent / Development',
  event:'workflow_dispatch',status:'completed',conclusion:'failure',
  actor:{login:'github-actions[bot]'},repository:{full_name:'BestNathan/nession'},
  head_repository:{full_name:'BestNathan/nession'}};
const j=(name,id,conclusion,steps)=>({name,id,run_id:FAILED_RUN,
  run_attempt:1,status:'completed',conclusion,
  steps:steps.map(([n,c])=>({name:n,conclusion:c}))});
const claim=j('claim',118475197901,'success',[
  ['Publish non-authoritative Worker Run claim before any model call','success'],
  ['Upload Worker claim for independent HMAC and Store reconciliation','success']]);
const restore=j('restore',118475234505,'success',[
  ['Authenticate exact resumed Run from the committed Store','success'],
  ['Rewrap committed native checkpoint in trusted isolated process','success'],
  ['Upload encrypted native transfer for the same admitted Run','success']]);
const developer=j('developer',118475281078,'failure',[
  ['Require exact authenticated Run ID from immutable Store receipt','success'],
  ['Derive only the public RSA sealing key in isolated pre-model step','success'],
  ['Require pinned Cursor Provider and public-only Session sealing key','success'],
  ['Download only same-Run trusted encrypted native transfer','success'],
  ['Restore native bytes and synchronize live Issue before model','success'],
  ['Execute real Developer in isolated Docker with no host credentials','failure'],
  ['Upload canonical immutable Agent telemetry','skipped'],
  ['Upload only encrypted native Session and bounded sanitized result','skipped']]);
const jobs={total_count:3,jobs:[claim,restore,developer]};
const artifact=name=>({name,expired:false,digest:'sha256:'+'a'.repeat(64),
  workflow_run:{id:FAILED_RUN,head_sha:FAILED_SHA}});
const artifacts={total_count:2,artifacts:[
  artifact('development-worker-claim-'+FAILED_RUN+'-1'),
  artifact('development-native-transfer-'+FAILED_RUN+'-1')]};
const log='2026-10-20T05:43:22.8572143Z ##[error]Agent '+FAILED_AGENT+' not found\n';
const head={version:1,
  checkpoint_path:'roles/developer/dev-cursor-01/issues/1997/checkpoints/00000001.json',
  ciphertext_sha256:'a42220e24ed5ff587ed6173b662a75856f62e5a16561274cb616325b150f4107'};
const clone=x=>structuredClone(x),verify=(r=run,j=jobs,a=artifacts,l=log,h=head)=>
  verifyNativeResumeFailure(r,j,a,l,h);
assert.equal(verify().verified,true);
const githubJobPayload=clone(jobs);
githubJobPayload.jobs.forEach(job=>delete job.run_attempt);
assert.equal(verify(run,githubJobPayload).verified,true,
  'GitHub job endpoints omit run_attempt; exact Run ID and fixed job IDs bind identity');
const wrongAttempt=clone(jobs);
wrongAttempt.jobs[0].run_attempt=2;
assert.throws(()=>verify(run,wrongAttempt),/job topology/);
for(const patch of [{head_sha:'f'.repeat(40)},{run_attempt:2},
  {actor:{login:'fork'}},{conclusion:'success'},{head_branch:'staging'}])
  assert.throws(()=>verify({...run,...patch}),/Run\/commit/);
const fake=clone(jobs);
fake.jobs[2].steps.find(s=>s.name==='Execute real Developer in isolated Docker with no host credentials').conclusion='success';
assert.throws(()=>verify(run,fake),/model output may exist/);
const output=clone(jobs);
output.jobs[2].steps.find(s=>s.name==='Upload canonical immutable Agent telemetry').conclusion='success';
assert.throws(()=>verify(run,output),/model output may exist/);
assert.throws(()=>verify(run,jobs,artifacts,log.replace('not found','found')),/lookup-before-send/);
assert.throws(()=>verify(run,jobs,artifacts,'x'.repeat(1024*1024+1)),/lookup-before-send/);
assert.throws(()=>verify(run,jobs,{...artifacts,total_count:3}),/ambiguous/);
assert.throws(()=>verify(run,jobs,artifacts,log,{...head,version:2}),/checkpoint advanced/);
const switched=clone(jobs);switched.jobs[1].conclusion='failure';
assert.throws(()=>verify(run,switched),/job outcome/);
console.log('Native Resume Failure: exact Run, 3 jobs, SDK pre-send log, artifacts, committed v1 negative tests passed');
