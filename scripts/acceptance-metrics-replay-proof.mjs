// #1690 SC-09: exact REST/Job-log provenance of historical successful and
// denied Metrics Replay. Pinned run IDs are candidate locators ONLY. Every
// source, consumer, attempt, workflow path, actor and job is reauthenticated.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {parseReplayDenialLog,attestReplayDenial} from './metrics-replay-denial-receipt.mjs';

const REPO='BestNathan/nession',SHA=/^[a-f0-9]{40}$/;
const SOURCE_WORKFLOW='.github/workflows/metrics-replay-request.yml';
const CONSUMER_WORKFLOW='.github/workflows/metrics-repository.yml';
const positive=Object.freeze({
  source:38946994222,consumer:38947016290,
  sha:'da27edb59b2ac480ffe56bdbb2c08631b9a68bc2',
  source_workflow_id:385795701,
  source_attempt:1,consumer_attempt:1,
});
const negatives=Object.freeze([
  // Live GET /actions/runs/41612523346/attempts/1 is completed/skipped:
  // the off-main request's own job is skipped, while trusted-main Authorizer
  // later rejects this push source and the privileged Publisher remains skipped.
  Object.freeze({source:41612523346,consumer:41612550381,
    case:'off_main_canonical_path_unexpected_push',
    event:'push',conclusion:'skipped',reason:'unexpected_source_event'}),
  Object.freeze({source:41617665993,consumer:41617692764,
    case:'off_main_spoofed_display_name_wrong_workflow_id_and_path',
    event:'push',conclusion:'success',reason:'unexpected_source_event'}),
  // Both were real owner-triggered GitHub workflow_dispatch requests
  // selecting an off-main ref of the ORIGINAL canonical workflow, which was
  // skipped by its own trust check. In both cases the *trusted main consumer*
  // nevertheless received workflow_run and denied before its App Publisher.
  // They demonstrate actual off-main dispatch denial, NOT a wrong-ID
  // workflow_dispatch attack or a fabricated attempt/digest.
  Object.freeze({source:38946898151,consumer:38946907594,
    case:'off_main_owner_manual_dispatch_same_source_sha',
    event:'workflow_dispatch',conclusion:'skipped',reason:'untrusted_source'}),
  Object.freeze({source:38932756286,consumer:38932765400,
    case:'off_main_owner_manual_dispatch_foreign_source_sha',
    event:'workflow_dispatch',conclusion:'skipped',reason:'untrusted_source'}),
]);
// #2741: the distinct live boundary is a workflow_dispatch-only workflow that
// shares the canonical display name but exists only on an off-main branch with
// a different Workflow ID/path. Its successful owner-triggered source run
// completed without waking the main consumer; the deterministic guard fixture
// covers the identity rejection that a dispatchable consumer would have used.
const spoof=Object.freeze({
  source:42558506660,source_attempt:1,
  workflow_id:411676818,
  workflow_path:'.github/workflows/2741-spoof-replay-request.yml',
  branch:'test/2741-spoof-replay-request',
  sha:'8f19beac83acde22d779d84f88154380319d2483',
  main_sha:'453e94913625a69778d02e089ba6f33eb69633f2',
});
// The single new owner/main replay after the exact-Attempt fix (#2738), and
// the bounded interval in which a spoof-triggered consumer would have appeared.
const admissionReplay=Object.freeze({
  source:42558657133,source_attempt:1,
  consumer:42558670579,consumer_attempt:1,
  sha:'29eb0217765ee860fa1675582b45ac98c484420d',
  source_workflow_id:385795701,
  suppression_window:Object.freeze({
    start:'2026-11-09T03:50:03Z',end:'2026-11-09T03:51:41Z',
  }),
});
const allowedNames=['authorize-replay','rust-health','web-health','e2e-health','publish'];
const fail=x=>{throw Error('authenticated Metrics replay: '+x);};
const normalized=r=>String(r?.path??'').replace(/@refs\/heads\/main$/,'');
const validRun=(r,id)=>r?.id===id&&r?.status==='completed'&&
  Number.isSafeInteger(r.run_attempt)&&r.run_attempt>0&&
  r.repository?.full_name===REPO&&r.head_repository?.full_name===REPO&&
  SHA.test(r.head_sha??'');
