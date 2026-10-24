#!/usr/bin/env node
// Owner: #2323. Main-owned pure scheduling and Staging ancestry admission.
// A branch ref is NOT a deployed-environment attestation; callers must supply
// independently authenticated source/digest identity (#1616) for remote Staging.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const SHA = /^[0-9a-f]{40}$/;
const LANE = /^[a-z][a-z0-9-]{0,62}$/;
export const DEFAULT_INTERVALS = Object.freeze({ staging: 2, main: 12 });

export function interval(value, fallback) {
  const raw = value == null || value === '' ? String(fallback) : String(value);
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error('invalid E2E interval: expected positive whole hours');
  const hours = Number(raw);
  if (!Number.isSafeInteger(hours) || hours > 168) {
    throw new Error('invalid E2E interval: must be in 1..168 hours');
  }
  return hours;
}

export function config(env = process.env) {
  const staging = interval(env.E2E_STAGING_INTERVAL_HOURS, DEFAULT_INTERVALS.staging);
  const main = interval(env.E2E_MAIN_INTERVAL_HOURS, DEFAULT_INTERVALS.main);
  const text = env.E2E_STAGING_LANE_INTERVALS_JSON || '{}';
  let obj;
  try { obj = JSON.parse(text); }
  catch { throw new Error('invalid E2E_STAGING_LANE_INTERVALS_JSON'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('lane interval overrides must be an object');
  }
  const lanes = {};
  for (const [name, hours] of Object.entries(obj)) {
    if (!LANE.test(name) || typeof hours !== 'number') {
      throw new Error('invalid staging lane interval override');
    }
    lanes[name] = interval(hours, staging);
  }
  return { main, staging, lanes };
}

// The hourly cron is a wake-up signal only. Compute cadence from the last real
// scheduled Full job completion so delayed/dropped ticks recover automatically.
export function mainScheduleDecision({now,intervalHours,lastFullCompletedAt=null,fullInFlight=false}){
  const nowMs=Date.parse(now);
  if(!Number.isFinite(nowMs))throw new Error('invalid schedule timestamp');
  if(!Number.isSafeInteger(intervalHours)||intervalHours<1||intervalHours>168)
    throw new Error('invalid interval');
  if(typeof fullInFlight!=='boolean')throw Error('invalid Full Regression in-flight state');
  const common={interval_hours:intervalHours,last_full_completed_at:null,next_due_at:null,run:false};
  if(fullInFlight)return {...common,decision:'FULL_IN_FLIGHT',reason:'an actual Full job is queued or running'};
  if(lastFullCompletedAt==null||lastFullCompletedAt===''){
    return {...common,decision:'ELIGIBLE',run:true,reason:'NO_SCHEDULED_FULL_HISTORY',
      next_due_at:new Date(nowMs).toISOString()};
  }
  const lastMs=Date.parse(lastFullCompletedAt);
  if(!Number.isFinite(lastMs))throw Error('invalid last Full completion timestamp');
  const nextMs=lastMs+intervalHours*3600000;
  const lastIso=new Date(lastMs).toISOString();
  const nextIso=new Date(nextMs).toISOString();
  if(nowMs>=nextMs)return {...common,decision:'ELIGIBLE',run:true,reason:'INTERVAL_ELAPSED',
    last_full_completed_at:lastIso,next_due_at:nextIso};
  return {...common,decision:'NOT_DUE',reason:'INTERVAL_NOT_ELAPSED',
    last_full_completed_at:lastIso,next_due_at:nextIso};
}

const REPO='BestNathan/nession';
const FULL_WORKFLOW_PATH='.github/workflows/e2e-full-regression.yml';

function canonicalMainFullRun(run){
  return String(run?.path??'').replace(/@refs\/[^\s]+$/,'')===FULL_WORKFLOW_PATH&&
    run.repository?.full_name===REPO&&run.head_repository?.full_name===REPO&&
    run.head_branch==='main'&&['schedule','workflow_dispatch'].includes(run.event)&&
    Number.isSafeInteger(run.id)&&run.id>0&&
    Number.isSafeInteger(run.run_attempt)&&run.run_attempt>0&&
    SHA.test(run.head_sha??'');
}

// Only attempt-scoped GitHub job state counts. An admission-only successful
// Workflow Run whose "full" job was skipped cannot reset the cadence.
export async function inspectMainFullHistory({
  repo=REPO,currentRunId,get,pageSize=20,maxPages=9
}){
  if(repo!==REPO||!Number.isSafeInteger(currentRunId)||currentRunId<1||typeof get!=='function')
    throw Error('invalid Main Full history read scope');
  if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>20||
    !Number.isSafeInteger(maxPages)||maxPages<1||maxPages>9)
    throw Error('invalid Main Full history scan bounds');
  let lastScheduledFullCompletedAt=null;
  let runsInspected=0;
  let pagesInspected=0;
  for(let page=1;page<=maxPages;page++){
    const q=new URLSearchParams({branch:'main',per_page:String(pageSize),page:String(page)});
    const response=await get('/repos/'+repo+'/actions/workflows/e2e-full-regression.yml/runs?'+q);
    if(!Array.isArray(response?.workflow_runs)||response.workflow_runs.length>pageSize)
      throw Error('invalid or unbounded Main Full workflow history');
    const runs=response.workflow_runs;
    pagesInspected++;
    let foundScheduledFullOnPage=false;
    for(const run of runs){
      runsInspected++;
      // Exclude the admission run currently evaluating its own decision.
      if(run?.id===currentRunId||!canonicalMainFullRun(run))continue;
      const jobsResponse=await get('/repos/'+repo+'/actions/runs/'+run.id+
        '/attempts/'+run.run_attempt+'/jobs?per_page=100');
      if(!Array.isArray(jobsResponse?.jobs)||jobsResponse.jobs.length>100)
        throw Error('invalid or unbounded Full job history');
      const matches=jobsResponse.jobs.filter(job=>job.name==='full');
      if(matches.length===0)continue;
      if(matches.length!==1)throw Error('ambiguous Full job for workflow run '+run.id);
      const job=matches[0];
      if(job.run_id!==run.id||job.run_attempt!==run.run_attempt||job.head_sha!==run.head_sha)
        throw Error('Full job/run attempt identity mismatch for workflow run '+run.id);
      // Even a manual/historical Full run blocks overlap while active.
      if(job.status==='queued'||job.status==='in_progress'){
        return {lastScheduledFullCompletedAt,fullInFlight:true,
          inFlightRunId:run.id,inFlightRunAttempt:run.run_attempt,
          pagesInspected,runsInspected};
      }
      if(job.status!=='completed')throw Error('unexpected Full job status for workflow run '+run.id);
      // Manual workflow_dispatch may target an old SHA: it blocks overlap but
      // does not reset the periodic Main cadence.
      if(run.event!=='schedule'||job.conclusion==='skipped')continue;
      const startedMs=Date.parse(job.started_at??'');
      const completedMs=Date.parse(job.completed_at??'');
      if(!Number.isFinite(startedMs)||!Number.isFinite(completedMs)||completedMs<startedMs)
        throw Error('invalid actual scheduled Full job timestamps for run '+run.id);
      const completedAt=new Date(completedMs).toISOString();
      if(lastScheduledFullCompletedAt===null||
        completedMs>Date.parse(lastScheduledFullCompletedAt))
        lastScheduledFullCompletedAt=completedAt;
      foundScheduledFullOnPage=true;
    }
    // Runs are returned newest-first. Inspect the whole page for overlapping
    // work, then stop when the latest page containing a real Full is complete.
    if(foundScheduledFullOnPage||runs.length<pageSize)break;
  }
  return {lastScheduledFullCompletedAt,fullInFlight:false,
    inFlightRunId:null,inFlightRunAttempt:null,pagesInspected,runsInspected};
}

