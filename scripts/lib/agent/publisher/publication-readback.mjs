// #2181: read-only reconciliation of a REAL, originally published #1997 PR.
// Model-supplied PR number, Issue text, current HEAD or a self-reported
// Publisher status are never substitutes for independent GitHub/Store reads.
// This module has no Writer token, GitHub POST, Store push or model call.
import {CONTROLLED_1997_POLICY as SOURCE} from './controlled-proposal.mjs';
import {CONTROLLED_PUBLISHER_BRANCH as BRANCH,
  validateControlledPublisherIntent} from './store-intent.mjs';

const REPO='BestNathan/nession';
const ORIGINAL_PUBLISHER_RUN=39609600546;
const ORIGINAL_PUBLISHER_MAIN_SHA='c6894b59b8be9448cae3c68fd87593516f66b47a';
const ORIGINAL_PR=2176;
const ORIGINAL_PR_SHA='3d8e3807cc01f6082734b8d0ba458217c28f60a4';
const ORIGINAL_COMMENT=6317468284;
const PATCH_SHA='1f45a088966d41c1fcade13540498693d7d083ca238ca2b06c0525c654e314ee';
const ORIGINAL_BLOB_SHA='c43fc9a41c1c8cd49bb8128a725e0cac6f4acb3f';
const COMMAND='/nession publish issue=1997 worker_run=39448549052 checkpoint=3';
const SHA=/^[a-f0-9]{40}$/;
function reject(reason){throw Error('Publisher original PR readback: '+reason);}
function eq(a,b,field){if(a!==b)reject('untrusted '+field);}
function validObj(x){return x&&typeof x==='object'&&!Array.isArray(x);}
export const CONTROLLED_ORIGINAL_PUBLICATION=Object.freeze({
  publisher_run:ORIGINAL_PUBLISHER_RUN,
  publisher_main_sha:ORIGINAL_PUBLISHER_MAIN_SHA,
  original_pr:ORIGINAL_PR,
  original_pr_sha:ORIGINAL_PR_SHA,
  command_comment_id:ORIGINAL_COMMENT,
  branch:BRANCH,
  original_patch_sha256:PATCH_SHA,
  original_blob_sha:ORIGINAL_BLOB_SHA,
});

