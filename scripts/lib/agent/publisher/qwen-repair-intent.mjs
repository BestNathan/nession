// #2137: the same trusted Publisher owns a distinct, immutable write-ahead
// fence for non-force UPDATES of an existing Qwen PR. It must be committed
// before *any* GitHub mutation. Ambiguous writes are reconciled by GET only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readIssueWorkflowState} from '../orchestration/state-store.mjs';
import {qwenCommittedPublisherIntent,qwenCommittedReviewIntent}
  from '../orchestration/qwen-reviewer-source.mjs';
import {verifyCommittedCheckpoint} from '../store/remote.mjs';
import {auditStagedRunStore} from '../../../run-store-integrity.mjs';
import {publish} from '../../../run-store-cas-push.mjs';
import {SOURCE as QWEN_PREWRITE_FAILURE,
  SECOND_SOURCE as SECOND_QWEN_PREWRITE_FAILURE}
  from './qwen-repair-prewrite-failure.mjs';

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
// #3592: a PR-B may already exist after an irreversible non-force ref
// update while Store CAS of the Reviewer handoff fails. A second Publisher
// Run must bind the *original* immutable author/intent and use GET-only
// readback; the new Run ID is not a second authorization to publish.
// All evidence fields other than the executor Run ID must be identical.
export function attestQwenRepairReconciliationIntent(prior,candidate){
  const original=validateQwenRepairPublisherIntent(prior);
  const request=validateQwenRepairPublisherIntent(candidate);
  if(request.publisher_run_id<original.publisher_run_id||
      fields.some(key=>key!=='publisher_run_id'&&
        original[key]!==request[key]))
    fail('conflicting immutable Repair publication replay');
  return original;
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
      latest.target_sha!==record.source_sha||published.length!==1)
    fail('Repair Store lacks latest Reviewer changes_requested for PR SHA A');
  // The current published SHA can belong to a later Repair Publisher.
  // Its predecessor native checkpoint is the exact signed vN origin; the
  // initial Publisher remains the sole PR branch/main identity owner.
  const current=qwenCommittedReviewIntent({storeRoot:root,
    issue:record.issue,publisherRunId:published[0].run_id});
  const precursor=current.record;
  const first=qwenCommittedPublisherIntent({storeRoot:root,issue:record.issue,
    publisherRunId:record.original_publisher_run_id});
  const origin=action[0].task.repair_checkpoint;
  const sourceSha=current.repair?precursor.source_sha:precursor.worker_source_sha;
  if(first.branch!=='agent/'+record.issue+'/qwen-'+
      first.action_id.slice(0,16)||
      'refs/heads/'+first.branch!==record.branch||
      first.target_main_sha!==record.original_main_sha||
      first.publisher_run_id!==record.original_publisher_run_id||
      current.branch!==first.branch||
      precursor.worker_run_id!==origin.source_run_id||
      precursor.checkpoint_version!==origin.checkpoint_version||
      precursor.checkpoint_commit_sha!==origin.checkpoint_commit_sha||
      precursor.checkpoint_ciphertext_sha256!==origin.ciphertext_sha256||
      sourceSha!==origin.source_sha||
      (current.repair&&(
        precursor.original_publisher_run_id!==first.publisher_run_id||
        precursor.original_main_sha!==first.target_main_sha||
        precursor.source_sha===record.source_sha)))
    fail('Repair is not the latest signed checkpoint on original PR lineage');
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
      const original=attestQwenRepairReconciliationIntent(prior,record);
      const author=git(store,'log','-1','--format=%H','HEAD','--',loc);
      if(!SHA.test(author))fail('immutable existing Repair Intent is not committed');
      // Preserve the ORIGINAL run identity (the one whose signed PR-B is
      // already on GitHub); a recovery run cannot mint a fresh write fence.
      // The separate Publisher must now perform only readBackQwenRepairPR
      // before the existing trusted Store handoff CAS.
      return {status:'reconcile',may_publish:false,
        store_commit_sha:author,record:original};
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

 // #4046: real failed original Publisher already committed its immutable WAL
 // but failed before even the first GitHub blob POST. A second Publisher Run
 // CANNOT reuse that WAL by itself. A source-attested, independent failed Run
 // grants at most ONE new durable pre-write recovery. This marker is immutable,
 // has its own canonical Run-store path, and is committed BEFORE any GitHub
 // mutation. Any later invocation is readback-only, not a second write grant.
