#!/usr/bin/env node
// Owner: #2323. Read-only, trusted-Main exact-SHA Full release qualification.
// A green workflow name, prior SHA or skipped per-ID step is NOT a receipt.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const REPO = 'BestNathan/nession';
const WORKFLOW = '.github/workflows/e2e-full-regression.yml';
const SHA = /^[0-9a-f]{40}$/;
const REQUIRED_STEPS = [
  'Resolve immutable branch/SHA target',
  'Run full canonical Playwright suite at pinned SHA',
  'Verify complete per-ID assertions',
  'Preserve full regression report',
];

function canonicalRun(run, sha) {
  return run?.path?.replace(/@refs\/[^\s]+$/, '') === WORKFLOW &&
    run.repository?.full_name === REPO &&
    run.head_repository?.full_name === REPO &&
    run.head_branch === 'main' &&
    run.head_sha === sha &&
    run.event === 'push' &&
    Number.isSafeInteger(run.id) && run.id > 0 &&
    Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0;
}

function canonicalFull(job, run) {
  return job?.name === 'full' && job.run_id === run.id &&
    job.run_attempt === run.run_attempt &&
    job.head_sha === run.head_sha;
}

export function decideReleaseFull({sha, runs, jobs, artifacts}) {
  if(!SHA.test(sha)) throw Error('invalid exact Main release SHA');
  if(!Array.isArray(runs) || runs.length>100) throw Error('invalid bounded Main Full run results');
  const candidates = runs.filter(run=>canonicalRun(run, sha));
  if(candidates.length===0) return {decision:'PENDING',reason:'NO_EXACT_MAIN_PUSH_FULL_RUN',run:false};
  candidates.sort((a,b)=>b.id-a.id);
  const run=candidates[0];
  const identity={source_sha:sha,run_id:run.id,run_attempt:run.run_attempt};
  if(!['queued','in_progress','completed','waiting','pending','requested'].includes(run.status))
    return {...identity,decision:'ERROR',reason:'UNKNOWN_RUN_STATE',run:false};
  if(run.status!=='completed')
    return {...identity,decision:'PENDING',reason:'FULL_RUN_IN_PROGRESS',run:false};
  if(run.conclusion!=='success')
    return {...identity,decision:'FAIL',reason:'FULL_RUN_NOT_SUCCESSFUL',run:false};
  if(!Array.isArray(jobs) || jobs.length>100)
    return {...identity,decision:'ERROR',reason:'INVALID_ATTEMPT_JOBS',run:false};
  const matches=jobs.filter(job=>job.name==='full');
  if(matches.length!==1 || !canonicalFull(matches[0],run))
    return {...identity,decision:'ERROR',reason:'FULL_JOB_ATTEMPT_IDENTITY_MISMATCH',run:false};
  const job=matches[0];
  if(job.status!=='completed' || job.conclusion!=='success')
    return {...identity,decision:'FAIL',reason:'FULL_JOB_NOT_SUCCESSFUL',run:false};
  if(!Array.isArray(job.steps))
    return {...identity,decision:'ERROR',reason:'MISSING_FULL_STEP_ATTESTATION',run:false};
  for(const name of REQUIRED_STEPS){
    const steps=job.steps.filter(step=>step.name===name);
    if(steps.length!==1 || steps[0].status!=='completed' || steps[0].conclusion!=='success')
      return {...identity,decision:'ERROR',reason:'REQUIRED_FULL_STEP_NOT_VERIFIED',step:name,run:false};
  }
  if(!Array.isArray(artifacts) || artifacts.length>100)
    return {...identity,decision:'ERROR',reason:'INVALID_FULL_ARTIFACT_LIST',run:false};
  const matching=artifacts.filter(a=>a.name===`full-regression-${run.id}-${run.run_attempt}`);
  if(matching.length!==1 || matching[0].expired!==false ||
    !Number.isSafeInteger(matching[0].size_in_bytes) || matching[0].size_in_bytes<1 ||
    !/^sha256:[0-9a-f]{64}$/.test(matching[0].digest??'') ||
    matching[0].workflow_run?.id!==run.id)
    return {...identity,decision:'ERROR',reason:'MISSING_OR_UNTRUSTED_FULL_REPORT_ARTIFACT',run:false};
  return {...identity,decision:'PASS',reason:'VERIFIED_EXACT_MAIN_FULL',
    artifact_id:matching[0].id,artifact_digest:matching[0].digest,run:true};
}

export async function evaluateReleaseFull({sha,get}) {
  if(!SHA.test(sha)||typeof get!=='function')throw Error('invalid Full release gate scope');
  const query=new URLSearchParams({head_sha:sha,branch:'main',event:'push',per_page:'100'});
  const base='/repos/'+REPO+'/actions';
  const list=await get(base+'/workflows/e2e-full-regression.yml/runs?'+query);
  if(!Array.isArray(list?.workflow_runs) || list.workflow_runs.length>100)
    throw Error('invalid Full workflow runs response');
  const runs=list.workflow_runs;
  const exact=runs.filter(run=>canonicalRun(run,sha));
  if(exact.length===0){
    if(runs.length===100)throw Error('EXHAUSTED: cannot rule out older exact-SHA Full runs');
    return decideReleaseFull({sha,runs,jobs:[],artifacts:[]});
  }
  const run=exact.sort((a,b)=>b.id-a.id)[0];
  if(run.status!=='completed'||run.conclusion!=='success')
    return decideReleaseFull({sha,runs,jobs:[],artifacts:[]});
  const [jobs,artifacts]=await Promise.all([
    get(base+'/runs/'+run.id+'/attempts/'+run.run_attempt+'/jobs?per_page=100'),
    get(base+'/runs/'+run.id+'/artifacts?per_page=100'),
  ]);
  return decideReleaseFull({sha,runs,jobs:jobs?.jobs,artifacts:artifacts?.artifacts});
}