// A GitHub run's top-level `run_attempt` and `updated_at` change when
// someone re-runs it. Historical evidence MUST fetch the ORIGINAL attempt
// object, not the mutable latest-run locator. This matters for an actual
// Owner replay source: Run 38946994222 was rerun on 2026-11-03 (Attempt 2),
// while its authorized main consumer 38947016290 belongs to Attempt 1.
export function pinnedHistoricalAttemptEndpoint(runId,attempt=1){
  if(!Number.isSafeInteger(runId)||runId<=0||
     !Number.isSafeInteger(attempt)||attempt<=0)
    fail('untrusted historical GitHub run/attempt locator');
  return '/repos/'+REPO+'/actions/runs/'+runId+'/attempts/'+attempt;
}
function originalJob(jobs,run,name){
  if(!Array.isArray(jobs?.jobs)||jobs.jobs.length!==5||
    new Set(jobs.jobs.map(j=>j.name)).size!==5||
    jobs.jobs.some(j=>!allowedNames.includes(j.name)||
      j.run_id!==run.id||j.run_attempt!==run.run_attempt||
      j.head_sha!==run.head_sha||j.status!=='completed'))
    fail('untrusted or incomplete exact-attempt consumer Jobs');
  const found=jobs.jobs.filter(j=>j.name===name);
  if(found.length!==1||!Number.isSafeInteger(found[0].id))fail('missing/ambiguous consumer Job');
  return found[0];
}
export function attestPositiveReplay(source,recipient,jobs,authLog,ancestor,pin=positive){
  if(!validRun(source,pin.source)||!validRun(recipient,pin.consumer)||
    source.head_sha!==pin.sha||recipient.head_sha!==pin.sha||
    source.run_attempt!==pin.source_attempt||
    recipient.run_attempt!==pin.consumer_attempt||
    source.head_branch!=='main'||source.event!=='workflow_dispatch'||
    source.name!=='Metrics / Replay Request'||
    normalized(source)!==SOURCE_WORKFLOW||
    source.workflow_id!==pin.source_workflow_id||
    source.actor?.login!=='BestNathan'||
    source.triggering_actor?.login!=='BestNathan'||
    source.conclusion!=='success'||
    recipient.head_branch!=='main'||recipient.event!=='workflow_run'||
    recipient.conclusion!=='success'||recipient.name!=='Metrics / Repository Health'||
    normalized(recipient)!==CONSUMER_WORKFLOW||
    ancestor!==true||
    !Number.isFinite(Date.parse(source.updated_at))||
    !Number.isFinite(Date.parse(recipient.created_at))||
    Date.parse(source.updated_at)>Date.parse(recipient.created_at))
    fail('untrusted successful owner/main Replay source or SHA ancestry');
  for(const name of allowedNames){
    if(originalJob(jobs,recipient,name).conclusion!=='success')
      fail('successful Replay did not complete dependency or Publisher: '+name);
  }
  const publisher=originalJob(jobs,recipient,'publish');
  const checked=['Mint scoped App token for orphan Run Store updates',
    'Reject unrecognized writer mode or unavailable App token',
    'Publish durable metrics branch',
    'Verify immutable Git bytes before uploading Run Store receipts'];
  if(!Array.isArray(publisher.steps)||publisher.steps.length>100||
    checked.some(name=>{
      const found=publisher.steps.filter(step=>step.name===name);
      return found.length!==1||found[0].status!=='completed'||found[0].conclusion!=='success';
    }))fail('successful Replay cannot prove App token, CAS publication and receipt steps');
  const authorizer=originalJob(jobs,recipient,'authorize-replay');
  if(authorizer.conclusion!=='success'||typeof authLog!=='string'||authLog.length>1048576)
    fail('untrusted successful Authorizer original Job log');
  const matches=authLog.split(/\r?\n/).filter(line=>
    line.includes('{"status":"authorized","mode":"owner_main_manual_replay"'));
  if(matches.length!==1)fail('missing or ambiguous actual owner-main authorization log');
  const frame=matches[0].match(/\{"status":"authorized","mode":"owner_main_manual_replay"[^\n]*\}/);
  if(!frame)fail('malformed authenticated authorization log');
  const statement=JSON.parse(frame[0]);
  if(statement.status!=='authorized'||
    statement.mode!=='owner_main_manual_replay'||
    statement.repository!==REPO||
    statement.source_run_id!==source.id||
    statement.source_attempt!==source.run_attempt||
    statement.source_sha!==source.head_sha||
    statement.workflow_id!==source.workflow_id)
    fail('trusted main Authorizer log disagrees with independent source REST');
  return Object.freeze({
    kind:'verified_authorized_metrics_replay',repository:REPO,
    source_run_id:source.id,source_attempt:source.run_attempt,
    source_sha:source.head_sha,source_workflow_id:source.workflow_id,
    source_workflow_path:SOURCE_WORKFLOW,
    source_event:source.event,source_actor:source.actor.login,
    recipient_run_id:recipient.id,recipient_attempt:recipient.run_attempt,
    recipient_workflow_path:CONSUMER_WORKFLOW,authorizer_job_id:authorizer.id,
    publisher_job_id:publisher.id,all_five_jobs:'completed_success',
    app_token_step:'completed_success',publisher_step:'completed_success',
    receipt_step:'completed_success',trusted_main_ancestry:true,
    proof_scope:'historical owner/main trusted replay and App-publisher steps, NOT production Ruleset denial matrix',
  });
}
// #2741 SC-02: GitHub did not dispatch a workflow_run consumer for a
// workflow_dispatch-only workflow that shares the canonical display name but
// exists only on an off-main branch with a different Workflow ID/path. The
// source identity is authenticated; the suppression is bounded to the window
// between its completion and the next owner/main replay request.
export function attestSpoofedSourceSuppression({source,workflow,consumerRuns,window}){
  if(!validRun(source,spoof.source)||source.run_attempt!==spoof.source_attempt||
     source.head_sha!==spoof.sha||source.head_branch!==spoof.branch||
     source.event!=='workflow_dispatch'||source.name!=='Metrics / Replay Request'||
     normalized(source)!==spoof.workflow_path||
     source.workflow_id!==spoof.workflow_id||
     source.actor?.login!=='BestNathan'||
     source.triggering_actor?.login!=='BestNathan'||
     source.conclusion!=='success'||
     workflow?.id!==spoof.workflow_id||
     normalized(workflow)!==spoof.workflow_path)
    fail('untrusted same-display-name wrong-workflow source');
  if(!window||!Number.isFinite(Date.parse(window.start))||
     !Number.isFinite(Date.parse(window.end))||
     Date.parse(window.start)>=Date.parse(window.end))
    fail('invalid suppression observation window');
  if(!Array.isArray(consumerRuns)||consumerRuns.length>100)
    fail('untrusted consumer run inventory');
  const start=Date.parse(window.start),end=Date.parse(window.end);
  for(const run of consumerRuns){
    const created=Date.parse(run?.created_at??'');
    if(run?.event!=='workflow_run'||!Number.isFinite(created))continue;
    if(created>=start&&created<=end)
      fail('main consumer was dispatched for the suppressed spoof source');
  }
  return Object.freeze({
    kind:'verified_suppressed_spoof_replay_source',repository:REPO,
    source_run_id:source.id,source_attempt:source.run_attempt,
    source_sha:source.head_sha,source_workflow_id:source.workflow_id,
    source_workflow_path:spoof.workflow_path,source_event:source.event,
    source_branch:source.head_branch,source_actor:source.actor.login,
    main_consumer_dispatched:false,
    observation_window:window,
    observed_consumer_runs:consumerRuns.length,
    store_write_attempted:false,
    deterministic_guard_fixture:'scripts/metrics-replay-source.mjs self-test: same-name different workflow ID/path refused',
  });
}
export async function collectMetricsReplayAdmissionProof(repo,targetSha,workspace,get,getText){
  if(repo!==REPO||!SHA.test(targetSha)||!path.isAbsolute(workspace)||
     typeof get!=='function'||typeof getText!=='function')
    fail('invalid replay admission query');
  for(const sha of [spoof.main_sha,admissionReplay.sha]){
    const git=execFileSync('git',['-C',workspace,'merge-base','--is-ancestor',
      sha,targetSha],{encoding:'utf8',timeout:30000,
      stdio:['ignore','pipe','pipe']});
    if(git!=='')fail('unexpected Git ancestry stdout');
  }
  const prefix='/repos/'+REPO;
  const [source,workflow,replaySource,recipient]=await Promise.all([
    get(prefix+'/actions/runs/'+spoof.source+'/attempts/'+spoof.source_attempt),
    get(prefix+'/actions/workflows/'+spoof.workflow_id),
    get(prefix+'/actions/runs/'+admissionReplay.source+'/attempts/'+admissionReplay.source_attempt),
    get(prefix+'/actions/runs/'+admissionReplay.consumer+'/attempts/'+admissionReplay.consumer_attempt),
  ]);
  const inventory=await get(prefix+
    '/actions/workflows/metrics-repository.yml/runs?per_page=100&event=workflow_run');
  const suppression=attestSpoofedSourceSuppression({
    source,workflow,consumerRuns:inventory.workflow_runs,
    window:admissionReplay.suppression_window});
  const jobs=await get(prefix+'/actions/runs/'+recipient.id+
    '/attempts/'+recipient.run_attempt+'/jobs?per_page=100');
  const authorizer=originalJob(jobs,recipient,'authorize-replay');
  const log=await getText(prefix+'/actions/jobs/'+authorizer.id+'/logs');
  const replay=attestPositiveReplay(replaySource,recipient,jobs,log,true,admissionReplay);
  return Object.freeze({
    schema_version:1,kind:'authenticated_metrics_replay_admission_proof',
    repository:REPO,authenticated_target_sha:targetSha,
    verdict:'LiveAdmissionBoundaryVerified',
    same_display_name_wrong_workflow_manual_source:suppression,
    authorized_owner_main_replay:replay,
    spoof_source_cover:1,positive_replay_cover:1,
    prior_evidence_reused:'#1690 SC-09 historical replay and off-main cases retained; not repeated',
  });
}
export async function collectMetricsReplayLineage(repo,targetSha,workspace,get,getText){
  if(repo!==REPO||!SHA.test(targetSha)||!path.isAbsolute(workspace)||
    typeof get!=='function'||typeof getText!=='function')
    fail('invalid trusted replay source query');
  const git=execFileSync('git',['-C',workspace,'merge-base','--is-ancestor',
    positive.sha,targetSha],{encoding:'utf8',timeout:30000,
    stdio:['ignore','pipe','pipe']});
  if(git!=='' )fail('unexpected Git ancestry stdout');
  const prefix='/repos/'+REPO;
  const getRun=async id=>{
    const attempt=1; // This fixed historical cohort is strictly Attempt 1.
    const run=await get(pinnedHistoricalAttemptEndpoint(id,attempt));
    if(!validRun(run,id)||run.run_attempt!==attempt)
      fail('historic source/consumer attempt does not match pinned cohort');
    return run;
  };
  const getJobs=run=>get(prefix+'/actions/runs/'+run.id+
    '/attempts/'+run.run_attempt+'/jobs?per_page=100');
  const [source,recipient]=await Promise.all([getRun(positive.source),getRun(positive.consumer)]);
  if(!validRun(source,positive.source)||!validRun(recipient,positive.consumer))
    fail('historical positive Replay locator is not authenticated');
  const jobs=await getJobs(recipient);
  const auth=originalJob(jobs,recipient,'authorize-replay');
  const log=await getText(prefix+'/actions/jobs/'+auth.id+'/logs');
  const yes=attestPositiveReplay(source,recipient,jobs,log,true);
  const denied=[];
  for(const pin of negatives){
    const [badSource,badRecipient]=await Promise.all([getRun(pin.source),getRun(pin.consumer)]);
    if(!validRun(badSource,pin.source)||!validRun(badRecipient,pin.consumer))
      fail('historical denied source locator is not authenticated');
    const attemptJobs=await getJobs(badRecipient);
    const authorizer=originalJob(attemptJobs,badRecipient,'authorize-replay');
    if(authorizer.conclusion!=='failure')fail('denied source Authorizer unexpectedly succeeded');
    const deniedLog=await getText(prefix+'/actions/jobs/'+authorizer.id+'/logs');
    const receipt=parseReplayDenialLog(deniedLog);
    if(!receipt)fail('missing actual denial receipt for '+pin.case);
    const workflow=await get(prefix+'/actions/workflows/'+badSource.workflow_id);
    const proof=attestReplayDenial(receipt,badSource,badRecipient,attemptJobs,workflow);
    if(proof.reason_code!==pin.reason||
       proof.privileged_publisher_job!=='skipped'||
       badSource.event!==pin.event||
       badSource.conclusion!==pin.conclusion||
       badSource.head_branch==='main'||
       (pin.case.includes('spoofed')&&
         (badSource.name!=='Metrics / Replay Request'||
          normalized(badSource)===SOURCE_WORKFLOW))||
       (pin.event==='workflow_dispatch'&&
         (badSource.workflow_id!==positive.source_workflow_id||
          normalized(badSource)!==SOURCE_WORKFLOW||
          badSource.actor?.login!=='BestNathan'||
          badSource.triggering_actor?.login!=='BestNathan')))
      fail('historical denied source did not match deliberate hostile-case scope');
    denied.push({...proof,case:pin.case,source_workflow_path:normalized(badSource)});
  }
  if(denied.length!==negatives.length)fail('incomplete real negative-source matrix');
  return {
    schema_version:1,kind:'authenticated_metrics_replay_provenance_matrix',
    repository:REPO,authenticated_target_sha:targetSha,
    verdict:'HistoricalSourceEvidenceVerified',
    authorized_owner_main_replay:yes,
    denied_untrusted_producers:denied,
    positive_coverage:1,negative_coverage:negatives.length,
    real_manual_off_main_dispatch_denials:denied.filter(x=>
      x.source_event==='workflow_dispatch'&&
      x.reason_code==='untrusted_source').length,
    additional_policy_fixtures_owner:'scripts/metrics-replay-source.mjs:attestReplay',
    not_yet_live_tested:'wrong workflow ID/path under workflow_dispatch, forged attempt/digest and newly replayed owner-main manual action are not proved by historical pushed or off-main dispatch denial cases',
    github_server_ref_write_denials_verified:false,
  };
}
export function selfTestMetricsReplayLineage(){
  // Independent authenticated GitHub Run/Attempt metadata retrieved
  // 2026-11-04: this off-main source completed with conclusion=skipped.
  // The previous hardcoded "success" made the canonical evidence collector
  // reject genuine proof and blocked the entire #1690 Issue updater.
  assert.deepEqual(negatives.map(x=>[x.source,x.event,x.conclusion]),[
    [41612523346,'push','skipped'],
    [41617665993,'push','success'],
    [38946898151,'workflow_dispatch','skipped'],
    [38932756286,'workflow_dispatch','skipped'],
  ]);
  assert.equal(pinnedHistoricalAttemptEndpoint(38946994222,1),
    '/repos/BestNathan/nession/actions/runs/38946994222/attempts/1');
  assert.notEqual(pinnedHistoricalAttemptEndpoint(38946994222,1),
    '/repos/BestNathan/nession/actions/runs/38946994222');
  assert.throws(()=>pinnedHistoricalAttemptEndpoint(38946994222,0));
  assert.throws(()=>pinnedHistoricalAttemptEndpoint(0,1));
  const sha=positive.sha,identity={full_name:REPO};
  const source={id:positive.source,run_attempt:1,status:'completed',
    conclusion:'success',head_branch:'main',head_sha:sha,
    name:'Metrics / Replay Request',path:SOURCE_WORKFLOW,
    workflow_id:positive.source_workflow_id,event:'workflow_dispatch',
    actor:{login:'BestNathan'},triggering_actor:{login:'BestNathan'},
    repository:identity,head_repository:identity,updated_at:'2026-10-16T18:23:50Z'};
  const recipient={id:positive.consumer,run_attempt:1,status:'completed',
    conclusion:'success',head_branch:'main',head_sha:sha,
    name:'Metrics / Repository Health',path:CONSUMER_WORKFLOW,
    event:'workflow_run',repository:identity,head_repository:identity,
    created_at:'2026-10-16T18:23:51Z'};
  const checked=['Mint scoped App token for orphan Run Store updates',
    'Reject unrecognized writer mode or unavailable App token',
    'Publish durable metrics branch',
    'Verify immutable Git bytes before uploading Run Store receipts'];
  const jobs={jobs:allowedNames.map((name,i)=>({id:100+i,name,
    run_id:recipient.id,run_attempt:1,head_sha:sha,
    status:'completed',conclusion:'success',steps:name==='publish'
      ?checked.map(x=>({name:x,status:'completed',conclusion:'success'})):[]}))};
  const authLog='2026-10-16T18:24:08Z '+JSON.stringify({status:'authorized',
    mode:'owner_main_manual_replay',repository:REPO,
    source_run_id:source.id,source_attempt:1,source_sha:sha,
    workflow_id:source.workflow_id})+'\n';
  const verify=(s=source,c=recipient,j=jobs,l=authLog,a=true)=>
    attestPositiveReplay(s,c,j,l,a);
  assert.equal(verify().publisher_step,'completed_success');
  assert.throws(()=>verify({...source,event:'push'}));
  assert.throws(()=>verify({...source,path:'evil.yml'}));
  assert.throws(()=>verify({...source,actor:{login:'attacker'}}));
  assert.throws(()=>verify({...source,run_attempt:2}));
  assert.throws(()=>verify({...source,head_sha:'b'.repeat(40)}));
  assert.throws(()=>verify(source,{...recipient,conclusion:'failure'}));
  assert.throws(()=>verify(source,recipient,jobs,authLog,false));
  assert.throws(()=>verify(source,recipient,{jobs:jobs.jobs.map(x=>
    x.name==='publish'?{...x,conclusion:'skipped'}:x)}));
  assert.throws(()=>verify(source,recipient,{jobs:jobs.jobs.map(x=>
    x.name==='publish'?{...x,steps:x.steps.map(step=>
      step.name==='Publish durable metrics branch'?{...step,conclusion:'skipped'}:step)}:x)}));
  assert.throws(()=>verify(source,recipient,jobs,authLog.replace(String(source.id),'999')));
  return true;
}

