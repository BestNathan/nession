// #1664/#2137: read-only authentication of the *real* bounded Publisher PR.
// This is not a model Review, GitHub review write, or workflow transition.
// Never treat an Issue comment, model claim, or PR description as authority.
import {createHash} from 'node:crypto';
import {resolveIdentity} from '../harness/contract.mjs';
import {CONTROLLED_1997_POLICY as POLICY} from '../publisher/controlled-proposal.mjs';
import {CONTROLLED_PUBLISHER_BRANCH as BRANCH,
  validateControlledPublisherIntent} from '../publisher/store-intent.mjs';

const REPO='BestNathan/nession';
const PR=2176,HEAD='3d8e3807cc01f6082734b8d0ba458217c28f60a4';
const ISSUER_RUN=39609600546,APP='nession-publisher[bot]';
const SHA=/^[0-9a-f]{40}$/;
const FULL_PATCH='@@ -0,0 +1,2 @@\n+Durable Worker fixture: complete\n+Previous value: pending';
const sha256=value=>createHash('sha256').update(value).digest('hex');
const bytes=Buffer.from(POLICY.content,'utf8');
const blob=createHash('sha1').update(Buffer.concat([
  Buffer.from('blob '+bytes.length+'\0'),bytes,
])).digest('hex');
function reject(reason){throw Error('Verified Reviewer admission: '+reason);}
const same=(observed,expected,label)=>{
  if(observed!==expected)reject('invalid '+label);
};
function object(x){return x&&typeof x==='object'&&!Array.isArray(x);}
export const VERIFIED_INITIAL_REVIEW_TARGET=Object.freeze({
  issue:1997,pr:PR,head_sha:HEAD,branch:BRANCH,source_run_id:POLICY.run_id,
  source_attempt:POLICY.attempt,publisher_run_id:ISSUER_RUN,
  expected_path:POLICY.file,expected_content_sha256:sha256(bytes),
});
// All arguments MUST come from independently fetched GitHub REST and the
// actual committed, immutable agent-store result object. No auth token enters
// this pure function and no side effect is performed.
export function admitOriginal1997Reviewer({
  pull,files,headCommit,publisherRun,publisherIntent,registry,reviews,
}){
  if(!object(pull)||!object(headCommit)||!object(publisherRun)||
     !object(publisherIntent)||!Array.isArray(files)||!Array.isArray(reviews)||
     !object(registry))reject('missing independent sources');
  const intent=validateControlledPublisherIntent(publisherIntent);
  same(intent.publisher_issuer_run_id,ISSUER_RUN,'Publisher intent issuer');
  same(intent.worker_run_id,POLICY.run_id,'original Developer Run');
  same(intent.worker_run_attempt,POLICY.attempt,'original Developer attempt');
  same(intent.checkpoint_commit_sha,POLICY.checkpoint_commit_sha,
    'original encrypted v3 Checkpoint');
  same(intent.checkpoint_ciphertext_sha256,POLICY.checkpoint_ciphertext_sha256,
    'original encrypted v3 digest');
  same(intent.branch,BRANCH,'original Publisher branch');
  same(intent.source_sha,POLICY.source_sha,'original native edit SHA');
  same(intent.source_claim_artifact_id,POLICY.claim_artifact_id,'source Claim Artifact');
  same(intent.source_result_artifact_id,POLICY.result_artifact_id,'source Result Artifact');
  if(!SHA.test(intent.target_main_sha??'')||!/^[a-f0-9]{64}$/.test(intent.patch_sha256??''))
    reject('invalid original Store commit');
  same(pull.number,PR,'review PR');
  same(pull.state,'open','PR state');
  same(pull.draft,false,'PR draft');
  same(pull.merged_at,null,'PR merge');
  same(pull.head?.ref,BRANCH,'PR branch');
  same(pull.head?.sha,HEAD,'PR HEAD');
  same(pull.head?.repo?.full_name,REPO,'PR head repository');
  same(pull.base?.ref,'main','PR base');
  same(pull.base?.repo?.full_name,REPO,'PR base repository');
  same(pull.user?.login,APP,'Publisher App authorship');
  if(!/^https:\/\/github\.com\/BestNathan\/nession\/pull\/2176$/.test(pull.html_url??''))
    reject('untrusted PR link');
  same(publisherRun.id,ISSUER_RUN,'Publisher Run');
  same(publisherRun.run_attempt,1,'Publisher Run attempt');
  same(publisherRun.path,'.github/workflows/store-controlled-publisher.yml',
    'Publisher workflow');
  same(publisherRun.name,'Store / Controlled Publisher','Publisher workflow name');
  same(publisherRun.event,'issue_comment','Publisher event type');
  same(publisherRun.actor?.login,'BestNathan','original Publisher issuer');
  same(publisherRun.repository?.full_name,REPO,'Publisher repository');
  same(publisherRun.head_repository?.full_name,REPO,'Publisher head repository');
  same(publisherRun.head_branch,'main','Publisher originating branch');
  same(publisherRun.head_sha,intent.target_main_sha,'Store Publisher target SHA');
  same(publisherRun.status,'completed','Publisher Run status');
  same(publisherRun.conclusion,'success','Publisher Run conclusion');
  same(headCommit.sha,HEAD,'real PR commit SHA');
  if(!Array.isArray(headCommit.parents)||headCommit.parents.length!==1)
    reject('PR HEAD must be single-parent source commit');
  same(headCommit.parents[0].sha,intent.target_main_sha,'PR Git parent SHA');
  if(files.length!==1||!object(files[0]))reject('PR has an unexpected file count');
  const file=files[0];
  same(file.filename,POLICY.file,'PR changed file path');
  same(file.status,'added','PR file action');
  same(file.additions,2,'PR additions');
  same(file.deletions,0,'PR deletions');
  same(file.changes,2,'PR file changes');
  same(file.sha,blob,'PR exact Git blob bytes');
  same((file.patch??'').trimEnd(),FULL_PATCH,'PR exact text diff');
  if(reviews.length!==0)reject('first native Reviewer must not be replayed over an existing Review');
  const identity=resolveIdentity(registry,'review-cursor-01','review','agent-review-cursor-01');
  same(identity.role,'reviewer','registered role');
  same(identity.provider,'cursor','registered provider');
  if(identity.task!=='review')reject('Reviewer may not perform Developer task');
  return Object.freeze({
    schema_version:1,kind:'authenticated_read_only_reviewer_admission',
    status:'admitted_only',issue:1997,
    pr:PR,review_head_sha:HEAD,review_branch:BRANCH,
    publisher_run_id:ISSUER_RUN,
    publication_target_sha:intent.target_main_sha,
    publication_patch_sha256:intent.patch_sha256,
    developer_run_id:POLICY.run_id,
    checkpoint_version:POLICY.checkpoint_version,
    checkpoint_commit_sha:POLICY.checkpoint_commit_sha,
    file:{path:POLICY.file,content_sha256:sha256(bytes),blob_sha:blob,
      additions:2,deletions:0},
    reviewer:{agent_id:identity.agent_id,provider:identity.provider,
      role:identity.role,task:identity.task,environment:identity.environment},
    // This is a context reference, not an outcome or the grant to write a Review.
    next_action:'separate_native_reviewer_workflow_required',
  });
}
