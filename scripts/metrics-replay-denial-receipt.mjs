// Trusted-main, read-only Metrics Replay denial receipt; not a Store receipt.
// The event's source fields are UNVERIFIED CLAIMS until an independent GitHub
// REST consumer binds them to the actual Run/Attempt and a skipped Publisher.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';

export const DENIAL_LOG_PREFIX='METRICS_REPLAY_DENIAL_V1 ';
export const DENIAL_REASONS=Object.freeze({
  'privileged recipient must be default-main workflow_run':'untrusted_recipient',
  'unexpected wake-up event or upstream trigger':'unexpected_source_event',
  'GitHub upstream REST identity does not match the triggering event':'source_identity_mismatch',
  'invalid source run identity':'invalid_source_identity',
  'untrusted dispatch source, branch or workflow':'untrusted_source',
  'only repository owner may request or re-run Metrics replay':'untrusted_actor',
  'main SHA drift or non-main dispatched code':'source_sha_drift',
  'untrusted wake-up provenance':'untrusted_wake',
});
const SHA=/^[a-f0-9]{40}$/;
const POS=x=>Number.isSafeInteger(x)&&x>0;
const REPO='BestNathan/nession';
const safe=(v,max=160)=>typeof v==='string'&&v.length<=max&&
  /^[A-Za-z0-9_.\/:-]*$/.test(v)?v:null;
const num=v=>POS(Number(v))?Number(v):null;
export function denialCode(error){
  const message=String(error?.message??'');
  const prefix='Metrics Replay refused: ';
  if(!message.startsWith(prefix))return null;
  return DENIAL_REASONS[message.slice(prefix.length)]??null;
}
export function makeDenialReceipt(env,event,error){
  const reason=denialCode(error);
  const wake=event?.workflow_run;
  if(!reason||env?.GITHUB_REPOSITORY!==REPO||
     env.GITHUB_EVENT_NAME!=='workflow_run'||
     env.GITHUB_REF!=='refs/heads/main'||!SHA.test(env.GITHUB_SHA??'')||
     !POS(num(env.GITHUB_RUN_ID))||!POS(num(env.GITHUB_RUN_ATTEMPT))||
     !wake||!POS(num(wake.id))||!POS(num(wake.run_attempt)))
    return null;
  return Object.freeze({
    schema_version:1,kind:'metrics_replay_authorizer_denial',
    repository:REPO,decision:'denied',reason_code:reason,
    source_identity_trust:'event_claim_only_requires_independent_readback',
    recipient:{run_id:num(env.GITHUB_RUN_ID),run_attempt:num(env.GITHUB_RUN_ATTEMPT),
      sha:env.GITHUB_SHA,ref:env.GITHUB_REF,
      workflow:'.github/workflows/metrics-repository.yml'},
    source_claim:{run_id:num(wake.id),run_attempt:num(wake.run_attempt),
      workflow_id:num(wake.workflow_id),event:safe(wake.event),
      branch:safe(wake.head_branch),sha:SHA.test(wake.head_sha??'')?wake.head_sha:null,
      repository:safe(wake.repository?.full_name),
      head_repository:safe(wake.head_repository?.full_name)},
    store_write_authorized:false,
    // The recipient's Publisher job must be independently verified as skipped.
    publisher_job_result:'requires_independent_github_jobs_check',
  });
}
export function validateDenialReceipt(receipt){
  if(receipt?.schema_version!==1||
     receipt.kind!=='metrics_replay_authorizer_denial'||
     receipt.repository!==REPO||receipt.decision!=='denied'||
     !Object.values(DENIAL_REASONS).includes(receipt.reason_code)||
     receipt.source_identity_trust!=='event_claim_only_requires_independent_readback'||
     receipt.store_write_authorized!==false||
     receipt.publisher_job_result!=='requires_independent_github_jobs_check'||
     !POS(receipt.recipient?.run_id)||!POS(receipt.recipient?.run_attempt)||
     !SHA.test(receipt.recipient?.sha??'')||
     receipt.recipient.ref!=='refs/heads/main'||
     receipt.recipient.workflow!=='.github/workflows/metrics-repository.yml'||
     !POS(receipt.source_claim?.run_id)||!POS(receipt.source_claim?.run_attempt)||
     (receipt.source_claim.sha!==null&&!SHA.test(receipt.source_claim.sha??''))||
     !['push','workflow_dispatch','pull_request','repository_dispatch','schedule',null]
       .includes(receipt.source_claim.event))
    throw Error('invalid Metrics Replay denial receipt');
  const allowed=new Set(['schema_version','kind','repository','decision','reason_code',
    'source_identity_trust','recipient','source_claim','store_write_authorized',
    'publisher_job_result']);
  if(Object.keys(receipt).some(k=>!allowed.has(k)))throw Error('unexpected receipt fields');
  return receipt;
}

