#!/usr/bin/env node
// Independent exact-SHA Full Regression attestation. Never equate a green
// selected main-push run, workflow success alone, or arbitrary branch dispatch
// with a fully verified all-ID result.
import assert from 'node:assert/strict';

const SHA=/^[a-f0-9]{40}$/;
const ID=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPO='BestNathan/nession';
const PREFIX='E2E_FULL_PER_ID_V1 ';
const REQUIRED=[
  'Resolve immutable branch/SHA target',
  'Run full canonical Playwright suite at pinned SHA',
  'Verify complete per-ID assertions',
];
// The workflow now creates hourly admission-only runs whose `full` job is
// skipped. Discovery stays bounded, but cheap admission runs must not evict
// the authenticated full run for the target SHA (#2205).
const PAGE_SIZE=100;
const MAX_PAGES=20;
// A full suite takes minutes; an admission-only run finishes in seconds.
// This is a fast path only: missing/ambiguous timestamps are still inspected.
const MIN_FULL_RUN_MS=60_000;

function runDurationMs(run){
  const started=Date.parse(run?.run_started_at??run?.created_at??'');
  const ended=Date.parse(run?.updated_at??'');
  if(!Number.isFinite(started)||!Number.isFinite(ended))return null;
  return ended-started;
}
export function attestFullRegression({targetSha,run,job,log}){
  if(!SHA.test(targetSha)||run?.name!=='E2E / Full Regression'||
    String(run?.path??'').replace(/@refs\/[^\s]+$/,'')!=='.github/workflows/e2e-full-regression.yml'||
    !['schedule','workflow_dispatch'].includes(run.event)||
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
export async function collectFullRegression({repo=REPO,sha,get,getText}){
  if(repo!==REPO||!SHA.test(sha)||typeof get!=='function'||typeof getText!=='function')
    throw Error('invalid full-regression read scope');
  // A dispatch may verify an older SHA or another branch while the trusted
  // workflow itself still runs from main; do not filter on its workflow SHA.
  const receipts=[];
  for(let page=1;page<=MAX_PAGES;page++){
    const q=new URLSearchParams({branch:'main',per_page:String(PAGE_SIZE),page:String(page)});
    const result=await get('/repos/'+repo+'/actions/workflows/e2e-full-regression.yml/runs?'+q);
    if(!Array.isArray(result?.workflow_runs)||result.workflow_runs.length>PAGE_SIZE)
      throw Error('unbounded Full Regression source runs');
    const runs=result.workflow_runs;
    for(const run of runs){
      if(run.status!=='completed'||run.conclusion!=='success')continue;
      if(run.head_branch!=='main')continue;
      const duration=runDurationMs(run);
      // Fast path for hourly admission-only runs. A real full run cannot
      // complete this quickly; a missing/ambiguous duration is inspected.
      if(duration!=null&&duration<MIN_FULL_RUN_MS)continue;
      const jobList=await get('/repos/'+repo+'/actions/runs/'+run.id+
        '/attempts/'+run.run_attempt+'/jobs?per_page=100');
      const matches=jobList?.jobs?.filter(j=>j.name==='full')??[];
      // An admission-only run may not materialize a `full` job at all.
      if(matches.length===0)continue;
      if(matches.length!==1)throw Error('unverified Full Regression job');
      const job=matches[0];
      // A skipped `full` job is admission-only, not an invalid full run.
      if(job.status!=='completed'||job.conclusion!=='success')continue;
      const log=await getText('/repos/'+repo+'/actions/jobs/'+job.id+'/logs',8*1024*1024);
      // Unrelated scheduled/manual Full runs for other pinned SHAs are not
      // counterfeit results for this request: skip, but never promote them.
      const sourceLines=log.split(/\r?\n/).filter(line=>line.includes(PREFIX));
      if(sourceLines.length!==1)continue;
      let candidate;
      try{candidate=JSON.parse(sourceLines[0].slice(sourceLines[0].indexOf(PREFIX)+PREFIX.length).trim())}
      catch{continue;}
      if(candidate?.sha!==sha)continue;
      receipts.push(attestFullRegression({targetSha:sha,run,job,log}));
    }
    if(runs.length<PAGE_SIZE)break;
  }
  return receipts;
}
function fixtureRun(id,{sha='d'.repeat(40),start='2026-10-24T00:00:00Z',
  end='2026-10-24T00:10:00Z',branch='main',event='schedule'}={}){
  return {name:'E2E / Full Regression',path:'.github/workflows/e2e-full-regression.yml',
    event,head_branch:branch,head_sha:sha,id,run_attempt:1,
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    status:'completed',conclusion:'success',run_started_at:start,updated_at:end};
}
function fixtureJob(id,run,{status='completed',conclusion='success',steps=REQUIRED}={}){
  return {id,name:'full',run_id:run.id,run_attempt:run.run_attempt,head_sha:run.head_sha,
    status,conclusion,steps:steps.map(name=>({name,status:'completed',conclusion:'success'}))};
}
function fixtureReceipt(targetSha,runId,{result={}}={}){
  return {schema_version:1,kind:'e2e_full_per_id',status:'Pass',sha:targetSha,
    run_id:runId,run_attempt:1,catalog_digest:'b'.repeat(64),id_count:1,
    tests:2,assertions:5,results:[{id:'terminal-attach',result:'Pass',discovered:2,
      passed:2,failed:0,skipped:0,flaky:0,assertions:5,...result}]};
}
function fixtureReader({pages,jobs,logs}){
  return {
    get:async(url)=>{
      const parsed=new URL(url,'https://api.github.com');
      if(parsed.pathname.endsWith('/actions/workflows/e2e-full-regression.yml/runs')){
        const page=Number(parsed.searchParams.get('page')??'1');
        return {workflow_runs:pages[page-1]??[],
          total_count:pages.reduce((n,x)=>n+x.length,0)};
      }
      const jobMatch=parsed.pathname.match(/\/actions\/runs\/(\d+)\/attempts\/\d+\/jobs$/);
      if(jobMatch)return {jobs:jobs[Number(jobMatch[1])]??[]};
      throw Error('unexpected collector URL '+url);
    },
    getText:async(url)=>{
      const logMatch=url.match(/\/actions\/jobs\/(\d+)\/logs$/);
      if(logMatch)return logs[Number(logMatch[1])]??'no receipt\n';
      throw Error('unexpected collector log URL '+url);
    },
  };
}
async function selfTest(){
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

  const target='a'.repeat(40),runHead='d'.repeat(40);
  const fullRun=fixtureRun(9001,{sha:runHead});
  const fullJob=fixtureJob(7001,fullRun);
  const receiptLog=PREFIX+JSON.stringify(fixtureReceipt(target,9001))+'\n';
  const admission=i=>fixtureRun(9100+i,{sha:runHead,
    start:'2026-10-24T01:00:00Z',end:'2026-10-24T01:00:20Z'});
  const admissionJobs=Object.fromEntries(Array.from({length:PAGE_SIZE},(_,i)=>{
    const admissionRun=admission(i);
    return [admissionRun.id,[
      {name:'admit',run_id:admissionRun.id,run_attempt:1,head_sha:admissionRun.head_sha,
        status:'completed',conclusion:'success',steps:[]},
      fixtureJob(8100+i,admissionRun,{conclusion:'skipped',steps:[]}),
    ]];
  }));
  const admissionLogs=Object.fromEntries(Array.from({length:PAGE_SIZE},(_,i)=>[8100+i,'no receipt\n']));
  const jobs={...admissionJobs,[fullRun.id]:[fullJob]};
  const logs={...admissionLogs,[fullJob.id]:receiptLog};

  // Regression: ten newer admission-only runs must not evict the full run.
  const ten=Array.from({length:10},(_,i)=>admission(i));
  const regression=await collectFullRegression({sha:target,
    ...fixtureReader({pages:[[...ten,fullRun]],jobs,logs})});
  assert.equal(regression.length,1,'admission-only runs must not evict the full run');

  // Pagination: the full run may be on a later page behind hourly admission runs.
  const pageOne=Array.from({length:PAGE_SIZE},(_,i)=>admission(i));
  const paginated=await collectFullRegression({sha:target,
    ...fixtureReader({pages:[pageOne,[fullRun]],jobs,logs})});
  assert.equal(paginated.length,1,'collector must paginate beyond the first page');

  // A run with no materialized `full` job is admission-only, not an error.
  const noFull=fixtureRun(9200,{sha:runHead,
    start:'2026-10-24T01:00:00Z',end:'2026-10-24T01:02:00Z'});
  const noFullResult=await collectFullRegression({sha:target,
    ...fixtureReader({pages:[[noFull,fullRun]],
      jobs:{[noFull.id]:[{name:'admit',status:'completed',conclusion:'success',steps:[]}],
        [fullRun.id]:[fullJob]},
      logs:{[fullJob.id]:receiptLog}})});
  assert.equal(noFullResult.length,1,'missing full job must be skipped, not fatal');

  // A matching SHA with invalid per-ID evidence still fails closed.
  const forgedLog=PREFIX+JSON.stringify(fixtureReceipt(target,9001,{result:{flaky:1}}))+'\n';
  await assert.rejects(()=>collectFullRegression({sha:target,
    ...fixtureReader({pages:[[fullRun]],jobs:{[fullRun.id]:[fullJob]},
      logs:{[fullJob.id]:forgedLog}})}),/per-ID assertion unproven/);

  // The page size itself stays bounded.
  await assert.rejects(()=>collectFullRegression({sha:target,
    ...fixtureReader({pages:[Array.from({length:PAGE_SIZE+1},(_,i)=>admission(i))],
      jobs:{},logs:{}})}),/unbounded Full Regression source runs/);

  console.log('Full Regression: exact SHA, collector pagination, admission-only skip and forged-run negatives passed');
}
if(process.argv[1]?.endsWith('verification-full-regression-evidence.mjs')&&process.argv[2]==='self-test'){
  selfTest().catch(error=>{
    console.error(error instanceof Error?error.message:error);
    process.exitCode=1;
  });
}
