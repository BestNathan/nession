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
  'native_checkpoint_commit_sha','expected_files'];
const FILE_FIELDS=['path','blob_sha','mode'];
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>plain(x)&&Object.keys(x).length===keys.length&&
  Object.keys(x).every(k=>keys.includes(k));
function deny(message){throw Error('Qwen Reviewer admission: '+message);}

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
      new Set(a.expected_files.map(f=>f.path)).size!==a.expected_files.length)
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
  actionId,reviewerAgentId='review-qwen-01',
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
      publisherRun.event!=='workflow_run'||publisherRun.head_branch!=='main'||
      publisherRun.head_sha!==record.target_main_sha||
      publisherRun.status!=='completed'||publisherRun.conclusion!=='success'||
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
  }));
}

// A Repair publication updates the SAME PR branch to SHA B. Its commit parent
// is the reviewed SHA A (not main), and the Publisher Run that made the update
// is the repair run. Bind that exact lineage; do not reuse the initial
// publication assumptions.
export function admitQwenRepairPublishedReview({
  state,intent,publisherRun,pullRequests,pr,ref,commit,files,tree,
  actionId,reviewerAgentId='review-qwen-01',
}){
  validateDevelopmentState(state);
  const record=validateQwenRepairPublisherIntent(intent);
  const branch=record.branch.replace(/^refs\/heads\//,'');
  const reviewer=state.outbox.filter(a=>a.id===actionId&&
    a.task?.type==='dispatch'&&a.task.role==='reviewer');
  const publication=state.transitions.filter(t=>t.kind==='publisher'&&
    t.outcome==='published'&&t.target_sha===state.target_sha);
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
      publication[0].run_id!==record.publisher_run_id||
      publication[0].attempt!==1)
    deny('no exact committed Qwen Repair-to-Reviewer Outbox handoff');
  if(publisherRun?.id!==record.publisher_run_id||
      publisherRun.run_attempt!==1||
      publisherRun.name!=='Store / Qwen Publisher'||
      publisherRun.path!=='.github/workflows/store-qwen-publisher.yml'||
      publisherRun.event!=='workflow_run'||publisherRun.head_branch!=='main'||
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
    publisher_run_id:record.publisher_run_id,publisher_attempt:1,
    publisher_intent_sha256:hash(record),publisher_branch:branch,
    original_worker_run_id:record.worker_run_id,
    native_checkpoint_commit_sha:record.checkpoint_commit_sha,
    expected_files:expected,
  }));
}
