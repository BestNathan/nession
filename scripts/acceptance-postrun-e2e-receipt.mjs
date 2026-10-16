#!/usr/bin/env node
// Read-only, bounded provenance for a completed E2E-sourced Post-Run Waker.
// An Agent verdict (even Pending) is not a substitute for proving the
// canonical E2E event -> trusted select -> Agent -> Issue updater sequence.
import assert from 'node:assert/strict';
import { downloadedResult } from './acceptance-cross-issue-receipt.mjs';

const REPO='BestNathan/nession', SHA=/^[0-9a-f]{40}$/;
const MAX_WAKERS=12;
const ACTIONS_PATH='.github/workflows/acceptance-postrun-waker.yml';
const E2E_PATH='.github/workflows/e2e-tests.yml';
const completed=(j,name)=>{
  const steps=j?.steps?.filter(s=>s.name===name)??[];
  return steps.length===1&&steps[0].status==='completed'&&steps[0].conclusion==='success';
};

export function attestE2eWakeReceipt({repo=REPO,sha,issue,e2e,waker,jobs,log,artifact,result}) {
  if(repo!==REPO || !SHA.test(sha) || !Number.isSafeInteger(issue) || issue<=0 ||
    e2e?.name!=='E2E / Tests'||e2e?.path!==E2E_PATH||
    e2e?.event!=='push'||e2e?.head_branch!=='main'||e2e?.head_sha!==sha||
    e2e?.repository?.full_name!==repo||e2e?.head_repository?.full_name!==repo||
    !Number.isSafeInteger(e2e.id)||e2e.id<=0||
    !Number.isSafeInteger(e2e.run_attempt)||e2e.run_attempt<=0||
    e2e.status!=='completed'||e2e.conclusion!=='success'||
    !Number.isSafeInteger(e2e.repository?.id)||e2e.repository.id<=0||
    waker?.name!=='Acceptance / Post-Run Waker'||
    waker.path!==ACTIONS_PATH||waker.event!=='workflow_run'||
    waker.head_branch!=='main'||waker.head_sha!==sha||
    waker.repository?.full_name!==repo||waker.head_repository?.full_name!==repo||
    waker.repository?.id!==e2e.repository.id||
    waker.status!=='completed'||waker.conclusion!=='success'||
    !Number.isSafeInteger(waker.id)||waker.id<=0||
    !Number.isSafeInteger(waker.run_attempt)||waker.run_attempt<=0||
    !Number.isFinite(Date.parse(e2e.updated_at))||
    !Number.isFinite(Date.parse(waker.created_at))||
    Date.parse(waker.created_at)<Date.parse(e2e.updated_at)||
    !Array.isArray(jobs?.jobs)||jobs.jobs.length>20)
    throw Error('source E2E/Waker exact-SHA workflow identity unverified');

  function stage(name) {
    const found=jobs.jobs.filter(j=>j.name===name);
    if(found.length!==1)throw Error('missing or ambiguous E2E Waker stage '+name);
    const j=found[0];
    if(!Number.isSafeInteger(j.id)||j.id<=0||
      j.run_id!==waker.id||j.run_attempt!==waker.run_attempt||
      j.head_sha!==sha||j.status!=='completed'||j.conclusion!=='success')
      throw Error('unverified E2E Waker stage identity '+name);
    return j;
  }
  const selector=stage('select');
  const agent=stage('evaluate ('+issue+') / Execute acceptance');
  const updater=stage('evaluate ('+issue+') / Deterministic Issue updater');
  if(!completed(selector,'Authenticate trusted completed main-push source and exact ancestry')||
    !completed(selector,'Select only outstanding merged-main Agent criteria')||
    !completed(agent,'Prepare stage-specific immutable acceptance context')||
    !completed(agent,'Run read-only Acceptance Agent')||
    !completed(agent,'Upload structured Acceptance Result')||
    !completed(updater,'Apply Acceptance Report and checkbox projection'))
    throw Error('unverified successful trusted E2E Waker steps');

  // This is GitHub's trusted job log, not a mutable Issue comment. Require
  // unique values of the actual GitHub-injected SOURCE_* environment tuple.
  if(typeof log!=='string'||log.length>1024*1024)
    throw Error('untrusted Waker selection log size');
  for(const [name,want] of [
    ['SOURCE_RUN_ID',String(e2e.id)],
    ['SOURCE_ATTEMPT',String(e2e.run_attempt)],
    ['SOURCE_SHA',sha],
  ]){
    const vals=[...log.matchAll(new RegExp('^\\S+\\s+'+name+':\\s+([^\\r\\n]+?)\\s*$','gm'))];
    if(vals.length!==1||vals[0][1]!==want)
      throw Error('unverified GitHub-injected E2E Waker '+name);
  }

  const expected='acceptance-result-'+issue+'-post-merge-'+waker.id+'-'+waker.run_attempt;
  if(artifact?.name!==expected||artifact.expired!==false||
    !Number.isSafeInteger(artifact.id)||artifact.id<=0||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.digest??'')||
    artifact.workflow_run?.id!==waker.id||
    artifact.workflow_run?.head_sha!==sha||
    artifact.workflow_run?.repository_id!==e2e.repository.id||
    !Number.isSafeInteger(artifact.size_in_bytes)||artifact.size_in_bytes>128*1024||
    result?.schema_version!==1||result.issue!==issue||
    result.stage!=='post-merge'||result.run_id!==waker.id||
    result.target_ref!==sha||
    !['agent-cursor','agent-deepseek'].includes(result.source)||
    !/^[0-9a-f]{64}$/.test(result.contract_sha256??'')||
    !Array.isArray(result.selected_criteria)||
    !Array.isArray(result.criteria)||result.criteria.length>30)
    throw Error('unverified immutable E2E Waker Agent result');
  const expectedSC=result.selected_criteria;
  if(!expectedSC.length || expectedSC.length>30 ||
    new Set(expectedSC).size!==expectedSC.length ||
    expectedSC.some(s=>!/^SC-\d{2,}$/.test(s))||
    !expectedSC.includes('SC-03')||
    result.criteria.some(c=>!expectedSC.includes(c.criterion))||
    result.criteria.filter(c=>c.criterion==='SC-03').length!==1||
    !['Pass','Pending','Fail','N/A'].includes(
      result.criteria.find(c=>c.criterion==='SC-03').result))
    throw Error('E2E Waker artifact must contain genuine SC-03 verdict');
  return {
    kind:'authenticated_post_e2e_wake_receipt',schema_version:1,source_issue:issue,
    target_sha:sha,source_e2e_run:e2e.id,source_e2e_attempt:e2e.run_attempt,
    source_e2e_conclusion:e2e.conclusion,source_e2e_completed_at:e2e.updated_at,
    waker_run:waker.id,waker_attempt:waker.run_attempt,
    waker_created_at:waker.created_at,waker_conclusion:'success',
    authenticated_select_job:selector.id,read_only_agent_job:agent.id,
    deterministic_updater_job:updater.id,
    artifact_id:artifact.id,artifact_digest:artifact.digest,
    observed_agent_sc03_result:result.criteria.find(c=>c.criterion==='SC-03').result,
    provenance:'GitHub exact workflow identity, source-injected event tuple from trusted select job log, exact-attempt job steps, SHA256-bound result artifact',
    limitation:'Proves real completion of the E2E-triggered Agent/Updater cycle; does NOT authorize or synthesize SC Pass',
  };
}

