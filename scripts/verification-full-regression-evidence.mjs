#!/usr/bin/env node
// Independent exact-SHA Full Regression attestation. Never equate a green
// selected main-push run, workflow success alone, or arbitrary branch dispatch
// with a fully verified all-ID result.
import assert from 'node:assert/strict';
import { isTrustedMainFullEvent } from './e2e-regression-policy.mjs';

const SHA=/^[a-f0-9]{40}$/;
const ID=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPO='BestNathan/nession';
const PREFIX='E2E_FULL_PER_ID_V1 ';
const REQUIRED=[
  'Resolve immutable branch/SHA target',
  'Run full canonical Playwright suite at pinned SHA',
  'Verify complete per-ID assertions',
];
export function attestFullRegression({targetSha,run,job,log}){
  if(!SHA.test(targetSha)||run?.name!=='E2E / Full Regression'||
    String(run?.path??'').replace(/@refs\/[^\s]+$/,'')!=='.github/workflows/e2e-full-regression.yml'||
    !isTrustedMainFullEvent(run.event)||
    run.head_branch!=='main'||!SHA.test(run.head_sha??'')||
    run.repository?.full_name!==REPO||run.head_repository?.full_name!==REPO||
    run.status!=='completed'||run.conclusion!=='success'||
    !Number.isSafeInteger(run.id)||run.id<1||
    !Number.isSafeInteger(run.run_attempt)||run.run_attempt<1||
    job?.name!=='full'||job.run_id!==run.id||
    job.run_attempt!==run.run_attempt||job.head_sha!==run.head_sha||
    job.status!=='completed'||job.conclusion!=='success')
    throw Error('untrusted Full Regression SHA/workflow/job source');
  for(const name of REQUIRED){
    const steps=job.steps?.filter(s=>s.name===name)??[];
    if(steps.length!==1||steps[0].status!=='completed'||steps[0].conclusion!=='success')
      throw Error('missing real Full Regression verifier step: '+name);
  }
  if(typeof log!=='string'||log.length>8*1024*1024)
    throw Error('invalid bounded Full Regression log');
  const lines=log.split(/\r?\n/).filter(l=>l.includes(PREFIX));
  if(lines.length!==1)throw Error('missing/ambiguous Full per-ID receipt');
  const receipt=JSON.parse(lines[0].slice(lines[0].indexOf(PREFIX)+PREFIX.length).trim());
  if(receipt?.schema_version!==1||receipt.kind!=='e2e_full_per_id'||
    receipt.status!=='Pass'||receipt.sha!==targetSha||
    receipt.run_id!==run.id||receipt.run_attempt!==run.run_attempt||
    !/^[a-f0-9]{64}$/.test(receipt.catalog_digest??'')||
    !Number.isSafeInteger(receipt.id_count)||receipt.id_count<1||receipt.id_count>64||
    !Array.isArray(receipt.results)||receipt.results.length!==receipt.id_count||
    new Set(receipt.results.map(x=>x.id)).size!==receipt.id_count)
    throw Error('unverified Full Regression per-ID coverage');
  let tests=0, assertions=0;
  for(const row of receipt.results){
    if(!ID.test(row.id)||row.result!=='Pass'||
      !Number.isSafeInteger(row.discovered)||row.discovered<=0||
      row.discovered!==row.passed||row.failed!==0||row.skipped!==0||
      row.flaky!==0||!Number.isSafeInteger(row.assertions)||row.assertions<=0)
      throw Error('Full Regression per-ID assertion unproven');
    tests+=row.discovered;assertions+=row.assertions;
  }
  if(tests!==receipt.tests||assertions!==receipt.assertions)
    throw Error('Full Regression assertion totals mismatch');
  return {kind:'verified_full_regression',schema_version:1,
    target_sha:targetSha,workflow_sha:run.head_sha,run_id:run.id,run_attempt:run.run_attempt,
    id_count:receipt.id_count,tests,assertions,catalog_digest:receipt.catalog_digest,
    status:'Pass',source_event:run.event,
    provenance:'GitHub full-regression trusted workflow + exact main SHA + job verifier steps + per-ID canonical receipt'};
}
export async function collectFullRegression({
  repo=REPO,sha,get,getText,pageSize=20,maxPages=5,maxReceipts=10
}){
  if(repo!==REPO||!SHA.test(sha)||typeof get!=='function'||typeof getText!=='function')
    throw Error('invalid full-regression read scope');
  // Bound API work, but page through admission-only successes. They are not
  // Full Regression evidence and must never consume the receipt lookback.
  if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>20||
    !Number.isSafeInteger(maxPages)||maxPages<1||maxPages>5||
    !Number.isSafeInteger(maxReceipts)||maxReceipts<1||maxReceipts>10)
    throw Error('invalid Full Regression collector bounds');
  const receipts=[];
  for(let page=1;page<=maxPages&&receipts.length<maxReceipts;page++){
    const q=new URLSearchParams({branch:'main',per_page:String(pageSize),page:String(page)});
    const result=await get('/repos/'+repo+'/actions/workflows/e2e-full-regression.yml/runs?'+q);
    if(!Array.isArray(result?.workflow_runs)||result.workflow_runs.length>pageSize)
      throw Error('unbounded Full Regression source runs');
    const runs=result.workflow_runs;
    for(const run of runs){
      if(run.status!=='completed'||run.conclusion!=='success'||run.head_branch!=='main'||
        !Number.isSafeInteger(run.id)||run.id<1||
        !Number.isSafeInteger(run.run_attempt)||run.run_attempt<1)continue;
      const jobList=await get('/repos/'+repo+'/actions/runs/'+run.id+
        '/attempts/'+run.run_attempt+'/jobs?per_page=100');
      if(!Array.isArray(jobList?.jobs)||jobList.jobs.length>100)
        throw Error('unbounded Full Regression jobs');
      const matches=jobList.jobs.filter(j=>j.name==='full');
      // The hourly admission-only workflow run has a skipped "full" job.
      // Skip it before it can displace an older actual Full run.
      if(matches.length!==1)continue;
      const job=matches[0];
      if(!Number.isSafeInteger(job.id)||job.id<1||job.run_id!==run.id||job.run_attempt!==run.run_attempt||
        job.head_sha!==run.head_sha||job.status!=='completed'||job.conclusion!=='success')continue;
      const log=await getText('/repos/'+repo+'/actions/jobs/'+job.id+'/logs',8*1024*1024);
      if(typeof log!=='string'||log.length>8*1024*1024)continue;
      const sourceLines=log.split(/\r?\n/).filter(line=>line.includes(PREFIX));
      if(sourceLines.length!==1)continue;
      let candidate;
      try{candidate=JSON.parse(sourceLines[0].slice(sourceLines[0].indexOf(PREFIX)+PREFIX.length).trim())}
      catch{continue;}
      // Unrelated scheduled/manual Full runs for other pinned SHAs are not
      // counterfeit results for this request: keep searching the bounded window.
      if(candidate?.sha!==sha)continue;
      receipts.push(attestFullRegression({targetSha:sha,run,job,log}));
      if(receipts.length>=maxReceipts)break;
    }
    if(runs.length<pageSize)break;
  }
  return receipts;
}
function selfTest(){
  const sha='a'.repeat(40);
  const run={name:'E2E / Full Regression',path:'.github/workflows/e2e-full-regression.yml',
    event:'schedule',head_branch:'main',head_sha:sha,id:11,run_attempt:2,
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    status:'completed',conclusion:'success'};
  const job={name:'full',run_id:11,run_attempt:2,head_sha:sha,
    status:'completed',conclusion:'success',
    steps:REQUIRED.map(name=>({name,status:'completed',conclusion:'success'}))};
  const receipt={schema_version:1,kind:'e2e_full_per_id',status:'Pass',sha,
    run_id:11,run_attempt:2,catalog_digest:'b'.repeat(64),id_count:1,
    tests:2,assertions:5,results:[{id:'terminal-attach',result:'Pass',discovered:2,
      passed:2,failed:0,skipped:0,flaky:0,assertions:5}]};
  const log=PREFIX+JSON.stringify(receipt)+'\n',source={targetSha:sha,run,job,log};
  assert.equal(attestFullRegression(source).status,'Pass');
  // #2323 SC-12: the immediate post-promotion push route is a trusted Main
  // Full source, not only the scheduled cadence.
  assert.equal(attestFullRegression({...source,
    run:{...run,event:'push'}}).status,'Pass');
  // Trusted main workflow dispatch can exercise a historical/release SHA;
  // the target source is authenticated by pinned checkout + per-ID proof.
  assert.equal(attestFullRegression({...source,run:{...run,head_sha:'d'.repeat(40)},
    job:{...job,head_sha:'d'.repeat(40)}}).workflow_sha,'d'.repeat(40));
  for(const wrong of [
    {targetSha:'c'.repeat(40)},{run:{...run,head_branch:'staging'}},
    {run:{...run,event:'pull_request'}},{job:{...job,run_attempt:1}},
    {job:{...job,steps:job.steps.slice(0,2)}},{log:log+log},
    {log:PREFIX+JSON.stringify({...receipt,results:[]})},
    {log:PREFIX+JSON.stringify({...receipt,results:[{...receipt.results[0],flaky:1}]})}
  ])assert.throws(()=>attestFullRegression({...source,...wrong}));
  console.log('Full Regression: exact SHA, real steps, all-ID assertion and forged-run negatives passed');
}

