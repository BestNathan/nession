// #2274/#2137: source-bound admission for a Qwen Publisher's actual PR.
// Only the trusted main Reviewer preparation job reads GitHub + agent-store.
// This module cannot publish a PR, mutate Store, choose a new Agent or
// treat the model's JSON as an authorization. Historical #1997 is separate.
import {createHash} from 'node:crypto';
import {validateDevelopmentState} from '../orchestration/outbox.mjs';
import {validateQwenPublisherIntent} from '../publisher/store-intent.mjs';
import {validateQwenRepairPublisherIntent}
  from '../publisher/qwen-repair-intent.mjs';
import {validPublisherFile} from '../publisher/patch-preflight.mjs';

const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/, HEX=/^[a-f0-9]{64}$/;
const BLOB=/^[a-f0-9]{40}$/;
const ADMISSION_FIELDS=['schema_version','kind','status','repository','issue',
  'role','agent_id','task','review_action_id','pr_number','target_sha',
  'base_sha_at_publication','publisher_run_id','publisher_attempt',
  'publisher_intent_sha256','publisher_branch','original_worker_run_id',
  'native_checkpoint_commit_sha','expected_files','base_files',
  'issue_criteria','issue_criteria_sha256'];
const FILE_FIELDS=['path','blob_sha','mode'];
const BASE_FILE_FIELDS=['path','content'];
const CRITERION_FIELDS=['id','text'];
const MAX_CRITERIA=16,MAX_CRITERIA_BYTES=4096;
const MAX_BASE_FILE=32*1024;
const MAX_BASE_TOTAL=128*1024;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>plain(x)&&Object.keys(x).length===keys.length&&
  Object.keys(x).every(k=>keys.includes(k));
