// #2137: immutable, non-force Agent Store write-ahead fence for a future
// GitHub PR Publisher. Never call a GitHub write API from this module.
// A crash/timeout after the intent is committed yields 'reconcile' (no usable
// second publish grant), so a replay cannot blindly create another PR.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readIssueWorkflowState} from '../orchestration/state-store.mjs';
import {auditStagedRunStore} from '../../../run-store-integrity.mjs';
import {publish} from '../../../run-store-cas-push.mjs';
import {CONTROLLED_1997_POLICY as POLICY}
  from './controlled-proposal.mjs';

const SHA=/^[a-f0-9]{40}$/;
const HEX=/^[a-f0-9]{64}$/;
const REPO='BestNathan/nession';
const BRANCH='agent/1997/developer-checkpoint-v3';
const EXPECTED_PATH='workflows/issues/1997/results/'+POLICY.run_id+'-'+
  POLICY.attempt+'-'+POLICY.action_id+'.json';
function reject(message){throw Error('Trusted Publisher intent: '+message);}
function git(dir,...args){
  try{return execFileSync('git',['-C',dir,...args],{
    encoding:'utf8',stdio:['ignore','pipe','pipe'],
    timeout:45000,maxBuffer:2*1024*1024,
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
  }).trim();}
  catch(e){reject('Git '+args[0]+' failed ('+(e.status??'unknown')+')');}
}
function json(root,file){
  const full=path.join(root,file);
  if(!fs.existsSync(full))return null;
  const st=fs.lstatSync(full);
  if(!st.isFile()||st.isSymbolicLink()||st.size>8192)
    reject('untrusted immutable publication record');
  try{return JSON.parse(fs.readFileSync(full,'utf8'));}
  catch{reject('invalid immutable publication JSON');}
}
function expected({target_main_sha,patch_sha256,issuer_run_id}){
  if(!SHA.test(target_main_sha??'')||!HEX.test(patch_sha256??'')||
     !Number.isSafeInteger(issuer_run_id)||issuer_run_id<1)
    reject('invalid authenticated publisher request');
  return {
    schema_version:1,kind:'trusted_publisher_write_ahead_intent',
    repository:REPO,issue:1997,
    action_id:POLICY.action_id,worker_run_id:POLICY.run_id,
    worker_run_attempt:POLICY.attempt,source_sha:POLICY.source_sha,
    source_worker_sha:POLICY.worker_sha,
    checkpoint_version:POLICY.checkpoint_version,
    checkpoint_commit_sha:POLICY.checkpoint_commit_sha,
    checkpoint_ciphertext_sha256:POLICY.checkpoint_ciphertext_sha256,
    source_claim_artifact_id:POLICY.claim_artifact_id,
    source_result_artifact_id:POLICY.result_artifact_id,
    source_ingest_run_id:POLICY.ingester_run_id,
    target_main_sha,patch_sha256,branch:BRANCH,
    publisher_issuer_run_id:issuer_run_id,
    // An immutable intent is a replay fence, not a PR receipt or quality verdict.
    publication:'not_yet_attested',
  };
}
export function validateControlledPublisherIntent(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||
     Object.keys(value).length!==20||
     value.schema_version!==1||
     value.kind!=='trusted_publisher_write_ahead_intent'||
     value.repository!==REPO||value.issue!==1997||
     value.action_id!==POLICY.action_id||
     value.worker_run_id!==POLICY.run_id||
     value.worker_run_attempt!==POLICY.attempt||
     value.source_sha!==POLICY.source_sha||
     value.source_worker_sha!==POLICY.worker_sha||
     value.checkpoint_version!==POLICY.checkpoint_version||
     value.checkpoint_commit_sha!==POLICY.checkpoint_commit_sha||
     value.checkpoint_ciphertext_sha256!==POLICY.checkpoint_ciphertext_sha256||
     value.source_claim_artifact_id!==POLICY.claim_artifact_id||
     value.source_result_artifact_id!==POLICY.result_artifact_id||
     value.source_ingest_run_id!==POLICY.ingester_run_id||
     !SHA.test(value.target_main_sha??'')||
     !HEX.test(value.patch_sha256??'')||
     value.branch!==BRANCH||!Number.isSafeInteger(value.publisher_issuer_run_id)||
     value.publisher_issuer_run_id<1||
     value.publication!=='not_yet_attested')
    reject('untrusted or conflicting immutable Publisher intent');
  return value;
}
export function planControlledPublisherIntent(args){
  return validateControlledPublisherIntent(expected(args));
}
export const CONTROLLED_PUBLISHER_INTENT_PATH=EXPECTED_PATH;
export const CONTROLLED_PUBLISHER_BRANCH=BRANCH;
function confirmStore(root){
  const checked=readIssueWorkflowState(root,POLICY.issue);
  if(!checked.state||checked.version!==POLICY.workflow_state_version)
    reject('expected v16 Issue Store source not committed');
  const action=checked.state.outbox.filter(x=>x.id===POLICY.action_id);
  if(action.length!==1||action[0].status!=='yielded'||
     action[0].receipt?.source_run_id!==POLICY.run_id||
     action[0].receipt?.source_attempt!==POLICY.attempt||
     action[0].receipt?.checkpoint_commit_sha!==POLICY.checkpoint_commit_sha||
     action[0].receipt?.ciphertext_sha256!==POLICY.checkpoint_ciphertext_sha256)
    reject('source Action has not yielded exact bound native checkpoint');
  return checked;
}
export function commitControlledPublisherIntent({
  remote,target_main_sha,patch_sha256,issuer_run_id,
}){
  const record=planControlledPublisherIntent({target_main_sha,patch_sha256,issuer_run_id});
  if(typeof remote!=='string'||!remote||/\s/.test(remote)||remote.length>2000)
    reject('invalid scoped authenticated Store remote');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nession-publisher-intent-'));
  const checkout=path.join(temp,'store');
  try{
    try{execFileSync('git',['clone','--quiet','--no-tags','--single-branch',
      '--branch','agent-store','--',remote,checkout],{
      encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:45000,
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
    });}catch{reject('authenticated agent-store clone failed');}
    if(git(checkout,'symbolic-ref','--short','HEAD')!=='agent-store')
      reject('incorrect orphan Store branch');
    confirmStore(checkout);
    const prior=json(checkout,EXPECTED_PATH);
    if(prior){
      validateControlledPublisherIntent(prior);
      for(const k of Object.keys(record)){
        if(prior[k]!==record[k])reject('conflicting immutable publish replay');
      }
      return {status:'reconcile',path:EXPECTED_PATH,record:prior,
        store_commit_sha:git(checkout,'rev-parse','HEAD'),
        may_publish:false};
    }
    const full=path.join(checkout,EXPECTED_PATH);
    fs.mkdirSync(path.dirname(full),{recursive:true});
    fs.writeFileSync(full,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
    git(checkout,'add','--',EXPECTED_PATH);
    const audit=auditStagedRunStore(checkout,'agent-store');
    if(audit.checked_changes!==1)reject('unclassified Publisher Store mutation');
    git(checkout,'-c','user.name=nession-agent-publisher',
      '-c','user.email=nession-agent-publisher@users.noreply.github.com',
      'commit','-m','agent-store: bounded #1997 trusted Publisher intent');
    const committed=publish('agent-store',checkout,4);
    if(committed.replayed)
      reject('ambiguous concurrent Publisher Store CAS, reconcile manually');
    return {status:'committed',path:EXPECTED_PATH,
      store_commit_sha:committed.commit_sha,
      record,may_publish:true};
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