function allowedHistoryRequest(path){
  if(typeof path!=='string')return false;
  const runsPrefix='/repos/'+REPO+'/actions/workflows/'+FULL_WORKFLOW_PATH.split('/').pop()+'/runs?';
  if(path.startsWith(runsPrefix))return true;
  const [pathname,query,...rest]=path.split('?');
  if(rest.length||query!=='per_page=100')return false;
  const parts=pathname.split('/');
  const runsAt=parts.indexOf('runs');
  return parts.length===10&&parts[1]==='repos'&&parts[2]==='BestNathan'&&
    parts[3]==='nession'&&parts[4]==='actions'&&runsAt===5&&
    /^[1-9][0-9]*$/.test(parts[6]??'')&&parts[7]==='attempts'&&
    /^[1-9][0-9]*$/.test(parts[8]??'')&&parts[9]==='jobs';
}

async function githubActionsGet(path){
  const token=String(process.env.GH_TOKEN??process.env.GITHUB_TOKEN??'').trim();
  if(!token)throw Error('read-only GitHub Actions token is required for schedule admission');
  if(!allowedHistoryRequest(path))throw Error('refused GitHub API read outside Main Full history scope');
  const response=await fetch('https://api.github.com'+path,{
    method:'GET',
    headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,
      'X-GitHub-Api-Version':'2022-11-28'},
  });
  const body=await response.text();
  if(!response.ok)throw Error('GitHub Actions history API failed with HTTP '+response.status);
  if(body.length>4*1024*1024)throw Error('GitHub Actions history response exceeded size bound');
  try{return JSON.parse(body);}catch{throw Error('GitHub Actions history returned invalid JSON');}
}

