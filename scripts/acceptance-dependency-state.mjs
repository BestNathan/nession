#!/usr/bin/env node
// One deterministic, fail-closed source of truth for the PR Acceptance
// dependency barrier. A waiting dependency MUST NOT pass a required gate.
// Successful source completions wake only the failed or deliberately deferred
// Acceptance run at the exact PR HEAD. Neither the model nor mutable Issue
// comments decide this.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

const SHA=/^[a-f0-9]{40}$/;
const FINISHED=new Set(['success','failure','cancelled','timed_out','action_required','skipped','neutral']);
const ACTIVE=new Set(['queued','pending','in_progress','requested','waiting']);
const ORCHESTRATOR='.github/workflows/acceptance-orchestrator.yml';
const ADMISSION_STEP='Classify exact-head source barrier';
const MAX_ATTEMPTS=3;

export function classifyDependency(runs,sha,applicable=true) {
  if(typeof applicable!=='boolean')throw Error('invalid source applicability');
  if(!SHA.test(sha)||!Array.isArray(runs)||runs.length>20)throw Error('invalid source run window');
  // An absent run is explicit `not-required` only when the exact diff proves
  // the source cannot observe this change. Any real run always wins: a source
  // that executed is applicable regardless of the derived path list.
  if(!runs.length)return applicable
    ? {state:'waiting',reason:'no_source_run'}
    : {state:'not_required',reason:'no_applicable_change'};
  const run=runs[0]; // gh run list is newest-first; never fall back to an older green run
  if(!Number.isSafeInteger(run?.databaseId)||run.databaseId<=0||
     typeof run.headSha!=='string'||!SHA.test(run.headSha)||
     run.event!=='pull_request'||typeof run.status!=='string')
    throw Error('untrusted source run identity');
  if(run.headSha!==sha)return {state:'superseded',reason:'foreign_sha',run_id:run.databaseId};
  if(ACTIVE.has(run.status)){
    if(run.conclusion!=null&&run.conclusion!=='')throw Error('in-progress run claims terminal verdict');
    return {state:'waiting',reason:'source_in_progress',run_id:run.databaseId};
  }
  if(run.status!=='completed'||!FINISHED.has(run.conclusion))
    throw Error('unknown source run state or conclusion');
  return {state:run.conclusion==='success'?'ready':'blocked',
    reason:run.conclusion,run_id:run.databaseId};
}
export function classifyPrDependencies(quality,e2e,sha,applicability={}) {
  if(applicability===null||typeof applicability!=='object')
    throw Error('invalid source applicability');
  const q=classifyDependency(quality,sha,applicability.quality??true);
  const e=classifyDependency(e2e,sha,applicability.e2e??true);
  const states=[q.state,e.state];
  const state=states.includes('superseded')?'superseded':
    states.includes('blocked')?'blocked':states.includes('waiting')?'waiting':'ready';
  return {state,quality:q,e2e:e};
}
// Only replay the original exact-HEAD failed Acceptance run. A concurrent
// duplicate completion event sees in_progress/completed-success and is a no-op.
export function shouldReplayFailedAcceptance(barrier,run,sha) {
  if(!SHA.test(sha)||!barrier||!['waiting','ready','blocked','superseded'].includes(barrier.state))
    throw Error('invalid dependency barrier');
  if(!Number.isSafeInteger(run?.id)||run.id<=0||run.head_sha!==sha||
     run.event!=='pull_request_target'||run.path!==ORCHESTRATOR)
    throw Error('untrusted Acceptance source identity');
  if(barrier.state!=='ready')return false;
  if(ACTIVE.has(run.status))return false; // duplicate wake during a replay
  if(run.status!=='completed'||!FINISHED.has(run.conclusion))
    throw Error('invalid Acceptance run state');
  return run.conclusion==='failure'; // success/skip/cancel remain terminal
}
// The initial PR event deliberately defers without evaluating: it must report
// neither a passing acceptance gate nor a transient failure. Such a run is
// cancelled on purpose and may be replayed only when the exact-attempt job
// evidence proves the trusted prepare classifier ran and the source barrier is
// independently ready at the same SHA.
export function isDeferredRun(jobsResponse,run,sha) {
  if(!SHA.test(sha)||!Number.isSafeInteger(run?.id)||run.id<=0||run.head_sha!==sha||
     run.event!=='pull_request_target'||run.path!==ORCHESTRATOR)
    throw Error('untrusted deferred Acceptance run identity');
  if(run.status!=='completed'||run.conclusion!=='cancelled')return false;
  if(!Number.isSafeInteger(run.run_attempt)||run.run_attempt<1||run.run_attempt>=MAX_ATTEMPTS)
    return false;
  if(!jobsResponse||!Array.isArray(jobsResponse.jobs)||jobsResponse.jobs.length>100||
     !Number.isSafeInteger(jobsResponse.total_count)||
     jobsResponse.total_count!==jobsResponse.jobs.length)
    throw Error('untrusted deferred job evidence');
  const prepare=jobsResponse.jobs.find((job)=>job.name==='prepare-pre-merge');
  const defer=jobsResponse.jobs.find((job)=>job.name==='defer-pre-merge');
  if(!prepare||prepare.conclusion!=='success')return false;
  if(!defer||!['success','cancelled'].includes(defer.conclusion))return false;
  const admission=(prepare.steps??[]).find((step)=>step.name===ADMISSION_STEP);
  return Boolean(admission&&admission.conclusion==='success');
}
function selfTest() {
  const sha='a'.repeat(40),other='b'.repeat(40);
  const good={databaseId:100,headSha:sha,event:'pull_request',status:'completed',conclusion:'success'};
  const failed={...good,databaseId:101,conclusion:'failure'};
  assert.equal(classifyPrDependencies([good],[good],sha).state,'ready');
  assert.equal(classifyPrDependencies([], [good],sha).state,'waiting');
  assert.equal(classifyPrDependencies([{...good,status:'in_progress',conclusion:null}], [good],sha).state,'waiting');
  assert.equal(classifyPrDependencies([failed],[good],sha).state,'blocked');
  assert.equal(classifyPrDependencies([good],[{...good,headSha:other}],sha).state,'superseded');
  assert.equal(classifyPrDependencies([failed,good],[good],sha).state,'blocked','old green must not override newest failure');
  assert.throws(()=>classifyPrDependencies([good,{...good}],[],other.repeat(2)),/invalid source/);
  for(const bogus of [
    {...good,event:'push'}, {...good,databaseId:0},{...good,status:'completed',conclusion:null},
    {...good,status:'in_progress',conclusion:'success'},{...good,status:'mystery'},
    {...good,headSha:'head'}
  ])assert.throws(()=>classifyDependency([bogus],sha));
  // Applicability: an absent, inapplicable source is explicit not-required and
  // never blocks. A real run always overrides the derived path list, and an
  // applicable-but-absent source remains waiting (never inferred Pass).
  const none=classifyPrDependencies([],[],sha,{quality:false,e2e:false});
  assert.equal(none.state,'ready');
  assert.equal(none.quality.state,'not_required');
  assert.equal(none.e2e.state,'not_required');
  assert.equal(classifyPrDependencies([good],[],sha,{e2e:false}).state,'ready');
  assert.equal(classifyPrDependencies([],[],sha,{quality:false}).state,'waiting');
  assert.equal(classifyPrDependencies([],[failed],sha,{quality:false}).state,'blocked',
    'a real failed run is not hidden by inapplicable paths');
  assert.equal(classifyDependency([good],sha,false).state,'ready',
    'a source that executed is applicable regardless of paths');
  assert.throws(()=>classifyPrDependencies([],[],sha,{e2e:'no'}),/applicability/);
  assert.throws(()=>classifyPrDependencies([],[],sha,null),/applicability/);
  const barrier=classifyPrDependencies([good],[good],sha);
  const acceptance={id:301,head_sha:sha,event:'pull_request_target',
    path:ORCHESTRATOR,status:'completed',conclusion:'failure'};
  assert.equal(shouldReplayFailedAcceptance(barrier,acceptance,sha),true);
  assert.equal(shouldReplayFailedAcceptance(barrier,{...acceptance,status:'in_progress',conclusion:null},sha),false,
    'duplicate completion wake must not re-dispatch during replay');
  assert.equal(shouldReplayFailedAcceptance(barrier,{...acceptance,status:'completed',conclusion:'success'},sha),false,
    'successful replay is idempotent');
  assert.equal(shouldReplayFailedAcceptance(barrier,{...acceptance,status:'queued',conclusion:null},sha),false);
  assert.equal(shouldReplayFailedAcceptance({state:'waiting'},acceptance,sha),false,
    'race: E2E still running despite Quality completion');
  assert.equal(shouldReplayFailedAcceptance({state:'blocked'},acceptance,sha),false);
  assert.equal(shouldReplayFailedAcceptance({state:'superseded'},acceptance,sha),false);
  for(const tampered of [{...acceptance,id:0},{...acceptance,head_sha:other},
    {...acceptance,event:'push'},{...acceptance,path:'untrusted.yml'}])
    assert.throws(()=>shouldReplayFailedAcceptance(barrier,tampered,sha),/untrusted/);
  // Deliberate deferral evidence, including attempt and identity bounds.
  const deferredRun={id:302,head_sha:sha,event:'pull_request_target',path:ORCHESTRATOR,
    status:'completed',conclusion:'cancelled',run_attempt:1};
  const prepare={name:'prepare-pre-merge',conclusion:'success',
    steps:[{name:ADMISSION_STEP,conclusion:'success'}]};
  const defer={name:'defer-pre-merge',conclusion:'cancelled'};
  const jobs=(list)=>({total_count:list.length,jobs:list});
  assert.equal(isDeferredRun(jobs([prepare,defer]),deferredRun,sha),true);
  assert.equal(isDeferredRun(jobs([prepare,{...defer,conclusion:'skipped'}]),deferredRun,sha),false,
    'a skipped defer job did not defer');
  assert.equal(isDeferredRun(jobs([{...prepare,conclusion:'failure'},defer]),deferredRun,sha),false,
    'a failed prepare is a genuine failure, not a deferral');
  assert.equal(isDeferredRun(jobs([{...prepare,steps:[]},defer]),deferredRun,sha),false,
    'missing admission step is not deferral evidence');
  assert.equal(isDeferredRun(jobs([prepare,defer]),{...deferredRun,conclusion:'success'},sha),false);
  assert.equal(isDeferredRun(jobs([prepare,defer]),{...deferredRun,run_attempt:MAX_ATTEMPTS},sha),false,
    'replay attempts are bounded');
  assert.equal(isDeferredRun(jobs([prepare,defer]),{...deferredRun,status:'in_progress',
    conclusion:null,run_attempt:1},sha),false);
  assert.throws(()=>isDeferredRun(jobs([prepare,defer]),{...deferredRun,head_sha:other},sha),/untrusted/);
  assert.throws(()=>isDeferredRun({jobs:[],total_count:1},deferredRun,sha),/untrusted/);
  console.log('Acceptance dependency barrier: ready/waiting/blocked/not-required/superseded, deferred-run replay, newest-first, foreign identity and malformed-state negatives passed');
}
function booleanFlag(name,fallback) {
  const hit=process.argv.find((arg)=>arg.startsWith(`--${name}=`));
  if(!hit)return fallback;
  const value=hit.slice(name.length+3);
  if(value!=='true'&&value!=='false')throw Error(`--${name} must be true or false`);
  return value==='true';
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.argv[2]==='self-test')selfTest();
  else if(process.argv[2]==='classify') {
    const [qualityPath,e2ePath,sha]=process.argv.slice(3);
    if(!qualityPath||!e2ePath)throw Error('classify QUALITY_JSON E2E_JSON SHA [--quality-applicable=BOOL] [--e2e-applicable=BOOL]');
    const result=classifyPrDependencies(JSON.parse(fs.readFileSync(qualityPath,'utf8')),
      JSON.parse(fs.readFileSync(e2ePath,'utf8')),sha,
      {quality:booleanFlag('quality-applicable',true),e2e:booleanFlag('e2e-applicable',true)});
    process.stdout.write(JSON.stringify(result)+'\n');
  }else if(process.argv[2]==='deferred') {
    const [jobsFile,runFile,sha]=process.argv.slice(3);
    if(!jobsFile||!runFile)throw Error('deferred JOBS_JSON ACCEPTANCE_RUN_JSON SHA');
    process.stdout.write(isDeferredRun(JSON.parse(fs.readFileSync(jobsFile,'utf8')),
      JSON.parse(fs.readFileSync(runFile,'utf8')),sha)?'true\n':'false\n');
  }else if(process.argv[2]==='replay') {
    const [barrierFile,runFile,sha]=process.argv.slice(3);
    if(!barrierFile||!runFile)throw Error('replay BARRIER_JSON ACCEPTANCE_RUN_JSON SHA');
    const barrier=JSON.parse(fs.readFileSync(barrierFile,'utf8'));
    const run=JSON.parse(fs.readFileSync(runFile,'utf8'));
    process.stdout.write(shouldReplayFailedAcceptance(barrier,run,sha)?'true\n':'false\n');
  }else throw Error('self-test | classify QUALITY_JSON E2E_JSON SHA [flags] | deferred JOBS_JSON RUN_JSON SHA | replay BARRIER_JSON ACCEPTANCE_RUN_JSON SHA');
}
