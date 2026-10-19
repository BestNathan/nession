#!/usr/bin/env node
// Bounded, read-only proof of exact main E2E -> Post-Run Waker routing and
// distinct PR -> Orchestrator routing. Receiver head_sha is NOT source SHA.
import assert from 'node:assert/strict';

const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
const E2E='.github/workflows/e2e-tests.yml';
const WAKER='.github/workflows/acceptance-postrun-waker.yml';
const ORCH='.github/workflows/acceptance-orchestrator.yml';
const SOURCES=new Set(['.github/workflows/ci-quality.yml', E2E]);
const isInt=x=>Number.isSafeInteger(x)&&x>0;
const identity=(r,path,event,sha)=>r?.repository?.full_name===REPO&&
  r?.head_repository?.full_name===REPO&&r?.path===path&&r?.event===event&&
  r?.head_sha===sha&&isInt(r.id)&&isInt(r.run_attempt);
const parseInjected=(log,key)=>{
  if(typeof log!=='string'||log.length>1024*1024)return null;
  const values=[...log.matchAll(new RegExp('^\\S+\\s+'+key+':\\s+([^\\r\\n]+?)\\s*$','gm'))];
  return values.length===1?values[0][1]:null;
};
const job=(jobs,name,run)=>{
  const matches=(jobs?.jobs??[]).filter(x=>x.name===name);
  if(matches.length!==1)return null;
  const j=matches[0];
  return j.run_id===run.id&&j.run_attempt===run.run_attempt&&
    j.status==='completed'&&j.conclusion==='success'&&isInt(j.id)?j:null;
};
const step=(j,name)=>j?.steps?.filter(x=>x.name===name).length===1&&
  j.steps.some(x=>x.name===name&&x.status==='completed'&&x.conclusion==='success');

export function attestWaker({sha,e2e,waker,jobs,log,issue=2018}){
  if(!SHA.test(sha)||!identity(e2e,E2E,'push',sha)||e2e.head_branch!=='main'||
    e2e.status!=='completed'||e2e.conclusion!=='success'||
    !identity(waker,WAKER,'workflow_run',sha)||waker.head_branch!=='main'||
    waker.status!=='completed'||waker.conclusion!=='success'||
    !Number.isFinite(Date.parse(e2e.updated_at))||
    !(Date.parse(waker.created_at)>Date.parse(e2e.updated_at)))return null;
  const select=job(jobs,'select',waker);
  const exec=job(jobs,'evaluate ('+issue+') / Execute acceptance',waker);
  const update=job(jobs,'evaluate ('+issue+') / Deterministic Issue updater',waker);
  if(!select||!exec||!update||
    !step(select,'Authenticate trusted completed main-push source and exact ancestry')||
    !step(select,'Select only outstanding merged-main Agent criteria')||
    !step(exec,'Run read-only Acceptance Agent')||
    !step(update,'Apply Acceptance Report and checkbox projection')||
    parseInjected(log,'SOURCE_RUN_ID')!==String(e2e.id)||
    parseInjected(log,'SOURCE_ATTEMPT')!==String(e2e.run_attempt)||
    parseInjected(log,'SOURCE_SHA')!==sha)return null;
  return {kind:'authenticated_acceptance_waker_route',source_e2e_run:e2e.id,
    source_e2e_attempt:e2e.run_attempt,waker_run:waker.id,
    waker_attempt:waker.run_attempt,select_job:select.id,agent_job:exec.id,
    updater_job:update.id,target_sha:sha,source_event:'push',
    provenance:'GitHub workflow identities + job identities + trusted injected SOURCE tuple + completed Agent/updater',
    limitation:'Routing/execution proof only; does not assert the SC Pass'};
}