export function stagingEligibility({ ready, attested, mainSha, deployedSha, ahead, behind }) {
  if (ready !== true) return { decision: 'NOT_READY' };
  if (attested !== true || !SHA.test(mainSha || '') || !SHA.test(deployedSha || '')) {
    return { decision: 'INDETERMINATE', reason: 'deployed identity not authenticated' };
  }
  if (!Number.isSafeInteger(ahead) || ahead < 0 || !Number.isSafeInteger(behind) || behind < 0) {
    return { decision: 'INDETERMINATE', reason: 'ancestry cannot be proven' };
  }
  if (ahead === 0) return { decision: 'SKIPPED_NOT_AHEAD', ahead, behind };
  return { decision: 'ELIGIBLE', ahead, behind, diverged: behind > 0 };
}

export function countAncestry(mainSha, deployedSha, exec = execFileSync) {
  if (!SHA.test(mainSha) || !SHA.test(deployedSha)) throw new Error('untrusted source SHA');
  // Requires complete (non-shallow) Git history; failures cannot turn into skip/pass.
  const count = (range) => {
    const output = exec('git', ['rev-list', '--count', range], { encoding: 'utf8' }).trim();
    if (!/^[0-9]+$/.test(output)) throw new Error('invalid Git ancestry count');
    return Number(output);
  };
  return { ahead: count(mainSha + '..' + deployedSha), behind: count(deployedSha + '..' + mainSha) };
}

async function historySelfTest(){
  const sha='a'.repeat(40);
  const mkRun=(id,event='schedule',status='completed')=>({
    id,run_attempt:1,status,conclusion:status==='completed'?'success':null,
    path:FULL_WORKFLOW_PATH,event,head_branch:'main',head_sha:sha,
    repository:{full_name:REPO},head_repository:{full_name:REPO},
  });
  const mkJob=(id,status='completed',conclusion='skipped',startedAt=null,completedAt=null)=>({
    id:id+1000,name:'full',run_id:id,run_attempt:1,head_sha:sha,status,conclusion,
    started_at:startedAt,completed_at:completedAt,
  });
  const firstPage=Array.from({length:20},(_,i)=>mkRun(500-i));
  const fullRun=mkRun(470,'schedule','completed');
  const pages=[],jobReads=[];
  const history=await inspectMainFullHistory({repo:REPO,currentRunId:500,pageSize:20,
    get:async(requestPath)=>{
      const url=new URL(requestPath,'https://api.github.com');
      if(url.pathname.endsWith('/workflows/e2e-full-regression.yml/runs')){
        const page=Number(url.searchParams.get('page'));
        pages.push(page);
        return {workflow_runs:page===1?firstPage:page===2?[fullRun]:[]};
      }
      const parts=url.pathname.split('/');
      const runsAt=parts.indexOf('runs');
      const runId=Number(parts[runsAt+1]);
      jobReads.push(runId);
      if(runsAt<0||parts[runsAt+2]!=='attempts'||parts[runsAt+4]!=='jobs')
        throw Error('unexpected history API path: '+requestPath);
      if(runId===470)return {jobs:[mkJob(470,'completed','failure',
        '2026-10-24T00:20:00Z','2026-10-24T01:00:00Z')]};
      return {jobs:[{...mkJob(runId),name:'admit',id:runId+2000},
        mkJob(runId,'completed','skipped')]};
    }
  });
  assert.deepEqual(pages,[1,2]);
  assert.equal(history.lastScheduledFullCompletedAt,'2026-10-24T01:00:00.000Z',
    'a completed failed Full attempt resets cadence but never becomes Pass');
  assert.equal(history.fullInFlight,false);
  assert.equal(history.runsInspected,21);
  assert.equal(jobReads.length,20);
  assert.equal(jobReads.includes(500),false,'the current admission run is not overlapping Full work');
  const activeRun=mkRun(900,'workflow_dispatch','in_progress');
  const active=await inspectMainFullHistory({repo:REPO,currentRunId:901,
    get:async(requestPath)=>{
      const url=new URL(requestPath,'https://api.github.com');
      if(url.pathname.endsWith('/workflows/e2e-full-regression.yml/runs'))
        return {workflow_runs:[activeRun]};
      return {jobs:[mkJob(900,'in_progress',null,'2026-10-24T02:00:00Z',null)]};
    }
  });
  assert.equal(active.fullInFlight,true,'manual Full jobs also prevent overlap');
  assert.equal(active.inFlightRunId,900);
  await assert.rejects(()=>inspectMainFullHistory({repo:REPO,currentRunId:1,
    get:async()=>({workflow_runs:[]}),pageSize:21}));
  console.log('Main Full schedule recovery: bounded pagination, skipped admission, failed-attempt cadence, and in-flight exclusion passed');
}