function deny(message){throw Error('Qwen Reviewer admission: '+message);}
// Both trusted Publisher triggers already exist in the main-owned Publisher
// workflow: workflow_run from original Ingest and bot workflow_dispatch after
// Store Ingest's GITHUB_TOKEN suppressed an automatic workflow_run.
// Never accept an arbitrary human/manual Publisher workflow_dispatch.
export function authenticatedQwenPublisherTrigger(run){
  return run?.event==='workflow_run'||
    (run?.event==='workflow_dispatch'&&
      run.actor?.login==='github-actions[bot]');
}
// #4097: the second Repair wrote immutable PR-C through an Owner/main
// recovery of the exact failed write-ahead writer. This is NOT a generic
// issue_comment permission: both the signed A→B→C Store transition and the
// successful reconciler Run must match their frozen identities.
export function attestedQwenRepairPublisherRecovery({
  state,intent,transition,publisherRun,
}){
  const published=state?.transitions?.filter(t=>t.kind==='publisher'&&
    t.outcome==='published')??[];
  return state?.issue===3784&&state.phase==='review'&&
    state.target_sha==='d80e0827ad2d9f2dd548d20fc92b9462681c3094'&&
    state.repair_attempts===2&&
    intent?.issue===3784&&intent.checkpoint_version===3&&
    intent.source_sha==='51f82d64ec159397ea501e6cbb99e7039ee141bd'&&
    intent.original_main_sha==='ec2984381bda57491d764a9ba3e1123a63b89861'&&
    intent.original_publisher_run_id===44281178406&&
    intent.publisher_run_id===44476308903&&
    intent.branch==='refs/heads/agent/3784/qwen-39c01222a8d00fa3'&&
    published.length===3&&
    published[0]?.run_id===44281178406&&
    published[0].target_sha==='5d7e9118b7e954e760cc680fff7d43b4f9e17612'&&
    published[1]?.run_id===44457994853&&
    published[1].target_sha===intent.source_sha&&
    published[2]===transition&&
    transition?.run_id===44497822207&&
    transition.attempt===1&&transition.outcome==='published'&&
    transition.target_sha===state.target_sha&&
    transition.write_ahead_publisher_run_id===intent.publisher_run_id&&
    publisherRun?.id===44497822207&&
    publisherRun.run_attempt===1&&
    publisherRun.name==='Store / Qwen Publisher'&&
    publisherRun.path==='.github/workflows/store-qwen-publisher.yml'&&
    publisherRun.event==='issue_comment'&&
    publisherRun.actor?.login==='BestNathan'&&
    publisherRun.head_branch==='main'&&
    publisherRun.head_sha==='01bbda0509faa05ec0b3e8e025e2600cd48cc447'&&
    publisherRun.status==='completed'&&publisherRun.conclusion==='success'&&
    publisherRun.repository?.full_name===REPO&&
    publisherRun.head_repository?.full_name===REPO;
}
// #3885: original Qwen Publisher wrote PR #3919 and failed *after* its
// GitHub POST. A distinct Owner-authenticated GET-only Publisher recovery
// verified the same PR/Store Intent and advanced the signed Issue Store.
// Do not pretend the original Run succeeded. This narrow dual-Run proof
// preserves both historical outcomes; never authorize an arbitrary failure.
export function attestedQwenInitialPublisherRecovery({
  issue,intent,publisherRun,recoveryRun,
}){
  return issue===3784&&intent?.issue===3784&&
    intent.publisher_run_id===44281178406&&
    intent.target_main_sha==='ec2984381bda57491d764a9ba3e1123a63b89861'&&
    intent.branch==='agent/3784/qwen-39c01222a8d00fa3'&&
    publisherRun?.id===44281178406&&publisherRun.run_attempt===1&&
    publisherRun.name==='Store / Qwen Publisher'&&
    publisherRun.path==='.github/workflows/store-qwen-publisher.yml'&&
    publisherRun.event==='workflow_run'&&
    publisherRun.head_branch==='main'&&
    publisherRun.head_sha===intent.target_main_sha&&
    publisherRun.status==='completed'&&publisherRun.conclusion==='failure'&&
    publisherRun.repository?.full_name===REPO&&
    publisherRun.head_repository?.full_name===REPO&&
    recoveryRun?.id===44431297473&&recoveryRun.run_attempt===1&&
    recoveryRun.name==='Store / Qwen Publisher'&&
    recoveryRun.path==='.github/workflows/store-qwen-publisher.yml'&&
    recoveryRun.event==='issue_comment'&&
    recoveryRun.actor?.login==='BestNathan'&&
    recoveryRun.head_branch==='main'&&
    recoveryRun.head_sha==='08f841bf796977a91ff745eb0763559ea67dec51'&&
    recoveryRun.status==='completed'&&recoveryRun.conclusion==='success'&&
    recoveryRun.repository?.full_name===REPO&&
    recoveryRun.head_repository?.full_name===REPO;
}

