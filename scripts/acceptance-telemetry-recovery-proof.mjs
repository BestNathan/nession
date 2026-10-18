#!/usr/bin/env node
// Read-only, independently authenticated historical Metrics recovery evidence.
// Criterion pins are discovery hints only. Never turn Issue claims into verdicts.
import assert from 'node:assert/strict';
import {verifyWake} from './agent-evidence-waker.mjs';

const REPO='BestNathan/nession', SHA=/^[a-f0-9]{40}$/;
const workflow=file=>'.github/workflows/'+file;
function fail(message){throw Error('historical Metrics recovery: '+message);}
function ts(s){const n=Date.parse(s);if(!Number.isFinite(n))fail('invalid source timestamp');return n;}
function expectRun(run,id,name,file,event,conclusion,sha=null){
  if(run?.id!==id||run?.repository?.full_name!==REPO||
     run?.head_repository?.full_name!==REPO||run?.head_branch!=='main'||
     run?.name!==name||run?.path!==workflow(file)||run?.event!==event||
     run?.status!=='completed'||run?.conclusion!==conclusion||
     !SHA.test(run?.head_sha??'')||(sha!==null&&run.head_sha!==sha)||
     !Number.isSafeInteger(run?.run_attempt)||run.run_attempt<=0)
    fail('untrusted run '+name+' / '+id);
  return run;
}
function expectJob(response,run,name){
  if(!Array.isArray(response?.jobs)||response.jobs.length>100)fail('untrusted job listing');
  const matches=response.jobs.filter(j=>j.name===name);
  if(matches.length!==1)fail('missing or duplicate job '+name);
  const j=matches[0];
  if(j.run_id!==run.id||j.run_attempt!==run.run_attempt||
     j.status!=='completed'||j.conclusion!=='success'||
     !Number.isSafeInteger(j.id)||j.id<=0)
    fail('untrusted job result '+name);
  return j.id;
}
function logged(log,key,val){
  const expected=key+': '+val;
  if(!log.split('\n').some(l=>/^20\d\d-\d\d-\d\dT\S+Z\s+/.test(l)&&
       l.trimEnd().endsWith(expected)))
    fail('missing trusted job environment '+key);
}
export function recoveryPins(body){
  const section=String(body??'').match(/###? Success Criteria\s*\n([\s\S]*?)(?=\n## |$)/)?.[1]??'';
  const lines=section.split('\n').filter(l=>/^- \[[ x]\] SC-\d+\b/.test(l)&&
    l.includes('Historical recovery discovery constraint:'));
  if(lines.length===0)return null;
  if(lines.length!==1)fail('too many historical recovery pins');
  const patterns=[
    /Provider Run ([1-9]\d*) attempt ([1-9]\d*)/,
    /Scheduled Metrics Run ([1-9]\d*)/,
    /Cancelled Ingest Runs ([1-9]\d*) and ([1-9]\d*)/,
    /Recovery Ingest Run ([1-9]\d*)/,
    /Wake Orchestrator Run ([1-9]\d*)/,
  ];
  const matches=patterns.map(re=>lines[0].match(re));
  if(matches.some(m=>!m))fail('incomplete historical recovery discovery pins');
  const x=matches.flatMap(m=>m.slice(1).map(Number));
  if(x.some(n=>!Number.isSafeInteger(n)||n<=0)||
     new Set([x[0],x[2],x[3],x[4],x[5],x[6]]).size!==6)
    fail('invalid historical recovery IDs');
  return {provider:x[0],attempt:x[1],scheduled:x[2],cancelled:[x[3],x[4]],
    recovered:x[5],wake:x[6]};
}
export function attestRecovery(pins,o,metricsRoot,ancestry,wakeVerifier=verifyWake){
  if(!pins||ancestry?.provider!==true||ancestry?.recovery!==true)
    fail('Git-verified main ancestry required');
  const p=expectRun(o.provider,pins.provider,'Agent / Provider Smoke',
    'agent-provider-smoke.yml','push','success');
  if(p.run_attempt!==pins.attempt)fail('source attempt mismatch');
  const s=expectRun(o.scheduled,pins.scheduled,'Metrics / Repository Health',
    'metrics-repository.yml','schedule','success',p.head_sha);
  if(!Array.isArray(o.cancelled)||o.cancelled.length!==2)
    fail('two cancelled Ingest sources required');
  const cancelled=o.cancelled.map((run,i)=>expectRun(run,pins.cancelled[i],
    'Metrics / Agent Telemetry Ingest','metrics-agent-telemetry.yml',
    'workflow_run','cancelled',p.head_sha));
  for(const c of cancelled){
    if(ts(p.updated_at)>ts(c.created_at)||ts(s.created_at)>ts(c.created_at)||
       ts(c.updated_at)>ts(s.updated_at))
      fail('scheduled writer and cancelled pending ingest did not overlap');
  }
  const r=expectRun(o.recovered,pins.recovered,'Metrics / Agent Telemetry Ingest',
    'metrics-agent-telemetry.yml','workflow_run','success');
  const w=expectRun(o.wake,pins.wake,'Acceptance / Orchestrator',
    'acceptance-orchestrator.yml','repository_dispatch','success',r.head_sha);
  if(ts(r.created_at)<ts(s.updated_at)||ts(w.created_at)<ts(r.created_at))
    fail('recovery/wake ordering mismatch');
  const writer=expectJob(o.recoveryJobs,r,'ingest');
  const prepare=expectJob(o.wakeJobs,w,'prepare-post-merge-provider-evidence');
  const execute=expectJob(o.wakeJobs,w,
    'post-merge-provider-evidence-acceptance (1728) / Execute acceptance');
  const updater=expectJob(o.wakeJobs,w,
    'post-merge-provider-evidence-acceptance (1728) / Deterministic Issue updater');
  for(const log of [o.recoveryLog,o.wakeLog])
    if(typeof log!=='string'||log.length>1048576)fail('missing or oversized trusted log');
  logged(o.recoveryLog,'RECOVERY_RUN_ID',p.id);
  logged(o.recoveryLog,'SOURCE_RUN_ID',p.id);
  logged(o.recoveryLog,'SOURCE_RUN_ATTEMPT',p.run_attempt);
  if(!o.recoveryLog.includes('metrics: ingest agent telemetry from run '+p.id))
    fail('writer did not commit recovered source');
  const push=o.recoveryLog.split('\n').find(line=>line.includes('HEAD -> metrics')&&
    /^20\d\d-\d\d-\d\dT\S+Z/.test(line));
  if(!push||ts(push.split(' ')[0])>ts(w.created_at))
    fail('immutable Metrics push must precede wake');
  logged(o.wakeLog,'SOURCE_RUN_ID',p.id);
  logged(o.wakeLog,'SOURCE_RUN_ATTEMPT',p.run_attempt);
  logged(o.wakeLog,'SOURCE_SHA',p.head_sha);
  const verified=wakeVerifier({source_run_id:p.id,source_run_attempt:p.run_attempt,
    target_sha:p.head_sha},p,metricsRoot);
  if(!Number.isSafeInteger(verified?.matches)||verified.matches<1)
    fail('missing verified durable Metrics records');
  const loggedMatch=o.wakeLog.split('\n').some(line=>
    line.includes('"run_id":'+p.id)&&
    line.includes('"attempt":'+p.run_attempt)&&
    line.includes('"target_sha":"'+p.head_sha+'"')&&
    line.includes('"matches":'+verified.matches));
  if(!loggedMatch)fail('wake failed to verify authenticated Metrics records');
  return {kind:'verified_historical_cancelled_ingest_recovery',
    provider_run_id:p.id,provider_attempt:p.run_attempt,provider_sha:p.head_sha,
    scheduled_run_id:s.id,cancelled_ingest_ids:cancelled.map(c=>c.id),
    recovered_ingest_run_id:r.id,recovery_sha:r.head_sha,writer_job_id:writer,
    wake_run_id:w.id,wake_prepare_job_id:prepare,
    sc_execute_job_id:execute,sc_updater_job_id:updater,
    durable_metrics_matches:verified.matches,verified_git_ancestry:true,
    metrics_persisted_before_wake:true,
    scope:'historical verified delivery; not proof of every current-SHA workflow'};
}
export async function collectHistoricalRecovery({repo,issue,stage,targetSha,workspace,
  metricsRoot,request,readLog,checkAncestor}){
  if(stage!=='post-merge'||Number(issue?.number)!==1749)return null;
  if(repo!==REPO||!SHA.test(targetSha))fail('wrong repository or target SHA');
  const pins=recoveryPins(issue.body);
  if(!pins)return null;
  const ids=[pins.provider,pins.scheduled,...pins.cancelled,pins.recovered,pins.wake];
  const runs=await Promise.all(ids.map(id=>request('/repos/'+repo+'/actions/runs/'+id)));
  const [recoveryJobs,wakeJobs]=await Promise.all([
    request('/repos/'+repo+'/actions/runs/'+pins.recovered+
      '/attempts/'+runs[4].run_attempt+'/jobs?per_page=100'),
    request('/repos/'+repo+'/actions/runs/'+pins.wake+
      '/attempts/'+runs[5].run_attempt+'/jobs?per_page=100')]);
  const jobId=(response,name)=>{
    const found=(response?.jobs??[]).filter(j=>j.name===name);
    if(found.length!==1)fail('missing authentic log job '+name);
    return found[0].id;
  };
  const [recoveryLog,wakeLog]=await Promise.all([
    readLog('/repos/'+repo+'/actions/jobs/'+jobId(recoveryJobs,'ingest')+'/logs'),
    readLog('/repos/'+repo+'/actions/jobs/'+jobId(wakeJobs,
      'prepare-post-merge-provider-evidence')+'/logs')]);
  const ancestry={
    provider:checkAncestor(workspace,targetSha,runs[0].head_sha).is_ancestor===true,
    recovery:checkAncestor(workspace,targetSha,runs[4].head_sha).is_ancestor===true,
  };
  return attestRecovery(pins,{provider:runs[0],scheduled:runs[1],
    cancelled:[runs[2],runs[3]],recovered:runs[4],wake:runs[5],
    recoveryJobs,wakeJobs,recoveryLog,wakeLog},metricsRoot,ancestry);
}
export function selfTestHistoricalRecovery(){
  const body='### Success Criteria\n- [ ] SC-04 Historical recovery discovery constraint: Provider Run 321 attempt 1; Scheduled Metrics Run 322; Cancelled Ingest Runs 323 and 324; Recovery Ingest Run 325; Wake Orchestrator Run 326.\n\n## Acceptance Report';
  const pins=recoveryPins(body);
  assert.deepEqual(pins,{provider:321,attempt:1,scheduled:322,
    cancelled:[323,324],recovered:325,wake:326});
  assert.equal(recoveryPins('### Success Criteria\n- [ ] SC-01 ordinary'),null);
  assert.throws(()=>recoveryPins(body.replace('Recovery Ingest Run','Unknown Run')),/incomplete/);
  const repo={full_name:REPO},old='a'.repeat(40),current='b'.repeat(40);
  const common={repository:repo,head_repository:repo,head_branch:'main',
    status:'completed',run_attempt:1,created_at:'2026-10-14T00:00:00Z',
    updated_at:'2026-10-14T00:00:50Z'};
  const source={...common,id:321,name:'Agent / Provider Smoke',
    path:workflow('agent-provider-smoke.yml'),event:'push',conclusion:'success',
    head_sha:old,updated_at:'2026-10-14T00:00:20Z'};
  const scheduled={...common,id:322,name:'Metrics / Repository Health',
    path:workflow('metrics-repository.yml'),event:'schedule',conclusion:'success',
    head_sha:old};
  const cancelled=[323,324].map((id,i)=>({...common,id,
    name:'Metrics / Agent Telemetry Ingest',path:workflow('metrics-agent-telemetry.yml'),
    event:'workflow_run',conclusion:'cancelled',head_sha:old,
    created_at:'2026-10-14T00:00:2'+(i+1)+'Z',
    updated_at:'2026-10-14T00:00:3'+(i+1)+'Z'}));
  const recovered={...common,id:325,name:'Metrics / Agent Telemetry Ingest',
    path:workflow('metrics-agent-telemetry.yml'),event:'workflow_run',
    conclusion:'success',head_sha:current,
    created_at:'2026-10-14T01:00:00Z',updated_at:'2026-10-14T01:01:00Z'};
  const wake={...common,id:326,name:'Acceptance / Orchestrator',
    path:workflow('acceptance-orchestrator.yml'),event:'repository_dispatch',
    conclusion:'success',head_sha:current,created_at:'2026-10-14T01:00:45Z'};
  const job=(run,id,name)=>({run_id:run,run_attempt:1,id,name,
    status:'completed',conclusion:'success'});
  const recoveryJobs={jobs:[job(325,40,'ingest')]};
  const wakeJobs={jobs:[
    job(326,41,'prepare-post-merge-provider-evidence'),
    job(326,42,'post-merge-provider-evidence-acceptance (1728) / Execute acceptance'),
    job(326,43,'post-merge-provider-evidence-acceptance (1728) / Deterministic Issue updater')]};
  const recoveryLog='2026-10-14T01:00:10Z   RECOVERY_RUN_ID: 321\n'+
    '2026-10-14T01:00:11Z   SOURCE_RUN_ID: 321\n'+
    '2026-10-14T01:00:12Z   SOURCE_RUN_ATTEMPT: 1\n'+
    '2026-10-14T01:00:30Z [metrics 123abcd] metrics: ingest agent telemetry from run 321\n'+
    '2026-10-14T01:00:40Z 123..456 HEAD -> metrics\n';
  const wakeLog='2026-10-14T01:00:46Z   SOURCE_RUN_ID: 321\n'+
    '2026-10-14T01:00:47Z   SOURCE_RUN_ATTEMPT: 1\n'+
    '2026-10-14T01:00:48Z   SOURCE_SHA: '+old+'\n'+
    '2026-10-14T01:00:49Z {"run_id":321,"attempt":1,"target_sha":"'+old+'","matches":4}\n';
  const o={provider:source,scheduled,cancelled,recovered,wake,
    recoveryJobs,wakeJobs,recoveryLog,wakeLog};
  const validate=(data=o,ancestry={provider:true,recovery:true})=>
    attestRecovery(pins,data,'/tmp',ancestry,()=>({matches:4}));
  assert.equal(validate().durable_metrics_matches,4);
  assert.throws(()=>validate(o,{provider:false,recovery:true}),/ancestry/);
  assert.throws(()=>validate({...o,provider:{...source,event:'pull_request'}}),/untrusted/);
  assert.throws(()=>validate({...o,cancelled:[{...cancelled[0],conclusion:'success'},cancelled[1]]}),/untrusted/);
  assert.throws(()=>validate({...o,recoveryLog:recoveryLog.replace('RECOVERY_RUN_ID: 321','RECOVERY_RUN_ID: 999')}),/RECOVERY_RUN_ID/);
  assert.throws(()=>validate({...o,recoveryLog:recoveryLog.replace('HEAD -> metrics','no commit')}),/push/);
  assert.throws(()=>validate({...o,wakeLog:wakeLog.replace('"matches":4','"matches":0')}),/wake/);
  assert.throws(()=>validate({...o,wakeJobs:{jobs:wakeJobs.jobs.slice(0,2)}}),/job/);
  console.log('historical Metrics recovery exact-source, cross-SHA and negative fixtures passed');
}