// GitHub REST Run/Attempt metadata and original job logs are separate from the
// source event claim. Never infer publication safety from a failed run alone.
export function attestReplayDenial(receipt,source,recipient,jobs,workflow){
  validateDenialReceipt(receipt);
  const rec=receipt.recipient,src=receipt.source_claim;
  if(recipient?.id!==rec.run_id||
     recipient?.run_attempt!==rec.run_attempt||
     recipient?.name!=='Metrics / Repository Health'||
     !['.github/workflows/metrics-repository.yml',
       '.github/workflows/metrics-repository.yml@refs/heads/main'].includes(recipient.path)||
     recipient?.event!=='workflow_run'||recipient?.head_branch!=='main'||
     recipient?.head_sha!==rec.sha||
     recipient?.repository?.full_name!==REPO||
     recipient?.head_repository?.full_name!==REPO||
     recipient?.status!=='completed'||recipient?.conclusion!=='failure'||
     source?.id!==src.run_id||source?.run_attempt!==src.run_attempt||
     workflow?.id!==source?.workflow_id||
     workflow?.name!==source?.name||
     workflow?.path!==String(source?.path??'').replace(/@refs\/heads\/[^\s]+$/,'')||
     !/^[A-Za-z0-9_-]{1,58}(?:\[bot\])?$/.test(source?.actor?.login??'')||
     !/^[A-Za-z0-9_-]{1,58}(?:\[bot\])?$/.test(source?.triggering_actor?.login??'')||
     source?.workflow_id!==src.workflow_id||
     source?.event!==src.event||source?.head_branch!==src.branch||
     source?.head_sha!==src.sha||
     source?.repository?.full_name!==REPO||
     source?.head_repository?.full_name!==REPO||
     source?.status!=='completed'||!['success','skipped'].includes(source?.conclusion)||
     !['push','workflow_dispatch'].includes(source?.event)||
     !Array.isArray(jobs?.jobs)||jobs.jobs.length!==5)
    throw Error('Metrics Replay denial Run/Attempt/source provenance mismatch');
  if(receipt.reason_code==='unexpected_source_event'&&
     source.event==='workflow_dispatch')
    throw Error('Metrics Replay denied-event reason contradicts source');
  if(receipt.reason_code==='untrusted_source'&&
     source.event==='workflow_dispatch'&&source.head_branch==='main'&&
     source.name==='Metrics / Replay Request'&&
     source.path==='.github/workflows/metrics-replay-request.yml'&&
     source.actor?.login==='BestNathan'&&
     source.triggering_actor?.login==='BestNathan')
    throw Error('Metrics Replay denied-source reason contradicts source');
  const expected=new Map([
    ['authorize-replay','failure'],['rust-health','skipped'],
    ['web-health','skipped'],['e2e-health','skipped'],['publish','skipped']]);
  const seen=new Set();
  for(const job of jobs.jobs){
    if(seen.has(job.name)||!expected.has(job.name)||
       job.run_id!==rec.run_id||job.run_attempt!==rec.run_attempt||
       job.head_sha!==rec.sha||job.status!=='completed'||
       job.conclusion!==expected.get(job.name))
      throw Error('Metrics Replay denial publisher/job outcomes unverified');
    seen.add(job.name);
  }
  if(seen.size!==expected.size)
    throw Error('Metrics Replay denial jobs missing');
  return Object.freeze({kind:'verified_metrics_replay_denial',
    source_run_id:src.run_id,source_attempt:src.run_attempt,
    source_branch:src.branch,source_event:src.event,source_sha:src.sha,
    source_actor:source.actor.login,source_triggering_actor:source.triggering_actor.login,
    source_workflow_id:source.workflow_id,source_workflow_path:workflow.path,
    recipient_run_id:rec.run_id,recipient_attempt:rec.run_attempt,
    recipient_sha:rec.sha,reason_code:receipt.reason_code,
    privileged_publisher_job:'skipped',health_jobs:'all_skipped',
    evidence:'GitHub API Run/Attempt + exact original trusted-main authorize log and job outcomes',
    independent_store_ref_anchor:'not_proven'});
}
// GitHub job logs are service-hosted, but only a trusted-main authorizer's
// exact job may produce an attested receipt. Never parse an arbitrary log.
export function parseReplayDenialLog(log){
  if(typeof log!=='string'||log.length>1048576)
    throw Error('invalid Metrics Replay denial log size');
  const candidates=log.split(/\r?\n/).filter(line=>line.includes(DENIAL_LOG_PREFIX));
  if(candidates.length!==1)return null;
  const line=candidates[0];
  const match=line.match(/METRICS_REPLAY_DENIAL_V1 (\{.*\})\s*$/);
  if(!match||match[1].length>8192)
    throw Error('invalid Metrics Replay denial record framing');
  return validateDenialReceipt(JSON.parse(match[1]));
}

