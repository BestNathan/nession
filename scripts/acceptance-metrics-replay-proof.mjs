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
});
const negatives=Object.freeze([
  Object.freeze({source:41612523346,consumer:41612550381,
    case:'off_main_canonical_path_unexpected_push'}),
  Object.freeze({source:41617665993,consumer:41617692764,
    case:'off_main_spoofed_display_name_wrong_workflow_id_and_path'}),
]);
const allowedNames=['authorize-replay','rust-health','web-health','e2e-health','publish'];
const fail=x=>{throw Error('authenticated Metrics replay: '+x);};
const normalized=r=>String(r?.path??'').replace(/@refs\/heads\/main$/,'');
const validRun=(r,id)=>r?.id===id&&r?.status==='completed'&&
  Number.isSafeInteger(r.run_attempt)&&r.run_attempt>0&&
  r.repository?.full_name===REPO&&r.head_repository?.full_name===REPO&&
  SHA.test(r.head_sha??'');
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
export function attestPositiveReplay(source,recipient,jobs,authLog,ancestor){
  if(!validRun(source,positive.source)||!validRun(recipient,positive.consumer)||
    source.head_sha!==positive.sha||recipient.head_sha!==positive.sha||
    source.run_attempt!==1||recipient.run_attempt!==1||
    source.head_branch!=='main'||source.event!=='workflow_dispatch'||
    source.name!=='Metrics / Replay Request'||
    normalized(source)!==SOURCE_WORKFLOW||
    source.workflow_id!==positive.source_workflow_id||
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
export async function collectMetricsReplayLineage(repo,targetSha,workspace,get,getText){
  if(repo!==REPO||!SHA.test(targetSha)||!path.isAbsolute(workspace)||
    typeof get!=='function'||typeof getText!=='function')
    fail('invalid trusted replay source query');
  const git=execFileSync('git',['-C',workspace,'merge-base','--is-ancestor',
    positive.sha,targetSha],{encoding:'utf8',timeout:30000,
    stdio:['ignore','pipe','pipe']});
  if(git!=='' )fail('unexpected Git ancestry stdout');
  const prefix='/repos/'+REPO;
  const getRun=id=>get(prefix+'/actions/runs/'+id);
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
    if(proof.reason_code!=='unexpected_source_event'||
       proof.privileged_publisher_job!=='skipped'||
       badSource.event!=='push'||
       badSource.head_branch==='main'||
       (pin.case.includes('spoofed')&&
         (badSource.name!=='Metrics / Replay Request'||
          normalized(badSource)===SOURCE_WORKFLOW)))
      fail('historical denied source did not match deliberate hostile-case scope');
    denied.push({...proof,case:pin.case,source_workflow_path:normalized(badSource)});
  }
  if(denied.length!==2)fail('incomplete real negative-source matrix');
  return {
    schema_version:1,kind:'authenticated_metrics_replay_provenance_matrix',
    repository:REPO,authenticated_target_sha:targetSha,
    verdict:'HistoricalSourceEvidenceVerified',
    authorized_owner_main_replay:yes,
    denied_untrusted_producers:denied,
    positive_coverage:1,negative_coverage:2,
    additional_policy_fixtures_owner:'scripts/metrics-replay-source.mjs:attestReplay',
    not_yet_live_tested:'wrong workflow ID/path with a separately successfully dispatched workflow_dispatch, forged attempt/digest and fresh owner manual replay are not proven by these two unexpected-event denials',
    github_server_ref_write_denials_verified:false,
  };
}
export function selfTestMetricsReplayLineage(){
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