async function selfTest(){
  assert.deepEqual(config({}),{staging:2,main:12,lanes:{}});
  assert.deepEqual(config({E2E_STAGING_INTERVAL_HOURS:'3',E2E_MAIN_INTERVAL_HOURS:'24',
    E2E_STAGING_LANE_INTERVALS_JSON:'{"staging-01":6}'}),
    {staging:3,main:24,lanes:{'staging-01':6}});
  for(const raw of ['-1','0','2.5','abc','169','01'])assert.throws(()=>interval(raw,2));
  assert.throws(()=>config({E2E_STAGING_LANE_INTERVALS_JSON:'[]'}));
  assert.throws(()=>config({E2E_STAGING_LANE_INTERVALS_JSON:'{"../../secret":2}'}));

  const recent=mainScheduleDecision({now:'2026-10-24T20:00:00Z',
    intervalHours:12,lastFullCompletedAt:'2026-10-24T09:00:00Z'});
  assert.equal(recent.decision,'NOT_DUE');
  assert.equal(recent.next_due_at,'2026-10-24T21:00:00.000Z');
  const delayed=mainScheduleDecision({now:'2026-10-24T22:37:00Z',
    intervalHours:12,lastFullCompletedAt:'2026-10-24T09:00:00Z'});
  assert.equal(delayed.decision,'ELIGIBLE');
  assert.equal(delayed.run,true);
  assert.equal(mainScheduleDecision({now:'2026-10-24T10:00:00Z',intervalHours:12}).reason,
    'NO_SCHEDULED_FULL_HISTORY');
  assert.equal(mainScheduleDecision({now:'2026-10-24T22:37:00Z',intervalHours:12,
    lastFullCompletedAt:'2026-10-24T09:00:00Z',fullInFlight:true}).decision,'FULL_IN_FLIGHT');
  assert.throws(()=>mainScheduleDecision({now:'not-a-time',intervalHours:12}));
  assert.throws(()=>mainScheduleDecision({now:'2026-10-24T00:00:00Z',intervalHours:169}));
  assert.throws(()=>mainScheduleDecision({now:'2026-10-24T00:00:00Z',
    intervalHours:12,lastFullCompletedAt:'invalid'}));

  const a='a'.repeat(40),b='b'.repeat(40);
  const eligible=data=>stagingEligibility({ready:true,attested:true,mainSha:a,deployedSha:b,...data});
  assert.equal(eligible({ahead:0,behind:0}).decision,'SKIPPED_NOT_AHEAD');
  assert.equal(eligible({ahead:0,behind:2}).decision,'SKIPPED_NOT_AHEAD');
  assert.deepEqual(eligible({ahead:3,behind:1}),{decision:'ELIGIBLE',ahead:3,behind:1,diverged:true});
  assert.equal(eligible({ahead:2,behind:0,attested:false}).decision,'INDETERMINATE');
  assert.equal(eligible({ahead:null,behind:0}).decision,'INDETERMINATE');
  assert.deepEqual(countAncestry(a,b,(_,args)=>args[2]===a+'..'+b?'4\n':'2\n'),{ahead:4,behind:2});
  assert.throws(()=>countAncestry('main',b));
  await historySelfTest();
  console.log('e2e-regression-policy self-test: PASS');
}

async function main(){
  const action=process.argv[2];
  if(action==='self-test')return await selfTest();
  const cfg=config();
  if(action==='admit-main'){
    const currentRunId=Number(process.env.GITHUB_RUN_ID);
    const history=await inspectMainFullHistory({repo:REPO,currentRunId,get:githubActionsGet});
    const decision=mainScheduleDecision({now:new Date().toISOString(),intervalHours:cfg.main,
      lastFullCompletedAt:history.lastScheduledFullCompletedAt,fullInFlight:history.fullInFlight});
    const result={...decision,history};
    if(process.env.GITHUB_OUTPUT){
      fs.appendFileSync(process.env.GITHUB_OUTPUT,
        'run='+String(decision.run)+'\n'+
        'decision='+decision.decision+'\n'+
        'interval_hours='+cfg.main+'\n'+
        'last_full_completed_at='+(decision.last_full_completed_at??'')+'\n'+
        'next_due_at='+(decision.next_due_at??'')+'\n');
    }
    console.log(JSON.stringify(result));
    return;
  }
  if(action==='staging-ancestry'){
    const [mainSha,deployedSha]=process.argv.slice(3);
    const counts=countAncestry(mainSha,deployedSha);
    console.log(JSON.stringify(stagingEligibility({
      ready:true,attested:false,mainSha,deployedSha,...counts
    })));
    return;
  }
  throw new Error('usage: self-test | admit-main | staging-ancestry');
}

if(process.argv[1]?.endsWith('e2e-regression-policy.mjs')){
  main().catch(error=>{
    console.error('e2e-regression-policy: '+error.message);
    process.exitCode=2;
  });
}