function selfTest(){
  const sha='a'.repeat(40),repo={full_name:REPO};
  const env={GITHUB_REPOSITORY:REPO,GITHUB_EVENT_NAME:'workflow_run',
    GITHUB_REF:'refs/heads/main',GITHUB_SHA:sha,
    GITHUB_RUN_ID:'1234',GITHUB_RUN_ATTEMPT:'1'};
  const event={workflow_run:{id:22,run_attempt:1,workflow_id:33,event:'push',
    head_branch:'feature',head_sha:'b'.repeat(40),
    repository:repo,head_repository:repo}};
  const denial=new Error('Metrics Replay refused: unexpected wake-up event or upstream trigger');
  const receipt=makeDenialReceipt(env,event,denial);
  assert.equal(validateDenialReceipt(receipt).reason_code,'unexpected_source_event');
  assert.equal(receipt.source_claim.branch,'feature');
  assert.equal(receipt.store_write_authorized,false);
  const recipient={id:receipt.recipient.run_id,run_attempt:1,
    name:'Metrics / Repository Health',
    path:'.github/workflows/metrics-repository.yml',event:'workflow_run',
    head_branch:'main',head_sha:sha,repository:repo,head_repository:repo,
    status:'completed',conclusion:'failure'};
  const source={id:22,run_attempt:1,workflow_id:33,
    name:'Metrics / Replay Request',
    path:'.github/workflows/metrics-replay-request.yml',event:'push',
    actor:{login:'BestNathan'},triggering_actor:{login:'BestNathan'},
    head_branch:'feature',head_sha:'b'.repeat(40),
    repository:repo,head_repository:repo,status:'completed',
    conclusion:'success'};
  const jobNames=['authorize-replay','rust-health','web-health','e2e-health','publish'];
  const jobs={jobs:jobNames.map((name,i)=>({id:100+i,name,
    run_id:1234,run_attempt:1,head_sha:sha,status:'completed',
    conclusion:i===0?'failure':'skipped'}))};
  const sourceWorkflow={id:33,name:'Metrics / Replay Request',
    path:'.github/workflows/metrics-replay-request.yml'};
  assert.equal(attestReplayDenial(receipt,source,recipient,jobs,sourceWorkflow)
    .privileged_publisher_job,'skipped');
  const reject=(rr,ss,cc,jj)=>
    assert.throws(()=>attestReplayDenial(rr,ss,cc,jj,sourceWorkflow),/mismatch|unverified|denial/);
  reject(receipt,{...source,run_attempt:2},recipient,jobs);
  reject(receipt,{...source,head_sha:sha},recipient,jobs);
  reject(receipt,source,{...recipient,head_branch:'feature'},jobs);
  reject(receipt,source,{...recipient,conclusion:'success'},jobs);
  reject(receipt,source,recipient,{jobs:jobs.jobs.slice(1)});
  reject(receipt,source,recipient,{jobs:jobs.jobs.map(x=>
    x.name==='publish'?{...x,conclusion:'success'}:x)});
  reject(receipt,source,recipient,{jobs:jobs.jobs.map(x=>
    x.name==='authorize-replay'?{...x,run_attempt:2}:x)});
  reject(receipt,{...source,event:'workflow_dispatch'},recipient,jobs);
  assert.equal(attestReplayDenial(receipt,{...source,conclusion:'skipped'},
    recipient,jobs,sourceWorkflow).source_event,'push');
  reject(receipt,{...source,conclusion:'failure'},recipient,jobs);
  assert.throws(()=>attestReplayDenial(receipt,source,recipient,jobs,
    {...sourceWorkflow,path:'.github/workflows/evil.yml'}),/provenance mismatch/);
  reject(receipt,{...source,actor:{login:'bad.actor!'}},recipient,jobs);
  assert.equal(attestReplayDenial(receipt,{...source,actor:{login:'github-actions[bot]'},
    triggering_actor:{login:'github-actions[bot]'}},recipient,jobs,sourceWorkflow)
    .source_actor,'github-actions[bot]');
  const log='2026-10-16T00:00:00Z '+DENIAL_LOG_PREFIX+JSON.stringify(receipt)+'\n';
  assert.deepEqual(parseReplayDenialLog(log),receipt);
  assert.equal(parseReplayDenialLog('other job log'),null);
  assert.equal(parseReplayDenialLog(log+log),null);
  assert.equal(makeDenialReceipt(env,event,new Error('GitHub API timeout')),null);
  assert.equal(makeDenialReceipt({...env,GITHUB_REF:'refs/heads/feature'},event,denial),null);
  assert.equal(makeDenialReceipt({...env,GITHUB_RUN_ATTEMPT:'x'},event,denial),null);
  assert.equal(makeDenialReceipt(env,{workflow_run:{...event.workflow_run,id:0}},denial),null);
  assert.equal(makeDenialReceipt(env,event,new Error('Metrics Replay refused: arbitrary secret')),null);
  assert.equal(makeDenialReceipt(env,{workflow_run:{...event.workflow_run,head_branch:'bad\nTOKEN'}},denial).source_claim.branch,null);
  for(const mutation of [
    {...receipt,store_write_authorized:true},
    {...receipt,source_claim:{...receipt.source_claim,run_id:0}},
    {...receipt,recipient:{...receipt.recipient,ref:'refs/heads/feature'}},
    {...receipt,reason_code:'authorized'},
    {...receipt,private_key:'secret'},
  ])assert.throws(()=>validateDenialReceipt(mutation),/invalid|unexpected/);
  console.log('Metrics Replay denial receipt: sanitized, denied-only, independent-readback-required fixtures passed');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  selfTest();