async function collectorSelfTest(){
  const sha='a'.repeat(40);
  const mkRun=(id)=>({name:'E2E / Full Regression',
    path:'.github/workflows/e2e-full-regression.yml',event:'schedule',
    head_branch:'main',head_sha:sha,id,run_attempt:1,
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    status:'completed',conclusion:'success'});
  // Ten newer admission-only green Workflow Runs must not evict an older
  // authentic Full Regression from the eligible evidence window.
  const admissionRuns=Array.from({length:10},(_,i)=>mkRun(120-i));
  const fullRun=mkRun(100);
  const fullReceipt={schema_version:1,kind:'e2e_full_per_id',status:'Pass',sha,
    run_id:100,run_attempt:1,catalog_digest:'b'.repeat(64),id_count:1,
    tests:2,assertions:5,results:[{id:'terminal-attach',result:'Pass',
      discovered:2,passed:2,failed:0,skipped:0,flaky:0,assertions:5}]};
  const logReads=[];
  const pages=[];
  const fullJob={id:700,name:'full',run_id:100,run_attempt:1,head_sha:sha,
    status:'completed',conclusion:'success',
    steps:REQUIRED.map(name=>({name,status:'completed',conclusion:'success'}))};
  const result=await collectFullRegression({
    repo:REPO,sha,pageSize:10,maxPages:5,
    get:async(path)=>{
      const url=new URL(path,'https://example.invalid');
      if(url.pathname.endsWith('/actions/workflows/e2e-full-regression.yml/runs')){
        const page=Number(url.searchParams.get('page'));
        pages.push(page);
        if(page===1)return {workflow_runs:admissionRuns};
        if(page===2)return {workflow_runs:[fullRun]};
        return {workflow_runs:[]};
      }
      const parts=url.pathname.split('/');
      const runsAt=parts.indexOf('runs');
      const id=Number(parts[runsAt+1]);
      if(runsAt<0||parts[runsAt+2]!=='attempts'||parts[runsAt+4]!=='jobs')
        throw Error('unexpected collector API path: '+path);
      if(id===100)return {jobs:[fullJob]};
      const skippedFull={name:'full',run_id:id,run_attempt:1,head_sha:sha,
        status:'completed',conclusion:'skipped',steps:[]};
      return {jobs:[{name:'admit',run_id:id,run_attempt:1,head_sha:sha,
        status:'completed',conclusion:'success'},skippedFull]};
    },
    getText:async(path)=>{
      logReads.push(path);
      return PREFIX+JSON.stringify(fullReceipt)+'\n';
    }
  });
  assert.deepEqual(pages,[1,2]);
  assert.equal(result.length,1);
  assert.equal(result[0].run_id,100);
  assert.equal(logReads.length,1,'admission-only runs must not have logs read as Full evidence');
  await assert.rejects(()=>collectFullRegression({repo:REPO,sha,get:async()=>({workflow_runs:[]}),
    getText:async()=>'',pageSize:21}));
  console.log('Full Regression collector: skips admission-only successes and paginates to real receipt');
}

if(process.argv[2]==='self-test'){selfTest();await collectorSelfTest();}