export function qwenRepairPrewriteRecoveryPath(){
  const f=QWEN_PREWRITE_FAILURE;
  const id=sha256(JSON.stringify([
    f.issue,f.run_id,f.worker_run_id,f.action_id,'prewrite-recovery-v1']));
  return 'workflows/issues/'+f.issue+'/results/'+f.run_id+'-1-'+id+'.json';
}
export function commitQwenRepairPrewriteRecovery({
  remote,intent,source,recovery_run_id,publishStore=publish,
}){
  const f=QWEN_PREWRITE_FAILURE;
  const record=validateQwenRepairPublisherIntent(intent?.record);
  if(intent.status!=='reconcile'||intent.may_publish!==false||
     !SHA.test(intent.store_commit_sha??'')||
     !Number.isSafeInteger(recovery_run_id)||recovery_run_id<=f.run_id||
     record.issue!==f.issue||record.publisher_run_id!==f.run_id||
     record.action_id!==f.action_id||
     record.worker_run_id!==f.worker_run_id||
     record.source_sha!==f.source_sha||
     record.checkpoint_version!==f.checkpoint_version||
     source?.verified!==true||source.issue!==f.issue||
     source.run_id!==f.run_id||source.attempt!==1||
     source.run_head_sha!==f.head_sha||
     source.source_ingest_run_id!==f.source_ingest_run_id||
     source.worker_run_id!==f.worker_run_id||
     source.action_id!==f.action_id||
     source.source_sha!==f.source_sha||
     source.failure_code!==f.failure_code||
     typeof remote!=='string'||!remote||remote.length>2000||
     /\s/.test(remote)||
     (process.env.NODE_ENV!=='test'&&
       !remote.startsWith('https://x-access-token:')))
    fail('failed Publisher pre-write recovery lacks exact independently signed source');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-prewrite-wal-'));
  const root=path.join(temp,'agent-store');
  try{
    try{
      execFileSync('git',['clone','--quiet','--no-tags','--single-branch',
        '--branch','agent-store','--',remote,root],{
        timeout:45000,stdio:['ignore','pipe','pipe'],
        env:{...process.env,GIT_TERMINAL_PROMPT:'0',
          GIT_NO_REPLACE_OBJECTS:'1'}});
    }catch{fail('canonical pre-write recovery agent-store unavailable');}
    if(git(root,'symbolic-ref','--short','HEAD')!=='agent-store')
      fail('invalid pre-write recovery Store branch');
    const originalPath=qwenRepairPublisherIntentPath(record);
    const original=read(root,originalPath);
    const committedAuthor=git(root,'log','-1','--format=%H','HEAD',
      '--',originalPath);
    if(JSON.stringify(original)!==JSON.stringify(record)||
       committedAuthor!==intent.store_commit_sha)
      fail('failed Publisher immutable WAL differs from committed source');
    const location=qwenRepairPrewriteRecoveryPath();
    const prior=read(root,location);
    const claimed={
      schema_version:1,kind:'trusted_qwen_repair_prewrite_recovery_grant',
      repository:REPO,issue:f.issue,
      original_publisher_run_id:f.run_id,
      original_wal_commit_sha:committedAuthor,
      source_ingest_run_id:f.source_ingest_run_id,
      worker_run_id:f.worker_run_id,action_id:f.action_id,
      source_sha:f.source_sha,checkpoint_version:f.checkpoint_version,
      source_run_head_sha:f.head_sha,
      failure_code:f.failure_code,
      recovery_run_id,
      publication:'one_new_write_attempt_not_yet_verified',
    };
    if(prior){
      // Even after an ambiguous first POST/PATCH, an identical Issue command
      // or new job gets NO write authorization. Do not mutate old receipt.
      if(prior.kind!==claimed.kind||
         prior.original_publisher_run_id!==f.run_id||
         prior.original_wal_commit_sha!==committedAuthor||
         prior.source_sha!==f.source_sha||
         prior.worker_run_id!==f.worker_run_id||
         prior.action_id!==f.action_id||
         !Number.isSafeInteger(prior.recovery_run_id)||
         prior.recovery_run_id<=f.run_id)
        fail('conflicting pre-write recovery already committed');
      return {status:'replayed',may_publish:false,
        store_commit_sha:git(root,'log','-1','--format=%H','HEAD','--',location),
        record,source_run_id:f.run_id};
    }
    const state=confirmStore(root,record);
    if(state.version!==f.state_version)
      fail('failed Publisher Store version or target advanced');
    verifyCommittedCheckpoint({remote,identity:{
      role:'developer',agent_id:'dev-qwen-01',issue:f.issue},
      commit_sha:record.checkpoint_commit_sha,
      version:record.checkpoint_version,
      ciphertext_sha256:record.checkpoint_ciphertext_sha256});
    const full=path.join(root,location);
    fs.mkdirSync(path.dirname(full),{recursive:true});
    fs.writeFileSync(full,JSON.stringify(claimed,null,2)+'\n',
      {flag:'wx',mode:0o600});
    git(root,'add','--',location);
    if(auditStagedRunStore(root,'agent-store').checked_changes!==1)
      fail('pre-write recovery mutated foreign Store paths');
    git(root,'-c','user.name=nession-agent-publisher',
      '-c','user.email=nession-agent-publisher@users.noreply.github.com',
      'commit','-m','agent-store: one source-attested Qwen prewrite recovery');
    const saved=publishStore('agent-store',root,4);
    if(saved.replayed)
      fail('ambiguous pre-write recovery Store CAS; deny any GitHub POST');
    return {status:'prewrite_recovery',may_publish:true,
      store_commit_sha:saved.commit_sha,record,
      recovery:Object.freeze({verified:true,
        failed_run_id:f.run_id,run_id:recovery_run_id,
        wal_commit_sha:committedAuthor,
        marker_path:location,marker_store_commit_sha:saved.commit_sha})};
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}

// #4046 second exact failure: the first recovery marker has already been
// consumed by Run 44495243036, but that main-owned script rejected the grant
// during local read-only materialization, before any GitHub POST. Never
// authorize a retry from the first marker: a distinct source-attested second
// CAS is the only route, and is permanently spent after the next attempt.
export function qwenRepairSecondPrewriteRecoveryPath(){
  const f=SECOND_QWEN_PREWRITE_FAILURE;
  const digest=sha256(JSON.stringify([f.issue,f.run_id,f.action_id,
    f.previous_marker_store_sha,'second-prewrite-recovery-v1']));
  return 'workflows/issues/'+f.issue+'/results/'+f.run_id+'-1-'+digest+'.json';
}
export function commitQwenRepairSecondPrewriteRecovery({
  remote,intent,source,second_source,recovery_run_id,
  publishStore=publish,
}){
  const f=QWEN_PREWRITE_FAILURE,g=SECOND_QWEN_PREWRITE_FAILURE;
  const record=validateQwenRepairPublisherIntent(intent?.record);
  if(intent?.status!=='reconcile'||intent.may_publish!==false||
     !SHA.test(intent.store_commit_sha??'')||
     !Number.isSafeInteger(recovery_run_id)||recovery_run_id<=g.run_id||
     record.issue!==f.issue||record.publisher_run_id!==f.run_id||
     record.action_id!==f.action_id||
     record.worker_run_id!==f.worker_run_id||
     record.source_sha!==f.source_sha||
     record.checkpoint_version!==f.checkpoint_version||
     source?.verified!==true||source.issue!==f.issue||
     source.run_id!==f.run_id||source.attempt!==1||
     source.run_head_sha!==f.head_sha||
     source.source_ingest_run_id!==f.source_ingest_run_id||
     source.worker_run_id!==f.worker_run_id||
     source.action_id!==f.action_id||
     source.source_sha!==f.source_sha||
     source.failure_code!==f.failure_code||
     second_source?.verified!==true||second_source.issue!==g.issue||
     second_source.run_id!==g.run_id||second_source.attempt!==1||
     second_source.run_head_sha!==g.head_sha||
     second_source.source_ingest_run_id!==g.source_ingest_run_id||
     second_source.worker_run_id!==g.worker_run_id||
     second_source.action_id!==g.action_id||
     second_source.source_sha!==g.source_sha||
     second_source.failure_code!==g.failure_code||
     second_source.previous_marker_path!==g.previous_marker_path||
     second_source.previous_recovery_run_id!==g.previous_recovery_run_id||
     typeof remote!=='string'||!remote||remote.length>2000||
     /\s/.test(remote)||
     (process.env.NODE_ENV!=='test'&&!remote.startsWith('https://x-access-token:')))
    fail('second pre-write recovery requires both immutable source proofs');
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-prewrite-v2-'));
  const root=path.join(tmp,'agent-store');
  try{
    try{
      execFileSync('git',['clone','--quiet','--no-tags','--single-branch',
        '--branch','agent-store','--',remote,root],{
        timeout:45000,stdio:['ignore','pipe','pipe'],
        env:{...process.env,GIT_TERMINAL_PROMPT:'0',
          GIT_NO_REPLACE_OBJECTS:'1'}});
    }catch{fail('second pre-write Store unavailable');}
    if(git(root,'symbolic-ref','--short','HEAD')!=='agent-store')
      fail('second recovery not on canonical Store branch');
    const originalPath=qwenRepairPublisherIntentPath(record);
    const original=read(root,originalPath);
    const originalAuthor=git(root,'log','-1','--format=%H','HEAD',
      '--',originalPath);
    if(JSON.stringify(original)!==JSON.stringify(record)||
       originalAuthor!==intent.store_commit_sha)
      fail('second recovery immutable original WAL rewritten');
    const first=read(root,g.previous_marker_path);
    const firstAuthor=git(root,'log','-1','--format=%H','HEAD',
      '--',g.previous_marker_path);
    if(firstAuthor!==g.previous_marker_store_sha||
       first?.kind!=='trusted_qwen_repair_prewrite_recovery_grant'||
       first.schema_version!==1||first.repository!==REPO||
       first.issue!==f.issue||
       first.original_publisher_run_id!==f.run_id||
       first.original_wal_commit_sha!==originalAuthor||
       first.source_ingest_run_id!==f.source_ingest_run_id||
       first.worker_run_id!==f.worker_run_id||
       first.action_id!==f.action_id||
       first.source_sha!==f.source_sha||
       first.checkpoint_version!==f.checkpoint_version||
       first.source_run_head_sha!==f.head_sha||
       first.failure_code!==f.failure_code||
       first.recovery_run_id!==g.run_id||
       first.publication!=='one_new_write_attempt_not_yet_verified')
      fail('first consumed pre-write marker or immutable Git author altered');
    const location=qwenRepairSecondPrewriteRecoveryPath();
    const prior=read(root,location);
    const claimed={
      schema_version:1,kind:'trusted_qwen_repair_second_prewrite_recovery_grant',
      repository:REPO,issue:f.issue,
      original_publisher_run_id:f.run_id,
      original_wal_commit_sha:originalAuthor,
      first_recovery_run_id:g.run_id,
      first_recovery_marker_sha:firstAuthor,
      worker_run_id:f.worker_run_id,action_id:f.action_id,
      source_sha:f.source_sha,checkpoint_version:f.checkpoint_version,
      source_run_head_sha:g.head_sha,
      failure_code:g.failure_code,
      recovery_run_id,
      publication:'one_second_write_attempt_not_yet_verified',
    };
    if(prior){
      if(prior.kind!==claimed.kind||
         prior.original_publisher_run_id!==f.run_id||
         prior.original_wal_commit_sha!==originalAuthor||
         prior.first_recovery_run_id!==g.run_id||
         prior.first_recovery_marker_sha!==firstAuthor||
         prior.worker_run_id!==f.worker_run_id||
         prior.action_id!==f.action_id||
         prior.source_sha!==f.source_sha||
         !Number.isSafeInteger(prior.recovery_run_id)||
         prior.recovery_run_id<=g.run_id)
        fail('conflicting second pre-write recovery');
      return {status:'replayed',may_publish:false,
        record,store_commit_sha:git(root,'log','-1','--format=%H',
          'HEAD','--',location)};
    }
    const state=confirmStore(root,record);
    if(state.version!==f.state_version)
      fail('second pre-write recovery Store has changed phase or version');
    verifyCommittedCheckpoint({remote,identity:{
      role:'developer',agent_id:'dev-qwen-01',issue:f.issue},
      commit_sha:record.checkpoint_commit_sha,
      version:record.checkpoint_version,
      ciphertext_sha256:record.checkpoint_ciphertext_sha256});
    const full=path.join(root,location);
    fs.mkdirSync(path.dirname(full),{recursive:true});
    fs.writeFileSync(full,JSON.stringify(claimed,null,2)+'\n',
      {flag:'wx',mode:0o600});
    git(root,'add','--',location);
    if(auditStagedRunStore(root,'agent-store').checked_changes!==1)
      fail('second recovery edited unauthorized Store paths');
    git(root,'-c','user.name=nession-agent-publisher',
      '-c','user.email=nession-agent-publisher@users.noreply.github.com',
      'commit','-m','agent-store: second source-attested Qwen prewrite recovery');
    const saved=publishStore('agent-store',root,4);
    if(saved.replayed)
      fail('ambiguous second pre-write CAS; deny GitHub POST');
    return {status:'prewrite_recovery',may_publish:true,
      store_commit_sha:saved.commit_sha,record,
      recovery:Object.freeze({verified:true,
        failed_run_id:f.run_id,run_id:recovery_run_id,
        wal_commit_sha:originalAuthor,
        marker_path:location,marker_store_commit_sha:saved.commit_sha,
        second_attested:true,second_failed_run_id:g.run_id,
        first_marker_store_sha:firstAuthor})};
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
}