export function attestPrReceiver({sha,receiver,source,jobs,log}){
  if(!SHA.test(sha)||!identity(receiver,ORCH,'workflow_run',sha)||
    receiver.status!=='completed'||receiver.conclusion!=='success'||
    !identity(source,source?.path,'pull_request',source?.head_sha)||
    !SOURCES.has(source.path)||source.head_branch==='main'||
    source.status!=='completed'||source.conclusion!=='success'||
    !isInt(source.id))return null;
  const reconcile=job(jobs,'reconcile-completed-quality-e2e',receiver);
  if(!reconcile||!step(reconcile,'Converge only when both source workflows and Issue evidence are current')||
    parseInjected(log,'SOURCE_RUN_ID')!==String(source.id)||
    parseInjected(log,'TARGET_SHA')!==source.head_sha)return null;
  return {kind:'authenticated_pr_orchestrator_route',
    receiver_run:receiver.id,source_run:source.id,
    source_sha:source.head_sha,source_workflow:source.path,
    source_branch:source.head_branch,source_event:'pull_request',
    target_receiver_sha:sha,reconcile_job:reconcile.id,
    provenance:'GitHub job log SOURCE_RUN_ID and TARGET_SHA matched to authenticated PR source'};
}

export async function collectRoutingProof({repo=REPO,sha,get,getText,issue=2018}){
  if(repo!==REPO||!SHA.test(sha)||typeof get!=='function'||typeof getText!=='function')throw Error('invalid route proof scope');
  const list=async(file,n)=>get('/repos/'+repo+'/actions/workflows/'+file+'/runs?head_sha='+sha+'&per_page='+n);
  const [e2es,wakers,receivers]=await Promise.all([
    list('e2e-tests.yml',5),list('acceptance-postrun-waker.yml',12),
    list('acceptance-orchestrator.yml',35)]);
  if(!Array.isArray(e2es?.workflow_runs)||e2es.workflow_runs.length>5||
    !Array.isArray(wakers?.workflow_runs)||wakers.workflow_runs.length>12||
    !Array.isArray(receivers?.workflow_runs)||receivers.workflow_runs.length>35)
    throw Error('unbounded routing evidence');
  const source=e2es.workflow_runs.find(r=>identity(r,E2E,'push',sha)&&
    r.head_branch==='main'&&r.status==='completed'&&r.conclusion==='success');
  let post_merge_waker=null;
  if(source){
    for(const w of wakers.workflow_runs.filter(r=>identity(r,WAKER,'workflow_run',sha)&&
      r.status==='completed'&&r.conclusion==='success').slice(0,6)){
      const jobs=await get('/repos/'+repo+'/actions/runs/'+w.id+'/attempts/'+w.run_attempt+'/jobs?per_page=20');
      const select=job(jobs,'select',w);
      if(!select)continue;
      const log=await getText('/repos/'+repo+'/actions/jobs/'+select.id+'/logs');
      const proof=attestWaker({sha,e2e:source,waker:w,jobs,log,issue});
      if(proof){post_merge_waker=proof;break}
    }
  }
  const pr_receivers=[];
  let inspected=0, unattributed_active=0, skipped=0;
  for(const w of receivers.workflow_runs.filter(x=>identity(x,ORCH,'workflow_run',sha)).slice(0,15)){
    const jobs=await get('/repos/'+repo+'/actions/runs/'+w.id+'/attempts/'+w.run_attempt+'/jobs?per_page=20');
    const reconcile=job(jobs,'reconcile-completed-quality-e2e',w);
    if(!reconcile){skipped++;continue}
    inspected++;
    const log=await getText('/repos/'+repo+'/actions/jobs/'+reconcile.id+'/logs');
    const sourceId=Number(parseInjected(log,'SOURCE_RUN_ID'));
    if(!isInt(sourceId)){unattributed_active++;continue}
    const src=await get('/repos/'+repo+'/actions/runs/'+sourceId);
    const proof=attestPrReceiver({sha,receiver:w,source:src,jobs,log});
    if(proof)pr_receivers.push(proof);else unattributed_active++;
  }
  return {kind:'authenticated_acceptance_route_observations',target_sha:sha,
    post_merge_waker,pr_receivers,inspected_active:inspected,
    unattributed_active,skipped_unattributed:skipped,
    completeness:'bounded recent runs only; skipped runs have no source job log; absence of events cannot be inferred',
    limitation:'No SC verdict and no claim that skipped workflow_run receivers have authenticated source lineage'};
}
function selfTest(){
  const sha='a'.repeat(40),prsha='b'.repeat(40),when='2026-10-19T17:32:26Z';
  const common={repository:{full_name:REPO},head_repository:{full_name:REPO},run_attempt:1};
  const e2e={...common,id:100,path:E2E,event:'push',head_branch:'main',
    head_sha:sha,status:'completed',conclusion:'success',updated_at:when};
  const waker={...common,id:101,path:WAKER,event:'workflow_run',head_branch:'main',
    head_sha:sha,status:'completed',conclusion:'success',created_at:'2026-10-19T17:32:28Z'};
  const success=names=>names.map(name=>({name,status:'completed',conclusion:'success'}));
  const j=(id,name,steps,run)=>({id,name,run_id:run.id,run_attempt:1,status:'completed',
    conclusion:'success',steps:success(steps)});
  const jobs={jobs:[
    j(201,'select',['Authenticate trusted completed main-push source and exact ancestry',
      'Select only outstanding merged-main Agent criteria'],waker),
    j(202,'evaluate (2018) / Execute acceptance',['Run read-only Acceptance Agent'],waker),
    j(203,'evaluate (2018) / Deterministic Issue updater',
      ['Apply Acceptance Report and checkbox projection'],waker)]};
  const log='2026-10-19T17:32:38Z   SOURCE_RUN_ID: 100\n'+
    '2026-10-19T17:32:38Z   SOURCE_ATTEMPT: 1\n'+
    '2026-10-19T17:32:38Z   SOURCE_SHA: '+sha+'\n';
  assert(attestWaker({sha,e2e,waker,jobs,log}));
  assert.equal(attestWaker({sha,e2e:{...e2e,event:'pull_request'},waker,jobs,log}),null);
  assert.equal(attestWaker({sha,e2e,waker:{...waker,conclusion:'failure'},jobs,log}),null);
  assert.equal(attestWaker({sha,e2e,waker,jobs,log:log.replace('100','999')}),null);
  assert.equal(attestWaker({sha,e2e,waker,jobs,log:log+log}),null);
  assert.equal(attestWaker({sha,e2e,waker,jobs:{jobs:jobs.jobs.slice(0,2)},log}),null);
  const receiver={...common,id:102,path:ORCH,event:'workflow_run',head_branch:'main',
    head_sha:sha,status:'completed',conclusion:'success'};
  const pr={...common,id:103,path:'.github/workflows/ci-quality.yml',
    event:'pull_request',head_branch:'feature/x',head_sha:prsha,
    status:'completed',conclusion:'success'};
  const recJobs={jobs:[j(204,'reconcile-completed-quality-e2e',
    ['Converge only when both source workflows and Issue evidence are current'],receiver)]};
  const recLog='2026-10-19T17:34:00Z   SOURCE_RUN_ID: 103\n'+
    '2026-10-19T17:34:00Z   TARGET_SHA: '+prsha+'\n';
  assert(attestPrReceiver({sha,receiver,source:pr,jobs:recJobs,log:recLog}));
  assert.equal(attestPrReceiver({sha,receiver,source:{...pr,event:'push'},jobs:recJobs,log:recLog}),null);
  assert.equal(attestPrReceiver({sha,receiver,source:{...pr,head_branch:'main'},jobs:recJobs,log:recLog}),null);
  assert.equal(attestPrReceiver({sha,receiver,source:{...pr,path:E2E,head_sha:sha},jobs:recJobs,log:recLog}),null);
  assert.equal(attestPrReceiver({sha,receiver,source:pr,jobs:recJobs,log:recLog.replace('103','999')}),null);
  console.log('Acceptance route proofs: exact source, waker, PR receiver and negative identity fixtures passed');
}
if(process.argv[2]==='self-test')selfTest();
