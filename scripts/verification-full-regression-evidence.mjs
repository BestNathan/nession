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
export function attestFullRegression({targetSha,run,job,log}){
  if(!SHA.test(targetSha)||run?.name!=='E2E / Full Regression'||
    String(run?.path??'').replace(/@refs\/[^\s]+$/,'')!=='.github/workflows/e2e-full-regression.yml'||
    !['schedule','workflow_dispatch'].includes(run.event)||
    run.head_branch!=='main'||run.head_sha!==targetSha||
    run.repository?.full_name!==REPO||run.head_repository?.full_name!==REPO||
    run.status!=='completed'||run.conclusion!=='success'||
    !Number.isSafeInteger(run.id)||run.id<1||
    !Number.isSafeInteger(run.run_attempt)||run.run_attempt<1||
    job?.name!=='full'||job.run_id!==run.id||
    job.run_attempt!==run.run_attempt||job.head_sha!==targetSha||
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
    target_sha:targetSha,run_id:run.id,run_attempt:run.run_attempt,
    id_count:receipt.id_count,tests,assertions,catalog_digest:receipt.catalog_digest,
    status:'Pass',source_event:run.event,
    provenance:'GitHub full-regression trusted workflow + exact main SHA + job verifier steps + per-ID canonical receipt'};
}
export async function collectFullRegression({repo=REPO,sha,get,getText}){
  if(repo!==REPO||!SHA.test(sha)||typeof get!=='function'||typeof getText!=='function')
    throw Error('invalid full-regression read scope');
  const q=new URLSearchParams({head_sha:sha,per_page:'10'});
  const result=await get('/repos/'+repo+'/actions/workflows/e2e-full-regression.yml/runs?'+q);
  if(!Array.isArray(result?.workflow_runs)||result.workflow_runs.length>10)
    throw Error('unbounded Full Regression source runs');
  const receipts=[];
  for(const run of result.workflow_runs.filter(r=>r.status==='completed'&&r.conclusion==='success').slice(0,3)){
    if(run.head_sha!==sha||run.head_branch!=='main')continue;
    const jobList=await get('/repos/'+repo+'/actions/runs/'+run.id+
      '/attempts/'+run.run_attempt+'/jobs?per_page=100');
    const matches=jobList?.jobs?.filter(j=>j.name==='full')??[];
    if(matches.length!==1)throw Error('unverified Full Regression job');
    const log=await getText('/repos/'+repo+'/actions/jobs/'+matches[0].id+'/logs',8*1024*1024);
    receipts.push(attestFullRegression({targetSha:sha,run,job:matches[0],log}));
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
  for(const wrong of [
    {targetSha:'c'.repeat(40)},{run:{...run,head_branch:'staging'}},
    {run:{...run,event:'pull_request'}},{job:{...job,run_attempt:1}},
    {job:{...job,steps:job.steps.slice(0,2)}},{log:log+log},
    {log:PREFIX+JSON.stringify({...receipt,results:[]})},
    {log:PREFIX+JSON.stringify({...receipt,results:[{...receipt.results[0],flaky:1}]})}
  ])assert.throws(()=>attestFullRegression({...source,...wrong}));
  console.log('Full Regression: exact SHA, real steps, all-ID assertion and forged-run negatives passed');
}
if(process.argv[2]==='self-test')selfTest();