async function getGithub(path){
  const token=String(process.env.GH_TOKEN??process.env.GITHUB_TOKEN??'').trim();
  if(!token)throw Error('GitHub Actions read token required');
  if(!/^\/repos\/BestNathan\/nession\/actions\/(workflows\/e2e-full-regression\.yml\/runs\?head_sha=[0-9a-f]{40}&branch=main&event=push&per_page=100|runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*\/jobs\?per_page=100|runs\/[1-9][0-9]*\/artifacts\?per_page=100)$/.test(path))
    throw Error('refused out-of-scope GitHub read');
  const response=await fetch('https://api.github.com'+path,{
    headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,
      'X-GitHub-Api-Version':'2022-11-28'},
  });
  const body=await response.text();
  if(!response.ok)throw Error('GitHub Full evidence read failed: HTTP '+response.status);
  if(body.length>4*1024*1024)throw Error('GitHub Full evidence exceeds response limit');
  try{return JSON.parse(body);}catch{throw Error('invalid GitHub Full evidence JSON');}
}

async function selfTest(){
  const sha='a'.repeat(40),old='b'.repeat(40);
  const run={id:5400,run_attempt:2,path:WORKFLOW,event:'push',status:'completed',
    conclusion:'success',head_sha:sha,head_branch:'main',
    repository:{full_name:REPO},head_repository:{full_name:REPO}};
  const job={id:5500,run_id:5400,run_attempt:2,head_sha:sha,name:'full',
    status:'completed',conclusion:'success',
    steps:REQUIRED_STEPS.map(name=>({name,status:'completed',conclusion:'success'}))};
  const artifact={id:5600,name:'full-regression-5400-2',expired:false,
    size_in_bytes:4096,digest:'sha256:'+'c'.repeat(64),workflow_run:{id:5400}};
  const v=(patch={})=>decideReleaseFull({sha,runs:[run],jobs:[job],artifacts:[artifact],...patch});
  assert.equal(v().decision,'PASS');
  assert.equal(v({runs:[{...run,head_sha:old}]}).decision,'PENDING');
  assert.equal(v({runs:[{...run,event:'schedule'}]}).decision,'PENDING');
  assert.equal(v({runs:[{...run,status:'in_progress'}]}).decision,'PENDING');
  assert.equal(v({runs:[{...run,conclusion:'failure'}]}).decision,'FAIL');
  assert.equal(v({jobs:[{...job,run_attempt:1}]}).decision,'ERROR');
  assert.equal(v({jobs:[{...job,conclusion:'skipped'}]}).decision,'FAIL');
  assert.equal(v({jobs:[{...job,steps:job.steps.filter(x=>x.name!=='Verify complete per-ID assertions')}]}).decision,'ERROR');
  assert.equal(v({jobs:[{...job,steps:job.steps.map(x=>x.name==='Verify complete per-ID assertions'?{...x,conclusion:'skipped'}:x)}]}).decision,'ERROR');
  assert.equal(v({artifacts:[]}).decision,'ERROR');
  assert.equal(v({artifacts:[{...artifact,digest:null}]}).decision,'ERROR');
  assert.equal(v({artifacts:[{...artifact,expired:true}]}).decision,'ERROR');
  assert.equal(v({artifacts:[{...artifact,workflow_run:{id:1}}]}).decision,'ERROR');
  assert.throws(()=>decideReleaseFull({sha:'main',runs:[],jobs:[],artifacts:[]}));
  const reads=[];
  const inspected=await evaluateReleaseFull({sha,get:async path=>{
    reads.push(path);
    if(path.includes('/workflows/'))return {workflow_runs:[run]};
    if(path.includes('/jobs?'))return {jobs:[job]};
    return {artifacts:[artifact]};
  }});
  assert.equal(inspected.decision,'PASS');
  assert.equal(reads.length,3);
  const pending=await evaluateReleaseFull({sha,get:async path=>{
    assert.match(path,/head_sha=/);
    return {workflow_runs:[]};
  }});
  assert.equal(pending.decision,'PENDING');
  console.log('main-full-release-gate self-test: PASS');
}

async function main(){
  if(process.argv[2]==='self-test')return selfTest();
  if(process.argv[2]!=='check')throw Error('usage: self-test | check <exact-main-sha>');
  const sha=process.argv[3];
  const result=await evaluateReleaseFull({sha,get:getGithub});
  console.log(JSON.stringify(result));
  if(process.env.GITHUB_OUTPUT){
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      'decision='+result.decision+'\n'+
      'source_sha='+sha+'\n'+
      'receipt_run_id='+(result.run_id??'')+'\n'+
      'receipt_attempt='+(result.run_attempt??'')+'\n');
  }
  if(result.decision==='PASS')return;
  process.exitCode=result.decision==='PENDING'?3:2;
}

if(process.argv[1]?.endsWith('main-full-release-gate.mjs')){
  main().catch(err=>{console.error('main-full-release-gate: '+err.message);process.exitCode=2;});
}