export function assertQwenReviewerAdmission(a,identity={agent_id:'review-qwen-01'}){
  if(!exact(a,ADMISSION_FIELDS)||a.schema_version!==1||
      a.kind!=='authenticated_qwen_reviewer_admission_only'||
      a.status!=='await_native_reviewer'||a.repository!==REPO||
      !Number.isSafeInteger(a.issue)||a.issue<1||a.role!=='reviewer'||
      a.agent_id!=='review-qwen-01'||identity?.agent_id!==a.agent_id||
      a.task!=='review'||!HEX.test(a.review_action_id??'')||
      !Number.isSafeInteger(a.pr_number)||a.pr_number<1||
      !SHA.test(a.target_sha??'')||!SHA.test(a.base_sha_at_publication??'')||
      !Number.isSafeInteger(a.publisher_run_id)||a.publisher_run_id<1||
      a.publisher_attempt!==1||!HEX.test(a.publisher_intent_sha256??'')||
      typeof a.publisher_branch!=='string'||
      !Number.isSafeInteger(a.original_worker_run_id)||
      a.original_worker_run_id<1||
      !SHA.test(a.native_checkpoint_commit_sha??'')||
      !Array.isArray(a.expected_files)||a.expected_files.length<1||
      a.expected_files.length>8||
      a.expected_files.some(f=>!exact(f,FILE_FIELDS)||!BLOB.test(f.blob_sha??'')||
        f.mode!=='100644'||typeof f.path!=='string'||
        !isAllowedFile(f.path))||
      new Set(a.expected_files.map(f=>f.path)).size!==a.expected_files.length||
      !Array.isArray(a.base_files)||a.base_files.length>a.expected_files.length||
      a.base_files.some(f=>!exact(f,BASE_FILE_FIELDS)||
        typeof f.path!=='string'||!isAllowedFile(f.path)||
        typeof f.content!=='string'||!f.content.length||
        Buffer.byteLength(f.content)>MAX_BASE_FILE)||
      new Set(a.base_files.map(f=>f.path)).size!==a.base_files.length||
      (a.base_files.length>0&&
        (a.base_files.length!==a.expected_files.length||
         a.base_files.some(f=>!a.expected_files.some(e=>e.path===f.path))))||
      a.base_files.reduce((n,f)=>n+Buffer.byteLength(f.content),0)>MAX_BASE_TOTAL||
      !Array.isArray(a.issue_criteria)||a.issue_criteria.length<1||
      a.issue_criteria.length>MAX_CRITERIA||
      a.issue_criteria.some(c=>!exact(c,CRITERION_FIELDS)||
        !/^SC-[0-9]{2,}$/.test(c.id??'')||typeof c.text!=='string'||
        !c.text.trim()||c.text!==c.text.trim()||
        Buffer.byteLength(c.text)>1200)||
      new Set(a.issue_criteria.map(c=>c.id)).size!==a.issue_criteria.length||
      Buffer.byteLength(JSON.stringify(a.issue_criteria))>MAX_CRITERIA_BYTES||
      !HEX.test(a.issue_criteria_sha256??'')||
      a.issue_criteria_sha256!==hash({issue:a.issue,criteria:a.issue_criteria}))
    deny('invalid source-bound Reviewer admission');
  // The branch name is produced by a committed Publisher Intent, never a
  // Reviewer-supplied action or a model-supplied PR target.
  if(!/^agent\/[1-9]\d*\/qwen-[a-f0-9]{16}$/.test(a.publisher_branch)||
     !a.publisher_branch.startsWith('agent/'+a.issue+'/qwen-'))
    deny('unbound published branch');
  return a;
}
function isAllowedFile(path){
  try{validPublisherFile(path);return true;}catch{return false;}
}

function expectedReviewFiles(files,tree){
  if(!Array.isArray(files)||files.length<1||files.length>8||
      !Array.isArray(tree?.tree)||
      new Set(files.map(f=>f.filename)).size!==files.length)
    deny('Qwen PR changed-file list is incomplete');
  return files.map(file=>{
    const entry=tree.tree.find(x=>x.path===file.filename);
    if(file.status!=='modified'||!isAllowedFile(file.filename)||
        !BLOB.test(file.sha??'')||!entry||
        entry.mode!=='100644'||entry.type!=='blob'||
        entry.sha!==file.sha)
      deny('PR modification does not match allowed regular Git tree blob');
    return {path:file.filename,blob_sha:file.sha,mode:'100644'};
  }).sort((a,b)=>a.path.localeCompare(b.path));
}