export function selfTestMetricsReplayAdmissionProof(){
  const identity={full_name:REPO};
  const source={id:spoof.source,run_attempt:1,status:'completed',
    conclusion:'success',head_branch:spoof.branch,head_sha:spoof.sha,
    name:'Metrics / Replay Request',path:spoof.workflow_path,
    workflow_id:spoof.workflow_id,event:'workflow_dispatch',
    actor:{login:'BestNathan'},triggering_actor:{login:'BestNathan'},
    repository:identity,head_repository:identity,
    created_at:'2026-11-09T03:49:56Z',updated_at:'2026-11-09T03:50:03Z'};
  const workflow={id:spoof.workflow_id,name:'Metrics / Replay Request',
    path:spoof.workflow_path};
  const laterConsumer={id:1,event:'workflow_run',created_at:'2026-11-09T03:51:51Z'};
  const suppression=attestSpoofedSourceSuppression({source,workflow,
    consumerRuns:[laterConsumer],window:admissionReplay.suppression_window});
  assert.equal(suppression.main_consumer_dispatched,false);
  assert.equal(suppression.source_workflow_id,spoof.workflow_id);
  const noConsumer=()=>attestSpoofedSourceSuppression({source,workflow,
    consumerRuns:[],window:admissionReplay.suppression_window});
  assert.throws(()=>attestSpoofedSourceSuppression({source,
    workflow:{...workflow,id:spoof.workflow_id+1},
    consumerRuns:[],window:admissionReplay.suppression_window}));
  assert.throws(()=>attestSpoofedSourceSuppression({source:{...source,
    path:SOURCE_WORKFLOW},workflow,consumerRuns:[],
    window:admissionReplay.suppression_window}));
  assert.throws(()=>attestSpoofedSourceSuppression({source:{...source,
    event:'push'},workflow,consumerRuns:[],
    window:admissionReplay.suppression_window}));
  assert.throws(()=>attestSpoofedSourceSuppression({source,workflow,
    consumerRuns:[{id:2,event:'workflow_run',
      created_at:'2026-11-09T03:50:30Z'}],
    window:admissionReplay.suppression_window}));
  assert.equal(noConsumer().main_consumer_dispatched,false);

  const replaySha=admissionReplay.sha;
  const replaySource={id:admissionReplay.source,run_attempt:1,
    status:'completed',conclusion:'success',head_branch:'main',
    head_sha:replaySha,name:'Metrics / Replay Request',path:SOURCE_WORKFLOW,
    workflow_id:admissionReplay.source_workflow_id,event:'workflow_dispatch',
    actor:{login:'BestNathan'},triggering_actor:{login:'BestNathan'},
    repository:identity,head_repository:identity,
    updated_at:'2026-11-09T03:51:49Z'};
  const recipient={id:admissionReplay.consumer,run_attempt:1,status:'completed',
    conclusion:'success',name:'Metrics / Repository Health',
    path:CONSUMER_WORKFLOW,event:'workflow_run',head_branch:'main',
    head_sha:replaySha,repository:identity,head_repository:identity,
    created_at:'2026-11-09T03:51:51Z'};
  const checked=['Mint scoped App token for orphan Run Store updates',
    'Reject unrecognized writer mode or unavailable App token',
    'Publish durable metrics branch',
    'Verify immutable Git bytes before uploading Run Store receipts'];
  const jobs={jobs:allowedNames.map((name,i)=>({id:500+i,name,
    run_id:recipient.id,run_attempt:1,head_sha:replaySha,
    status:'completed',conclusion:'success',steps:name==='publish'
      ?checked.map(x=>({name:x,status:'completed',conclusion:'success'})):[]}))};
  const authLog='2026-11-09T03:52:00Z '+JSON.stringify({status:'authorized',
    mode:'owner_main_manual_replay',repository:REPO,
    source_run_id:replaySource.id,source_attempt:1,source_sha:replaySha,
    workflow_id:replaySource.workflow_id})+'\n';
  const replay=attestPositiveReplay(replaySource,recipient,jobs,authLog,true,
    admissionReplay);
  assert.equal(replay.recipient_run_id,admissionReplay.consumer);
  assert.throws(()=>attestPositiveReplay({...replaySource,run_attempt:2},
    recipient,jobs,authLog,true,admissionReplay));
  assert.throws(()=>attestPositiveReplay(replaySource,
    {...recipient,conclusion:'failure'},jobs,authLog,true,admissionReplay));
  assert.throws(()=>attestPositiveReplay(replaySource,recipient,jobs,
    authLog.replace(String(replaySource.id),'999'),true,admissionReplay));
  return true;
}