// A historical publication receipt remains true if a later authenticated
// Reviewer/Developer repair updates the same PR SHA. Such a later PR HEAD does
// not rewrite its first immutable source commit or original Store intent.
export function verifyControlledOriginalPublication({
  sourceRun,sourceJobs,ownerComment,intent,
  pullRequest,branchRef,pullCommits,originalCommit,originalFiles,
  currentFiles,branchPulls,
}){
  if(!validObj(sourceRun)||!validObj(sourceJobs)||!validObj(ownerComment)||
     !validObj(intent)||!validObj(pullRequest)||!validObj(branchRef)||
     !validObj(originalCommit))reject('missing independently retrieved source');
  eq(sourceRun.id,ORIGINAL_PUBLISHER_RUN,'Publisher Run ID');
  eq(sourceRun.run_attempt,1,'Publisher attempt');
  eq(sourceRun.name,'Store / Controlled Publisher','trusted workflow name');
  eq(sourceRun.path,'.github/workflows/store-controlled-publisher.yml','workflow path');
  eq(sourceRun.event,'issue_comment','event type');
  eq(sourceRun.actor?.login,'BestNathan','Publisher actor');
  eq(sourceRun.head_branch,'main','Publisher ref');
  eq(sourceRun.head_sha,ORIGINAL_PUBLISHER_MAIN_SHA,'Publisher source SHA');
  eq(sourceRun.repository?.full_name,REPO,'Publisher repository');
  eq(sourceRun.head_repository?.full_name,REPO,'Publisher head repository');
  eq(sourceRun.status,'completed','Publisher Run completion');
  eq(sourceRun.conclusion,'success','Publisher Run result');
  if(!Array.isArray(sourceJobs.jobs)||sourceJobs.jobs.length!==1||
     sourceJobs.total_count!==1||
     sourceJobs.jobs[0].run_id!==ORIGINAL_PUBLISHER_RUN||
     sourceJobs.jobs[0].name!=='publish'||
     sourceJobs.jobs[0].status!=='completed'||
     sourceJobs.jobs[0].conclusion!=='success')
    reject('no authenticated unique successful Publisher job');
  eq(ownerComment.id,ORIGINAL_COMMENT,'exact owner comment ID');
  eq(ownerComment.user?.login,'BestNathan','owner comment actor');
  eq(ownerComment.issue_url,'https://api.github.com/repos/'+REPO+'/issues/1997',
    'owner comment Issue');
  eq(ownerComment.body,COMMAND,'owner comment exact command');
  // This owner posted the exact same command earlier. The successful
  // Publisher Run is linked to the *later* comment via source creation time.
  // Actor, Issue and command text alone are insufficient event provenance.
  const ownerCreated=Date.parse(ownerComment.created_at??'');
  const publisherCreated=Date.parse(sourceRun.created_at??'');
  if(!Number.isFinite(ownerCreated)||!Number.isFinite(publisherCreated)||
      publisherCreated<ownerCreated||publisherCreated-ownerCreated>120000)
    reject('owner comment is not the actual temporally bounded Publisher wake');

  const record=validateControlledPublisherIntent(intent);
  eq(record.publisher_issuer_run_id,sourceRun.id,'immutable Publisher issuer');
  eq(record.target_main_sha,sourceRun.head_sha,'original target main SHA');
  eq(record.action_id,SOURCE.action_id,'source action');
  eq(record.worker_run_id,SOURCE.run_id,'original Worker Run');
  eq(record.worker_run_attempt,1,'original Worker attempt');
  eq(record.checkpoint_version,SOURCE.checkpoint_version,'native checkpoint');
  eq(record.checkpoint_commit_sha,SOURCE.checkpoint_commit_sha,'native checkpoint commit');
  eq(record.checkpoint_ciphertext_sha256,SOURCE.checkpoint_ciphertext_sha256,
    'native encrypted digest');
  eq(record.source_claim_artifact_id,SOURCE.claim_artifact_id,'claim Artifact');
  eq(record.source_result_artifact_id,SOURCE.result_artifact_id,'result Artifact');
  eq(record.source_ingest_run_id,SOURCE.ingester_run_id,'authenticated source Ingest');
  eq(record.patch_sha256,PATCH_SHA,'published original patch digest');
  eq(record.branch,BRANCH,'immutable target branch');

  eq(pullRequest.number,ORIGINAL_PR,'real GitHub PR');
  if(!['open','closed'].includes(pullRequest.state))reject('invalid PR lifecycle');
  eq(pullRequest.base?.ref,'main','base branch');
  eq(pullRequest.base?.repo?.full_name,REPO,'base repository');
  eq(pullRequest.head?.ref,BRANCH,'Developer PR branch');
  eq(pullRequest.head?.repo?.full_name,REPO,'Developer PR repository');
  eq(pullRequest.user?.login,'nession-publisher[bot]','PR Publisher App identity');
  eq(pullRequest.html_url,'https://github.com/'+REPO+'/pull/'+ORIGINAL_PR,
    'original PR URL');
  if(!SHA.test(pullRequest.head?.sha??''))reject('invalid current PR HEAD');
  eq(branchRef.ref,'refs/heads/'+BRANCH,'current bounded branch name');
  eq(branchRef.object?.sha,pullRequest.head.sha,'current branch/PR HEAD');
  if(!Array.isArray(branchPulls)||branchPulls.length!==1||
     branchPulls[0].number!==ORIGINAL_PR||
     branchPulls[0].head?.ref!==BRANCH||
     branchPulls[0].head?.repo?.full_name!==REPO)
    reject('missing, forked or duplicate PR on deterministic Publisher branch');
  if(!Array.isArray(pullCommits)||pullCommits.length<1||
     pullCommits.length>100||pullCommits[0].sha!==ORIGINAL_PR_SHA||
     pullCommits[pullCommits.length-1].sha!==pullRequest.head.sha)
    reject('original Developer PR commit missing or overwritten');
  eq(originalCommit.sha,ORIGINAL_PR_SHA,'original source PR commit');
  if(!Array.isArray(originalCommit.parents)||originalCommit.parents.length!==1)
    reject('unexpected initial PR commit parent shape');
  eq(originalCommit.parents[0].sha,ORIGINAL_PUBLISHER_MAIN_SHA,
    'original PR commit parent');
  if(!Array.isArray(originalFiles)||originalFiles.length!==1||
     originalFiles[0].filename!==SOURCE.file||
     originalFiles[0].status!=='added'||
     originalFiles[0].sha!==ORIGINAL_BLOB_SHA)
    reject('original published commit has untrusted file changes');
  if(!Array.isArray(currentFiles)||currentFiles.length!==1||
     currentFiles[0].filename!==SOURCE.file||
     currentFiles[0].status!=='added')
    reject('current PR escaped the bounded public canary scope');
  return Object.freeze({
    schema_version:1,kind:'publisher_original_publication_readback',
    status:'original_pr_verified_not_reviewed',
    issue:1997,source_worker_run_id:SOURCE.run_id,
    original_publisher_run_id:ORIGINAL_PUBLISHER_RUN,
    original_pr:ORIGINAL_PR,original_pr_sha:ORIGINAL_PR_SHA,
    current_pr_sha:pullRequest.head.sha,
    checkpoint_version:SOURCE.checkpoint_version,
    intent_patch_sha256:record.patch_sha256,
    branch:BRANCH,
    // This does not attest an authorized Reviewer, repair or merged Acceptance.
  });
}