export function admitQwenPublishedReview({
  state,intent,publisherRun,pullRequests,pr,ref,commit,files,tree,
  actionId,reviewerAgentId='review-qwen-01',base_files=[],
  issue_criteria=[],recoveryRun=null,
}){
  validateDevelopmentState(state);
  const record=validateQwenPublisherIntent(intent);
  const reviewer=state.outbox.filter(a=>a.id===actionId&&
    a.task?.type==='dispatch'&&a.task.role==='reviewer');
  const publication=state.transitions.filter(t=>t.kind==='publisher'&&
    t.outcome==='published'&&t.target_sha===state.target_sha);
  if(state.issue!==record.issue||state.phase!=='review'||
      state.target_sha==null||state.target_sha===record.source_sha||
      state.target_sha!==pr?.head?.sha||
      state.assignments?.developer!=='dev-qwen-01'||
      state.assignments?.reviewer!==reviewerAgentId||
      reviewerAgentId!=='review-qwen-01'||
      !HEX.test(actionId??'')||reviewer.length!==1||
      !['pending','dispatched'].includes(reviewer[0].status)||
      reviewer[0].task.agent_id!==reviewerAgentId||
      reviewer[0].task.sha!==state.target_sha||
      reviewer[0].task.task!=='review'||publication.length!==1||
      publication[0].run_id!==record.publisher_run_id||
      publication[0].attempt!==1||
      record.source_sha!==record.target_main_sha)
    deny('no exact committed Qwen Publisher-to-Reviewer Outbox handoff');
  if(publisherRun?.id!==record.publisher_run_id||
      publisherRun.run_attempt!==1||
      publisherRun.name!=='Store / Qwen Publisher'||
      publisherRun.path!=='.github/workflows/store-qwen-publisher.yml'||
      !(authenticatedQwenPublisherTrigger(publisherRun)&&
          publisherRun.conclusion==='success'||
        attestedQwenInitialPublisherRecovery({
          issue:state.issue,intent:record,publisherRun,recoveryRun}))||
      publisherRun.head_branch!=='main'||
      publisherRun.head_sha!==record.target_main_sha||
      publisherRun.status!=='completed'||
      publisherRun.repository?.full_name!==REPO||
      publisherRun.head_repository?.full_name!==REPO)
    deny('Publisher Run/Attempt is not independently authenticated');
  if(!Array.isArray(pullRequests)||pullRequests.length!==1||
      pullRequests[0]?.number!==pr?.number||
      pr.number<1||pr.state!=='open'||pr.draft!==false||
      pr.merged_at!=null||pr.head?.ref!==record.branch||
      pr.head?.repo?.full_name!==REPO||
      pr.base?.ref!=='main'||pr.base?.repo?.full_name!==REPO||
      pr.head?.sha!==state.target_sha||
      ref?.ref!=='refs/heads/'+record.branch||
      ref.object?.sha!==state.target_sha||
      commit?.sha!==state.target_sha||
      !Array.isArray(commit.parents)||commit.parents.length!==1||
      commit.parents[0]?.sha!==record.target_main_sha||
      !SHA.test(commit.tree?.sha??'')||
      tree?.sha!==commit.tree.sha||tree.truncated===true)
    deny('Qwen PR identity, source parent, ref or Git tree changed');
  if(!Array.isArray(files)||files.length!==record.file_count)
    deny('Qwen PR changed-file list is incomplete');
  const expected=expectedReviewFiles(files,tree);
  return Object.freeze(assertQwenReviewerAdmission({
    schema_version:1,kind:'authenticated_qwen_reviewer_admission_only',
    status:'await_native_reviewer',repository:REPO,issue:record.issue,
    role:'reviewer',agent_id:reviewerAgentId,task:'review',
    review_action_id:actionId,pr_number:pr.number,target_sha:state.target_sha,
    base_sha_at_publication:record.target_main_sha,
    publisher_run_id:record.publisher_run_id,publisher_attempt:1,
    publisher_intent_sha256:hash(record),publisher_branch:record.branch,
    original_worker_run_id:record.worker_run_id,
    native_checkpoint_commit_sha:record.checkpoint_commit_sha,
    expected_files:expected,
    base_files,
    issue_criteria,issue_criteria_sha256:hash({issue:record.issue,criteria:issue_criteria}),
  }));
}

