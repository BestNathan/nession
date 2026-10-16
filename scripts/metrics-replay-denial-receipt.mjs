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
