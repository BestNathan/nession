// #2137: the same trusted Publisher owns a distinct, immutable write-ahead
// fence for non-force UPDATES of an existing Qwen PR. It must be committed
// before *any* GitHub mutation. Ambiguous writes are reconciled by GET only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readIssueWorkflowState} from '../orchestration/state-store.mjs';
import {qwenCommittedPublisherIntent}
  from '../orchestration/qwen-reviewer-source.mjs';
import {verifyCommittedCheckpoint} from '../store/remote.mjs';
import {auditStagedRunStore} from '../../../run-store-integrity.mjs';
import {publish} from '../../../run-store-cas-push.mjs';

const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/,HEX=/^[a-f0-9]{64}$/;
const BRANCH=/^refs\/heads\/agent\/([1-9][0-9]*)\/qwen-([a-f0-9]{16})$/;
const fields=['schema_version','kind','repository','issue','action_id',
  'worker_run_id','worker_run_attempt','worker_sha','source_sha',
  'original_main_sha','original_publisher_run_id','branch',
  'checkpoint_version','checkpoint_commit_sha','checkpoint_ciphertext_sha256',
  'patch_sha256','file_manifest_sha256','file_count',
  'publisher_run_id','publication'];
const positive=x=>Number.isSafeInteger(x)&&x>0;
const sha256=x=>createHash('sha256').update(x).digest('hex');
function fail(s){throw Error('Qwen Repair write-ahead: '+s);}
function git(root,...args){
  try{return execFileSync('git',['-C',root,...args],{
    encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:45000,
    maxBuffer:2*1024*1024,env:{...process.env,
      GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'}}).trim();}
  catch{fail('authenticated Store Git '+args[0]+' failed');}
}
function read(root,relative,max=8192){
  const full=path.join(root,relative);
  const stat=fs.lstatSync(full,{throwIfNoEntry:false});
  if(!stat)return null;
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>max)
    fail('unsafe immutable Store record');
  try{return JSON.parse(fs.readFileSync(full,'utf8'));}
  catch{fail('corrupt immutable Store record');}
}
export function validateQwenRepairPublisherIntent(record){
  if(!record||typeof record!=='object'||Array.isArray(record)||
      Object.keys(record).length!==fields.length||
      Object.keys(record).some(x=>!fields.includes(x))||
      record.schema_version!==1||
      record.kind!=='trusted_qwen_repair_publisher_write_ahead'||
      record.repository!==REPO||
      !positive(record.issue)||!HEX.test(record.action_id??'')||
      !positive(record.worker_run_id)||record.worker_run_attempt!==1||
      !SHA.test(record.worker_sha??'')||
      !SHA.test(record.source_sha??'')||
      !SHA.test(record.original_main_sha??'')||
      record.source_sha===record.original_main_sha||
      !positive(record.original_publisher_run_id)||
      !BRANCH.test(record.branch??'')||
      record.branch!=='refs/heads/agent/'+record.issue+'/qwen-'+
        (record.branch?.split('/').at(-1)?.slice(5)??'')||
      !positive(record.checkpoint_version)||record.checkpoint_version<2||
      !SHA.test(record.checkpoint_commit_sha??'')||
      !HEX.test(record.checkpoint_ciphertext_sha256??'')||
      !HEX.test(record.patch_sha256??'')||
      !HEX.test(record.file_manifest_sha256??'')||
      !positive(record.file_count)||record.file_count>8||
      !positive(record.publisher_run_id)||
      record.publication!=='not_yet_attested')
    fail('invalid exact Repair Publisher immutable Intent');
  return record;
}
export function planQwenRepairPublisherIntent({preflight,publisher_run_id}){
  const e=preflight?.evidence,origin=preflight?.origin;
  if(e?.schema_version!==1||
      e.kind!=='trusted_qwen_repair_preflight_only'||
      e.status!=='preflight_only'||!positive(e.issue)||
      !HEX.test(e.action_id??'')||!positive(e.developer_run_id)||
      !SHA.test(e.worker_sha??'')||
      !SHA.test(e.source_sha??'')||
      !SHA.test(e.original_main_sha??'')||
      !positive(e.original_publisher_run_id)||
      !SHA.test(e.checkpoint_commit_sha??'')||
      !HEX.test(e.ciphertext_sha256??'')||
      !positive(e.checkpoint_version)||!HEX.test(e.patch_sha256??'')||
      !Array.isArray(e.file_manifest)||e.file_manifest.length<1||
      e.file_manifest.length>8||
      e.file_manifest.some(f=>typeof f.path!=='string'||f.operation!=null||
        !HEX.test(f.old_sha256??'')||!HEX.test(f.new_sha256??'')||
        !Number.isSafeInteger(f.old_bytes)||f.old_bytes<0||
        !Number.isSafeInteger(f.new_bytes)||f.new_bytes<0)||
      new Set(e.file_manifest.map(f=>f.path)).size!==e.file_manifest.length||
      typeof preflight.patch!=='string'||
      sha256(Buffer.from(preflight.patch))!==e.patch_sha256||
      origin?.review_sha!==e.source_sha||
      origin?.branch!==e.original_pr_branch||
      origin?.original_main_sha!==e.original_main_sha||
      origin?.original_publisher_run_id!==e.original_publisher_run_id||
      origin?.repair_checkpoint_version!==e.checkpoint_version||
      origin?.repair_checkpoint_commit_sha!==e.checkpoint_commit_sha||
      !positive(publisher_run_id))
    fail('no signed Qwen Repair Publisher preflight');
  return validateQwenRepairPublisherIntent({
    schema_version:1,kind:'trusted_qwen_repair_publisher_write_ahead',
    repository:REPO,issue:e.issue,action_id:e.action_id,
    worker_run_id:e.developer_run_id,worker_run_attempt:1,
    worker_sha:e.worker_sha,source_sha:e.source_sha,
    original_main_sha:e.original_main_sha,
    original_publisher_run_id:e.original_publisher_run_id,
    branch:e.original_pr_branch,
    checkpoint_version:e.checkpoint_version,
    checkpoint_commit_sha:e.checkpoint_commit_sha,
    checkpoint_ciphertext_sha256:e.ciphertext_sha256,
    patch_sha256:e.patch_sha256,
    file_manifest_sha256:sha256(JSON.stringify(e.file_manifest)),
    file_count:e.file_manifest.length,
    publisher_run_id,publication:'not_yet_attested',
  });
}
export function qwenRepairPublisherIntentPath(record){
  const x=validateQwenRepairPublisherIntent(record);
  return 'workflows/issues/'+x.issue+'/results/'+x.worker_run_id+
    '-1-'+x.action_id+'.json';
}
function confirmStore(root,record){
  const {state}=readIssueWorkflowState(root,record.issue);
  const action=state?.outbox.filter(x=>x.id===record.action_id);
  if(state?.phase!=='repair'||state.target_sha!==record.source_sha||
      state.assignments?.developer!=='dev-qwen-01'||
      state.assignments?.reviewer!=='review-qwen-01'||
      action?.length!==1||action[0].status!=='dispatched'||
      action[0].task?.role!=='developer'||
      action[0].task?.task!=='repair'||
      action[0].task?.agent_id!=='dev-qwen-01'||
      action[0].task.sha!==record.source_sha||
      action[0].receipt?.status!=='verified'||
      action[0].receipt.source_run_id!==record.worker_run_id||
      action[0].receipt.dispatch_id!==record.action_id||
      action[0].task.repair_checkpoint?.checkpoint_version!==
        record.checkpoint_version-1)
    fail('Repair Store no longer owns signed Action and native predecessor');
  const latest=state.transitions.at(-1);
  const published=state.transitions.filter(t=>t.kind==='publisher'&&
    t.outcome==='published'&&t.target_sha===state.target_sha);
  if(latest?.kind!=='reviewer'||latest.outcome!=='changes_requested'||
      latest.target_sha!==record.source_sha||
      published.length!==1||
      published[0].run_id!==record.original_publisher_run_id)
    fail('Repair Store lacks latest Reviewer changes_requested for PR SHA A');
  const first=qwenCommittedPublisherIntent({storeRoot:root,issue:record.issue,
    publisherRunId:record.original_publisher_run_id});
  if(first.branch!=='agent/'+record.issue+'/qwen-'+
      first.action_id.slice(0,16)||
      'refs/heads/'+first.branch!==record.branch||
      first.target_main_sha!==record.original_main_sha||
      first.worker_run_id!==action[0].task.repair_checkpoint?.source_run_id||
      first.checkpoint_commit_sha!==
        action[0].task.repair_checkpoint?.checkpoint_commit_sha)
    fail('Repair is not the same immutable original Publisher lineage');
  const prefix='roles/developer/dev-qwen-01/issues/'+record.issue;
  const run=read(root,prefix+'/runs/'+record.worker_run_id+'-1.json');
  if(run?.version!==record.checkpoint_version||
      run.source_sha!==record.source_sha||
      run.workflow_sha!==record.worker_sha||
      run.ciphertext_sha256!==record.checkpoint_ciphertext_sha256||
      run.checkpoint_path!==prefix+'/checkpoints/'+
        String(record.checkpoint_version).padStart(8,'0')+'.json')
    fail('Repair Run has no exact committed native ciphertext receipt');
  return state;
}
export function commitQwenRepairPublisherIntent({
  remote,preflight,publisher_run_id,publishStore=publish,
}){
  const record=planQwenRepairPublisherIntent({preflight,publisher_run_id});
  if(typeof remote!=='string'||!remote||remote.length>2000||
      /\s/.test(remote)||
      (process.env.NODE_ENV!=='test'&&!remote.startsWith('https://x-access-token:')))
    fail('separately scoped trusted Store writer remote required');
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-repair-wal-'));
  const store=path.join(tmp,'agent-store');
  try{
    try{
      execFileSync('git',['clone','--quiet','--no-tags','--single-branch',
        '--branch','agent-store','--',remote,store],{
        timeout:45000,stdio:['ignore','pipe','pipe'],
        env:{...process.env,GIT_TERMINAL_PROMPT:'0',
          GIT_NO_REPLACE_OBJECTS:'1'}});
    }catch{fail('canonical agent-store unavailable');}
    if(git(store,'symbolic-ref','--short','HEAD')!=='agent-store')
      fail('Store is not the canonical orphan branch');
    const loc=qwenRepairPublisherIntentPath(record);
    const prior=read(store,loc);
    if(prior){
      if(JSON.stringify(validateQwenRepairPublisherIntent(prior))!==
          JSON.stringify(record))
        fail('conflicting immutable Repair publication replay');
      const author=git(store,'log','-1','--format=%H','HEAD','--',loc);
      if(!SHA.test(author))fail('immutable existing Repair Intent is not committed');
      return {status:'reconcile',may_publish:false,store_commit_sha:author,record};
    }
    confirmStore(store,record);
    verifyCommittedCheckpoint({remote,identity:{
      role:'developer',agent_id:'dev-qwen-01',issue:record.issue},
      commit_sha:record.checkpoint_commit_sha,
      version:record.checkpoint_version,
      ciphertext_sha256:record.checkpoint_ciphertext_sha256});
    const full=path.join(store,loc);
    fs.mkdirSync(path.dirname(full),{recursive:true});
    fs.writeFileSync(full,JSON.stringify(record,null,2)+'\n',
      {flag:'wx',mode:0o600});
    git(store,'add','--',loc);
    if(auditStagedRunStore(store,'agent-store').checked_changes!==1)
      fail('Repair Intent modified unrelated Store paths');
    git(store,'-c','user.name=nession-agent-publisher',
      '-c','user.email=nession-agent-publisher@users.noreply.github.com',
      'commit','-m','agent-store: Qwen Repair PR update fence Issue '+record.issue);
    const pushed=publishStore('agent-store',store,4);
    if(pushed.replayed)fail('ambiguous Repair Intent CAS, GET-only reconciliation');
    return {status:'committed',may_publish:true,
      store_commit_sha:pushed.commit_sha,record};
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
}
