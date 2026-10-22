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
// The real Publisher ran main at this commit, and the App-authored fixture
// commit 3d8e3807 has exactly this tree and single main parent. Pinning both
// rejects a coordinated fake run SHA + Store intent + parent/tree.
const ORIGINAL_MAIN_SHA='c6894b59b8be9448cae3c68fd87593516f66b47a';
const ORIGINAL_TREE_SHA='34ba295f4b6d0becffd6bc1d3e178a54325c0410';
const FILE_MODE='100644';
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

const ADMISSION_FIELDS=['schema_version','kind','status','repository','issue',
  'role','agent_id','task','pr_number','target_sha','base_sha_at_publication',
  'publisher_run_id','publisher_attempt','publisher_intent_sha256',
  'original_worker_run_id','native_checkpoint_commit_sha','expected_file',
  'expected_file_sha256','expected_file_mode'];
const CANONICAL_ADMISSION_IDENTITY=Object.freeze({
  kind:'authenticated_reviewer_admission_only',
  status:'await_native_reviewer',
  agent_id:'review-cursor-01',
});
// Consumers (Reviewer prompt/task/worker) must reject any task that did not
// come from this exact builder; accepting a hand-built lookalike would let a
// model or caller choose the reviewed target. The identity fields are
// parameterized only for an explicitly-labeled smoke admission; the target,
// file and Publisher facts are always the same authenticated #2176 facts.
export function assertReviewerAdmission(task,identity=CANONICAL_ADMISSION_IDENTITY){
  const expected={...CANONICAL_ADMISSION_IDENTITY,...identity};
  if(!only(task,ADMISSION_FIELDS)||task.schema_version!==1||
     task.kind!==expected.kind||task.status!==expected.status||
     task.repository!==REPO||task.issue!==1997||
     task.role!=='reviewer'||task.agent_id!==expected.agent_id||
     task.task!=='review'||
     task.pr_number!==PR_NUMBER||task.target_sha!==PR_SHA||
     task.base_sha_at_publication!==ORIGINAL_MAIN_SHA||
     !HEX40.test(task.target_sha??'')||
     !HEX40.test(task.native_checkpoint_commit_sha??'')||
     !HEX64.test(task.publisher_intent_sha256??'')||
     !HEX64.test(task.expected_file_sha256??'')||
     !Number.isSafeInteger(task.publisher_run_id)||task.publisher_run_id<=0||
     !Number.isSafeInteger(task.publisher_attempt)||task.publisher_attempt<=0||
     !Number.isSafeInteger(task.original_worker_run_id)||task.original_worker_run_id<=0||
     task.expected_file!==FILE||task.expected_file_mode!==FILE_MODE)
    fail('not an authenticated reviewer admission');
  return task;
}
export function assertAuthenticatedReviewerAdmission(task){
  return assertReviewerAdmission(task);
}

export function admitOriginalControlledReviewerTarget(params){
  if(!only(params,['publisherRun','ownerComment','pullRequest',
    'headCommit','files','treeEntry','storeIntent']))
    fail('unexpected source fields (model/Issue content cannot select a role)');
  const {publisherRun:run,ownerComment:comment,pullRequest:pr,
    headCommit:head,files,treeEntry,storeIntent:rawIntent}=params;
  if(!run||run.id!==PUBLISH_RUN||run.run_attempt!==1||
     run.repository?.full_name!==REPO||
     run.head_repository?.full_name!==REPO||
     run.name!=='Store / Controlled Publisher'||run.path!==REPO_PATH||
     run.event!=='issue_comment'||run.actor?.login!=='BestNathan'||
     run.head_branch!=='main'||run.head_sha!==ORIGINAL_MAIN_SHA||
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
  // Normalize the lower-level Store parser error into the Reviewer admission
  // boundary; a forged immutable intent is still rejected, not silently used.
  let intent;
  try { intent=validateControlledPublisherIntent(rawIntent); }
  catch { fail('untrusted immutable Publisher Store intent'); }
  must(intent.publisher_issuer_run_id,run.id,'Publisher Run in CAS');
  must(intent.target_main_sha,ORIGINAL_MAIN_SHA,'original main SHA in CAS');
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
     head.tree?.sha!==ORIGINAL_TREE_SHA||
     !Array.isArray(head.parents)||head.parents.length!==1||
     head.parents[0].sha!==ORIGINAL_MAIN_SHA)
    fail('PR original HEAD, tree or Git parent differs from committed CAS');
  if(!Array.isArray(files)||files.length!==1)
    fail('PR changed more than one authorized file');
  const entry=files[0];
  if(entry.filename!==FILE||entry.status!=='added'||
     entry.sha!==blobSha(original)||
     entry.patch!==ORIGINAL_PATCH||
     entry.additions!==2||entry.deletions!==0||
     (entry.changes!=null&&entry.changes!==2))
    fail('unauthorized PR file bytes, diff or scope');
  // The pull-request files API carries no mode, so the independently fetched
  // Git tree entry owns the regular-file mode/type. A 100755 or symlink blob
  // with the trusted bytes must not be admitted as the authorized 100644 file.
  if(!treeEntry||treeEntry.path!==FILE||treeEntry.mode!==FILE_MODE||
     treeEntry.type!=='blob'||
     treeEntry.sha!==blobSha(original)||
     treeEntry.size!==Buffer.byteLength(original))
    fail('unauthorized PR file mode, type or tree entry');
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
    expected_file_mode:FILE_MODE,
  };
  // Never claim a Reviewer action: only a future independently authenticated
  // Reviewer Workflow may return a schema-validated changes_requested/approved.
  return Object.freeze(assertReviewerAdmission(task));
}