export async function collectE2eWakeReceipts({repo=REPO,sha,issue,
  get,getText,download=downloadedResult,token=process.env.GITHUB_TOKEN??process.env.GH_TOKEN}) {
  if(repo!==REPO||!SHA.test(sha)||!Number.isSafeInteger(issue)||issue<=0||
     typeof get!=='function'||typeof getText!=='function'||!token)
    throw Error('invalid trusted E2E wake collection request');
  const e2es=await get('/repos/'+repo+'/actions/workflows/e2e-tests.yml/runs?'+
    new URLSearchParams({head_sha:sha,event:'push',per_page:'5'}));
  const wakers=await get('/repos/'+repo+'/actions/workflows/acceptance-postrun-waker.yml/runs?'+
    new URLSearchParams({head_sha:sha,event:'workflow_run',per_page:String(MAX_WAKERS)}));
  if(!Array.isArray(e2es?.workflow_runs)||e2es.workflow_runs.length>5||
    !Array.isArray(wakers?.workflow_runs)||wakers.workflow_runs.length>MAX_WAKERS)
    throw Error('unbounded E2E/Waker candidate response');
  const successfulE2e=e2es.workflow_runs.filter(x=>x.status==='completed'&&x.conclusion==='success');
  const candidates=wakers.workflow_runs.filter(x=>x.status==='completed'&&x.conclusion==='success');
  const receipts=[];
  for(const waker of candidates){
    if(waker.head_sha!==sha||waker.name!=='Acceptance / Post-Run Waker')continue;
    const jobs=await get('/repos/'+repo+'/actions/runs/'+waker.id+
      '/attempts/'+waker.run_attempt+'/jobs?per_page=20');
    const selector=jobs.jobs?.filter(j=>j.name==='select');
    if(selector?.length!==1||selector[0].conclusion!=='success')continue;
    const log=await getText('/repos/'+repo+'/actions/jobs/'+selector[0].id+'/logs');
    for(const e2e of successfulE2e){
      if(!log.includes('SOURCE_RUN_ID: '+e2e.id+'\n') &&
         !log.includes('SOURCE_RUN_ID: '+e2e.id+'\r\n'))continue;
      const artifacts=await get('/repos/'+repo+'/actions/runs/'+waker.id+'/artifacts?per_page=30');
      const expected='acceptance-result-'+issue+'-post-merge-'+waker.id+'-'+waker.run_attempt;
      const matching=artifacts.artifacts?.filter(a=>a.name===expected)??[];
      if(matching.length!==1)throw Error('missing or ambiguous original E2E Wake result');
      const result=await download(repo,matching[0],token);
      receipts.push(attestE2eWakeReceipt({repo,sha,issue,e2e,waker,jobs,log,
        artifact:matching[0],result}));
    }
    if(receipts.length>=2)break;
  }
  return receipts;
}

