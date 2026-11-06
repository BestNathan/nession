// #2137: immutable, non-force Agent Store write-ahead fence for a future
// GitHub PR Publisher. Never call a GitHub write API from this module.
// A crash/timeout after the intent is committed yields 'reconcile' (no usable
// second publish grant), so a replay cannot blindly create another PR.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
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

// #2274: extend the SAME immutable Store Intent owner to authenticated Qwen
// Developer proposals. One file under the canonical results/ path is the
// durable no-redelivery fence. Never retry a GitHub PR POST after ambiguity.
const QWEN_INTENT_FIELDS=['schema_version','kind','repository','issue',
  'action_id','worker_run_id','worker_run_attempt','worker_sha','source_sha',
  'checkpoint_version','checkpoint_commit_sha','checkpoint_ciphertext_sha256',
  'patch_sha256','file_manifest_sha256','file_count','target_main_sha',
  'branch','publisher_run_id','publication'];
const sha256=x=>createHash('sha256').update(x).digest('hex');
const positive=x=>Number.isSafeInteger(x)&&x>0;
export function planQwenPublisherIntent({preflight,target_main_sha,publisher_run_id}){
  const e=preflight?.evidence;
  if(e?.schema_version!==1||
      e.kind!=='trusted_qwen_publisher_preflight_only'||
      e.status!=='preflight_only'||e.agent_id!=='dev-qwen-01'||
      !positive(e.issue)||!HEX.test(e.action_id??'')||
      !positive(e.worker_run_id)||e.worker_run_attempt!==1||
      !SHA.test(e.worker_sha??'')||!SHA.test(e.source_sha??'')||
      !positive(e.checkpoint_version)||
      !SHA.test(e.checkpoint_commit_sha??'')||
      !HEX.test(e.ciphertext_sha256??'')||
      !HEX.test(e.patch_sha256??'')||
      !Array.isArray(e.file_manifest)||e.file_manifest.length<1||
      e.file_manifest.length>8||
      !SHA.test(target_main_sha??'')||
      e.source_sha!==target_main_sha||
      !positive(publisher_run_id)||
      typeof preflight.patch!=='string'||
      sha256(Buffer.from(preflight.patch))!==e.patch_sha256)
    reject('Qwen Publisher must preflight the exact current-main Worker patch');
  const paths=e.file_manifest.map(x=>x.path);
  if(paths.some(p=>typeof p!=='string'||!p.length)||
      new Set(paths).size!==paths.length||
      e.file_manifest.some(x=>x.operation!=null||
        !HEX.test(x.old_sha256??'')||!HEX.test(x.new_sha256??'')||
        !Number.isSafeInteger(x.old_bytes)||x.old_bytes<0||
        !Number.isSafeInteger(x.new_bytes)||x.new_bytes<0))
    reject('unsafe Qwen Publisher checked-file manifest');
  const record={
    schema_version:1,kind:'trusted_qwen_publisher_write_ahead_intent',
    repository:REPO,issue:e.issue,action_id:e.action_id,
    worker_run_id:e.worker_run_id,worker_run_attempt:1,
    worker_sha:e.worker_sha,source_sha:e.source_sha,
    checkpoint_version:e.checkpoint_version,
    checkpoint_commit_sha:e.checkpoint_commit_sha,
    checkpoint_ciphertext_sha256:e.ciphertext_sha256,
    patch_sha256:e.patch_sha256,
    file_manifest_sha256:sha256(JSON.stringify(e.file_manifest)),
    file_count:e.file_manifest.length,
    target_main_sha,branch:'agent/'+e.issue+'/qwen-'+e.action_id.slice(0,16),
    publisher_run_id,publication:'not_yet_attested',
  };
  return validateQwenPublisherIntent(record);
}
export function validateQwenPublisherIntent(x){
  if(!x||typeof x!=='object'||Array.isArray(x)||
      Object.keys(x).length!==QWEN_INTENT_FIELDS.length||
      Object.keys(x).some(k=>!QWEN_INTENT_FIELDS.includes(k))||
      x.schema_version!==1||
      x.kind!=='trusted_qwen_publisher_write_ahead_intent'||
      x.repository!==REPO||!positive(x.issue)||
      !HEX.test(x.action_id??'')||!positive(x.worker_run_id)||
      x.worker_run_attempt!==1||!SHA.test(x.worker_sha??'')||
      !SHA.test(x.source_sha??'')||!positive(x.checkpoint_version)||
      !SHA.test(x.checkpoint_commit_sha??'')||
      !HEX.test(x.checkpoint_ciphertext_sha256??'')||
      !HEX.test(x.patch_sha256??'')||!HEX.test(x.file_manifest_sha256??'')||
      !positive(x.file_count)||x.file_count>8||
      x.source_sha!==x.target_main_sha||
      x.branch!=='agent/'+x.issue+'/qwen-'+x.action_id.slice(0,16)||
      !positive(x.publisher_run_id)||
      x.publication!=='not_yet_attested')
    reject('malformed or conflicting signed Qwen Publisher Intent');
  return x;
}
export function qwenPublisherIntentPath(record){
  const r=validateQwenPublisherIntent(record);
  return 'workflows/issues/'+r.issue+'/results/'+r.worker_run_id+
    '-'+r.worker_run_attempt+'-'+r.action_id+'.json';
}
function confirmQwenSourceInStore(root,record){
  const current=readIssueWorkflowState(root,record.issue);
  const item=current.state?.outbox.filter(x=>x.id===record.action_id);
  if(current.state?.phase!=='ready'||current.state.target_sha!=null||
      current.state.assignments.developer!=='dev-qwen-01'||
      item?.length!==1||item[0].status!=='dispatched'||
      item[0].task?.role!=='developer'||item[0].task?.task!=='implement'||
      item[0].task?.agent_id!=='dev-qwen-01'||
      item[0].task?.sha!==record.source_sha||
      item[0].receipt?.status!=='verified'||
      item[0].receipt.source_run_id!==record.worker_run_id)
    reject('Qwen Publisher missing exact authenticated Store Outbox');
  const prefix='roles/developer/dev-qwen-01/issues/'+record.issue;
  const saved=json(root,prefix+'/runs/'+record.worker_run_id+'-1.json');
  const cp=prefix+'/checkpoints/'+String(record.checkpoint_version).padStart(8,'0')+'.json';
  const checkpoint=json(root,cp);
  if(saved?.source_sha!==record.source_sha||
      saved.workflow_sha!==record.worker_sha||
      saved.version!==record.checkpoint_version||
      saved.ciphertext_sha256!==record.checkpoint_ciphertext_sha256||
      saved.checkpoint_path!==cp||
      checkpoint?.version!==record.checkpoint_version||
      checkpoint.ciphertext_sha256!==record.checkpoint_ciphertext_sha256||
      checkpoint.metadata?.provider!=='claude-code'||
      checkpoint.metadata.source_sha!==record.source_sha||
      git(root,'log','-1','--format=%H','HEAD','--',cp)!==
        record.checkpoint_commit_sha)
    reject('Qwen Publisher does not own the immutable committed native Run');
  return current;
}
export function commitQwenPublisherIntent({remote,preflight,target_main_sha,
  publisher_run_id}){
  const record=planQwenPublisherIntent({preflight,target_main_sha,publisher_run_id});
  if(typeof remote!=='string'||!remote||/\s/.test(remote)||remote.length>2000)
    reject('invalid scoped Qwen Store writer remote');
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-publisher-intent-'));
  const root=path.join(tmp,'agent-store');
  try{
    try{execFileSync('git',['clone','--quiet','--no-tags','--single-branch',
      '--branch','agent-store','--',remote,root],{stdio:['ignore','pipe','pipe'],
      timeout:45000,env:{...process.env,GIT_TERMINAL_PROMPT:'0',
        GIT_NO_REPLACE_OBJECTS:'1'}});}
    catch{reject('cannot open canonical agent-store for Qwen Publisher');}
    if(git(root,'symbolic-ref','--short','HEAD')!=='agent-store')
      reject('unexpected canonical Store branch');
    confirmQwenSourceInStore(root,record);
    const location=qwenPublisherIntentPath(record);
    const existing=json(root,location);
    if(existing){
      validateQwenPublisherIntent(existing);
      if(JSON.stringify(existing)!==JSON.stringify(record))
        reject('conflicting immutable Qwen Publisher replay');
      return {status:'reconcile',may_publish:false,record,
        store_commit_sha:git(root,'rev-parse','HEAD')};
    }
    const full=path.join(root,location);
    fs.mkdirSync(path.dirname(full),{recursive:true});
    fs.writeFileSync(full,JSON.stringify(record,null,2)+'\n',
      {flag:'wx',mode:0o600});
    git(root,'add','--',location);
    if(auditStagedRunStore(root,'agent-store').checked_changes!==1)
      reject('Qwen intent modifies any other Store path');
    git(root,'-c','user.name=nession-agent-publisher',
      '-c','user.email=nession-agent-publisher@users.noreply.github.com',
      'commit','-m','agent-store: Qwen Publisher write-ahead Issue '+record.issue);
    const committed=publish('agent-store',root,4);
    if(committed.replayed)
      reject('ambiguous Qwen intent CAS; reconcile without a second PR POST');
    return {status:'committed',may_publish:true,record,
      store_commit_sha:committed.commit_sha};
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
}