// A Repair publication updates the SAME PR branch to SHA B. Its commit parent
// is the reviewed SHA A (not main), and the Publisher Run that made the update
// is the repair run. Bind that exact lineage; do not reuse the initial
// publication assumptions.
export function admitQwenRepairPublishedReview({
  state,intent,publisherRun,pullRequests,pr,ref,commit,files,tree,
  actionId,reviewerAgentId='review-qwen-01',base_files=[],
  issue_criteria=[],
}){
  validateDevelopmentState(state);
  const record=validateQwenRepairPublisherIntent(intent);
  const branch=record.branch.replace(/^refs\/heads\//,'');
  const reviewer=state.outbox.filter(a=>a.id===actionId&&
    a.task?.type==='dispatch'&&a.task.role==='reviewer');
  const publication=state.transitions.filter(t=>t.kind==='publisher'&&
    t.outcome==='published'&&t.target_sha===state.target_sha);
  // An exact PR-B recovery is written to Store by a second successful
  // Publisher Run. Its prior PR writer is immutable lineage, not a falsely
  // successful source; the Store transition binds both original and current.
  const sourcePublisher=publication.length===1?publication[0]:null;
  const effectivePublisherRunId=sourcePublisher?.run_id;
  const reconciled=sourcePublisher?.write_ahead_publisher_run_id!==undefined;
  const validPublisherLineage=reconciled
    ?sourcePublisher.write_ahead_publisher_run_id===record.publisher_run_id&&
      effectivePublisherRunId>record.publisher_run_id
    :effectivePublisherRunId===record.publisher_run_id;
  if(state.issue!==record.issue||state.phase!=='review'||
      state.target_sha==null||state.target_sha===record.source_sha||
      state.target_sha!==pr?.head?.sha||
      state.assignments?.developer!=='dev-qwen-01'||
      state.assignments?.reviewer!==reviewerAgentId||
      !HEX.test(actionId??'')||reviewer.length!==1||
      !['pending','dispatched'].includes(reviewer[0].status)||
      reviewer[0].task.agent_id!==reviewerAgentId||
      reviewer[0].task.sha!==state.target_sha||
      reviewer[0].task.task!=='review'||publication.length!==1||
      !validPublisherLineage||publication[0].attempt!==1)
    deny('no exact committed Qwen Repair-to-Reviewer Outbox handoff');
  if(publisherRun?.id!==effectivePublisherRunId||
      publisherRun.run_attempt!==1||
      publisherRun.name!=='Store / Qwen Publisher'||
      publisherRun.path!=='.github/workflows/store-qwen-publisher.yml'||
      !(authenticatedQwenPublisherTrigger(publisherRun)||
         attestedQwenRepairPublisherRecovery({
           state,intent:record,transition:sourcePublisher,publisherRun}))||
       publisherRun.head_branch!=='main'||
      !SHA.test(publisherRun.head_sha??'')||
      publisherRun.status!=='completed'||publisherRun.conclusion!=='success'||
      publisherRun.repository?.full_name!==REPO||
      publisherRun.head_repository?.full_name!==REPO)
    deny('Repair Publisher Run/Attempt is not independently authenticated');
  if(!Array.isArray(pullRequests)||pullRequests.length!==1||
      pullRequests[0]?.number!==pr?.number||
      pr.number<1||pr.state!=='open'||pr.draft!==false||
      pr.merged_at!=null||pr.head?.ref!==branch||
      pr.head?.repo?.full_name!==REPO||
      pr.base?.ref!=='main'||pr.base?.repo?.full_name!==REPO||
      pr.head?.sha!==state.target_sha||
      ref?.ref!==record.branch||ref.object?.sha!==state.target_sha||
      commit?.sha!==state.target_sha||
      !Array.isArray(commit.parents)||commit.parents.length!==1||
      commit.parents[0]?.sha!==record.source_sha||
      !SHA.test(commit.tree?.sha??'')||
      tree?.sha!==commit.tree.sha||tree.truncated===true)
    deny('Repair PR identity, SHA A parent, ref or Git tree changed');
  if(!Array.isArray(files)||files.length!==record.file_count)
    deny('Qwen Repair PR changed-file list is incomplete');
  const expected=expectedReviewFiles(files,tree);
  return Object.freeze(assertQwenReviewerAdmission({
    schema_version:1,kind:'authenticated_qwen_reviewer_admission_only',
    status:'await_native_reviewer',repository:REPO,issue:record.issue,
    role:'reviewer',agent_id:reviewerAgentId,task:'review',
    review_action_id:actionId,pr_number:pr.number,target_sha:state.target_sha,
    base_sha_at_publication:record.original_main_sha,
    publisher_run_id:effectivePublisherRunId,publisher_attempt:1,
    publisher_intent_sha256:hash(record),publisher_branch:branch,
    original_worker_run_id:record.worker_run_id,
    native_checkpoint_commit_sha:record.checkpoint_commit_sha,
    expected_files:expected,
    base_files,
    issue_criteria,issue_criteria_sha256:hash({issue:record.issue,criteria:issue_criteria}),
  }));
}