function selfTest(){
  const sha='a'.repeat(40),when='2026-10-16T01:20:07Z';
  const e2e={id:38833592981,run_attempt:1,name:'E2E / Tests',
    path:E2E_PATH,event:'push',head_branch:'main',head_sha:sha,
    status:'completed',conclusion:'success',updated_at:when,
    repository:{id:1282055512,full_name:REPO},
    head_repository:{full_name:REPO}};
  const waker={id:38834548800,run_attempt:1,name:'Acceptance / Post-Run Waker',
    path:ACTIONS_PATH,event:'workflow_run',head_branch:'main',head_sha:sha,
    status:'completed',conclusion:'success',created_at:'2026-10-16T01:20:08Z',
    repository:{id:1282055512,full_name:REPO},
    head_repository:{full_name:REPO}};
  const steps=(names)=>names.map(name=>({name,status:'completed',conclusion:'success'}));
  const job=(id,name,names)=>({id,name,run_id:waker.id,run_attempt:1,
    head_sha:sha,status:'completed',conclusion:'success',steps:steps(names)});
  const jobs={jobs:[
    job(11,'select',['Authenticate trusted completed main-push source and exact ancestry',
      'Select only outstanding merged-main Agent criteria']),
    job(12,'evaluate (1850) / Execute acceptance',[
      'Prepare stage-specific immutable acceptance context',
      'Run read-only Acceptance Agent','Upload structured Acceptance Result']),
    job(13,'evaluate (1850) / Deterministic Issue updater',[
      'Apply Acceptance Report and checkbox projection'])]};
  const log='2026-10-16T01:20:16Z   SOURCE_RUN_ID: 38833592981\n'+
    '2026-10-16T01:20:16Z   SOURCE_ATTEMPT: 1\n'+
    '2026-10-16T01:20:16Z   SOURCE_SHA: '+sha+'\n';
  const artifact={id:12019025003,name:'acceptance-result-1850-post-merge-38834548800-1',
    expired:false,size_in_bytes:1024,digest:'sha256:'+'b'.repeat(64),
    workflow_run:{id:waker.id,head_sha:sha,repository_id:1282055512}};
  const result={schema_version:1,issue:1850,stage:'post-merge',run_id:waker.id,
    target_ref:sha,source:'agent-cursor',contract_sha256:'c'.repeat(64),
    selected_criteria:['SC-03'],criteria:[{criterion:'SC-03',result:'Pending'}]};
  const options={sha,issue:1850,e2e,waker,jobs,log,artifact,result};
  assert.equal(attestE2eWakeReceipt(options).observed_agent_sc03_result,'Pending');
  for(const bad of [
    {e2e:{...e2e,conclusion:'failure'}},
    {waker:{...waker,created_at:when}},
    {waker:{...waker,event:'pull_request'}},
    {waker:{...waker,run_attempt:2}},
    {e2e:{...e2e,head_sha:'d'.repeat(40)}},
    {log:log.replace('SOURCE_RUN_ID: 38833592981','SOURCE_RUN_ID: 100')},
    {log:log+log},
    {jobs:{jobs:jobs.jobs.slice(0,2)}},
    {jobs:{jobs:[jobs.jobs[0],{...jobs.jobs[1],steps:[]},jobs.jobs[2]]}},
    {artifact:{...artifact,digest:'broken'}},
    {result:{...result,target_ref:'e'.repeat(40)}},
    {result:{...result,criteria:[]}},
  ]) assert.throws(()=>attestE2eWakeReceipt({...options,...bad}),
    /unverified|missing|genuine|source/);
  assert.equal(attestE2eWakeReceipt({...options,result:{...result,
    criteria:[{criterion:'SC-03',result:'Pass'}]}}).observed_agent_sc03_result,'Pass');
  console.log('authenticated post-E2E Waker Agent/Updater receipt self-test passed');
}
if(process.argv[2]==='self-test')selfTest();
