// #2177: strict, read-only admission of the independently authenticated
// controlled Publisher's actual GitHub PR before native Cursor Reviewer.
 // No PR review, provider call, Store write, Issue comment, or model-chosen
// next role is authorized by this module.
import {createHash} from 'node:crypto';
import {CONTROLLED_1997_POLICY as POLICY} from '../publisher/controlled-proposal.mjs';
import {CONTROLLED_PUBLISHER_BRANCH,
  validateControlledPublisherIntent} from '../publisher/store-intent.mjs';

const REPO='BestNathan/nession';
const PUBLISH_RUN=39609600546;
const OWNER_COMMENT=6317468284;
const PR_NUMBER=2176;
const PR_SHA='3d8e3807cc01f6082734b8d0ba458217c28f60a4';
const REPO_PATH='.github/workflows/store-controlled-publisher.yml';
const FILE='e2e/fixtures/agent-development/1997-canary.txt';
const HEX40=/^[a-f0-9]{40}$/;
const HEX64=/^[a-f0-9]{64}$/;
const only=(x,fields)=>x&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).length===fields.length&&Object.keys(x).every(k=>fields.includes(k));
const sha=b=>createHash('sha256').update(b).digest('hex');
const blobSha=b=>createHash('sha1').update(Buffer.concat([
  Buffer.from('blob '+b.length+'\0'),b,
])).digest('hex');
function fail(reason){throw Error('Trusted Reviewer source: '+reason);}
function must(v,expected,label){if(v!==expected)fail('untrusted '+label);}
const original=Buffer.from(POLICY.content,'utf8');
const ORIGINAL_PATCH='@@ -0,0 +1,2 @@\n+Durable Worker fixture: complete\n+Previous value: pending';
export const CONTROLLED_REVIEWER_PR=PR_NUMBER;
export const CONTROLLED_REVIEWER_SHA=PR_SHA;
export const CONTROLLED_REVIEWER_PUBLISH_RUN=PUBLISH_RUN;

export function admitOriginalControlledReviewerTarget(params){
  if(!only(params,['publisherRun','ownerComment','pullRequest',
    'headCommit','files','storeIntent']))
    fail('unexpected source fields (model/Issue content cannot select a role)');
  const {publisherRun:run,ownerComment:comment,pullRequest:pr,
    headCommit:head,files,storeIntent:rawIntent}=params;
  if(!run||run.id!==PUBLISH_RUN||run.run_attempt!==1||
     run.repository?.full_name!==REPO||
     run.head_repository?.full_name!==REPO||
     run.name!=='Store / Controlled Publisher'||run.path!==REPO_PATH||
     run.event!=='issue_comment'||run.actor?.login!=='BestNathan'||
     run.head_branch!=='main'||!HEX40.test(run.head_sha??'')||
     run.status!=='completed'||run.conclusion!=='success')
    fail('unauthenticated trusted Publisher Run/Attempt');
  if(!comment||comment.id!==OWNER_COMMENT||
     comment.issue_url!=='https://api.github.com/repos/'+REPO+'/issues/1997'||
     comment.user?.login!=='BestNathan'||
     comment.body!=='/nession publish issue=1997 worker_run=39448549052 checkpoint=3'||
     !Number.isFinite(Date.parse(comment.created_at??''))||
     !Number.isFinite(Date.parse(run.created_at??''))||
     Date.parse(run.created_at)<Date.parse(comment.created_at))
    fail('wrong Owner comment or Publisher event lineage');
  const intent=validateControlledPublisherIntent(rawIntent);
  must(intent.publisher_issuer_run_id,run.id,'Publisher Run in CAS');
  must(intent.target_main_sha,run.head_sha,'CAS main SHA');
  must(intent.action_id,POLICY.action_id,'signed Worker Action');
  must(intent.worker_run_id,POLICY.run_id,'original Worker');
  must(intent.worker_run_attempt,POLICY.attempt,'original Worker attempt');
  must(intent.checkpoint_commit_sha,POLICY.checkpoint_commit_sha,'v3 native checkpoint');
  if(!HEX64.test(intent.patch_sha256??'')||
     intent.patch_sha256!=='1f45a088966d41c1fcade13540498693d7d083ca238ca2b06c0525c654e314ee'||
     intent.publication!=='not_yet_attested'||
     intent.branch!==CONTROLLED_PUBLISHER_BRANCH)
    fail('malformed durable pre-publication intent');
  if(!pr||pr.number!==PR_NUMBER||pr.state!=='open'||pr.draft!==false||
     pr.merged_at!==null||
     pr.user?.login!=='nession-publisher[bot]'||
     pr.head?.sha!==PR_SHA||
     pr.head?.ref!==CONTROLLED_PUBLISHER_BRANCH||
     pr.head?.repo?.full_name!==REPO||
     pr.base?.ref!=='main'||pr.base?.repo?.full_name!==REPO||
     !Number.isFinite(Date.parse(pr.created_at??''))||
     Date.parse(pr.created_at)<Date.parse(run.created_at))
    fail('PR is not the unique open App-authored bounded source');
  if(!head||head.sha!==PR_SHA||
     !HEX40.test(head.tree?.sha??'')||
     !Array.isArray(head.parents)||head.parents.length!==1||
     head.parents[0].sha!==intent.target_main_sha)
    fail('PR original HEAD or Git parent differs from committed CAS');
  if(!Array.isArray(files)||files.length!==1)
    fail('PR changed more than one authorized file');
  const entry=files[0];
  if(entry.filename!==FILE||entry.status!=='added'||
     entry.sha!==blobSha(original)||
     entry.patch!==ORIGINAL_PATCH||
     entry.additions!==2||entry.deletions!==0||
     (entry.changes!=null&&entry.changes!==2))
    fail('unauthorized PR file bytes, diff or scope');
  const task={
    schema_version:1,kind:'authenticated_reviewer_admission_only',
    status:'await_native_reviewer',
    repository:REPO,issue:1997,
    role:'reviewer',agent_id:'review-cursor-01',task:'review',
    pr_number:PR_NUMBER,
    target_sha:PR_SHA,
    base_sha_at_publication:intent.target_main_sha,
    publisher_run_id:run.id,publisher_attempt:run.run_attempt,
    publisher_intent_sha256:sha(Buffer.from(JSON.stringify(intent))),
    original_worker_run_id:POLICY.run_id,
    native_checkpoint_commit_sha:POLICY.checkpoint_commit_sha,
    expected_file:FILE,expected_file_sha256:sha(original),
  };
  // Never claim a Reviewer action: only a future independently authenticated
  // Reviewer Workflow may return a schema-validated changes_requested/approved.
  return Object.freeze(task);
}
