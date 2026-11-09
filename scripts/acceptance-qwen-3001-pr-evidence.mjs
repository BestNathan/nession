// One-time source-bound PR-stage evidence for the real Qwen Developer fixture #3001.
// This is read-only GitHub/immutable Store observation, NOT an Acceptance verdict.
import assert from 'node:assert/strict';

const REPO='BestNathan/nession';
const ISSUE=3001;
const PR=3017;
const HEAD='2d6f729b94cf4b8a0db73d9c5a60fd1284dd79ed';
const MERGE='fa58962f663e9895be0d48e329672b3779c641ff';
const REVIEW_RUN=42489364854;
const REVIEW_ACTION='d802d16a2c9b0de581ed44f2cb7995e9a333074dd63db0f83ef8615ccad8228e';
const STORE_COMMIT='c4cff6589374d288a35b4ed81fb150a9775eb037';
const RESULT_PATH='workflows/issues/3001/results/'+REVIEW_RUN+'-1-'+REVIEW_ACTION+'.json';
const FILE='e2e/fixtures/agent-development/qwen-source.md';
const SHA=/^[0-9a-f]{40}$/;
const DIGEST=/^sha256:[0-9a-f]{64}$/;

export function attestOriginalQwenReview({repo,issue,stage,targetSha,pr,files,comparison,reviewRun,storeResult,artifacts}){
  assert.equal(repo,REPO,'foreign repository');
  assert.equal(issue,ISSUE,'wrong fixture Issue');
  assert.equal(stage,'pre-merge','wrong proof stage');
  assert.ok(SHA.test(targetSha??''),'invalid target SHA');
  assert.equal(pr?.number,PR,'wrong implementing PR');
  assert.equal(pr?.state,'closed','implementing PR is not closed');
  assert.equal(pr?.merged,true,'implementing PR is not merged');
  assert.equal(pr?.base?.ref,'main','wrong PR base');
  assert.equal(pr?.base?.repo?.full_name,REPO,'foreign PR base repository');
  assert.equal(pr?.head?.repo?.full_name,REPO,'foreign PR head repository');
  assert.equal(pr?.head?.sha,HEAD,'wrong implementing PR HEAD');
  assert.equal(pr?.merge_commit_sha,MERGE,'wrong merge commit');
  assert.ok(pr?.merged_at,'missing merged time');
  assert.equal(pr?.merged_by?.login,'BestNathan','merge not performed by authorized owner');
  assert.ok(['ahead','identical'].includes(comparison?.status) &&
    comparison?.merge_base_commit?.sha===MERGE,
    'original implementing merge is not an ancestor of this target');
  assert.ok(Array.isArray(files)&&files.length===1,
    'implementing PR must change exactly one tracked file');
  const file=files[0];
  assert.equal(file?.filename,FILE,'wrong source file');
  assert.equal(file?.status,'modified','file must not be created/deleted/renamed');
  assert.equal(file?.additions,1,'extra source addition');
  assert.equal(file?.deletions,1,'extra source deletion');
  assert.ok(typeof file?.patch==='string','source patch not available');
  const lines=file.patch.split(/\r?\n/);
  assert.deepEqual(lines.filter(x=>x.startsWith('-')&&!x.startsWith('---')),
    ['-implementation: qwen-verified'],'wrong removed source line');
  assert.deepEqual(lines.filter(x=>x.startsWith('+')&&!x.startsWith('+++')),
    ['+implementation: qwen-v2-proven'],'wrong added source line');
  assert.ok(lines.includes(' review: pending'),'Reviewer-owned marker not preserved');
  assert.equal(reviewRun?.id,REVIEW_RUN,'wrong Reviewer Run ID');
  assert.equal(reviewRun?.run_attempt,1,'wrong Reviewer attempt');
  assert.equal(reviewRun?.name,'Agent / Review','wrong Reviewer workflow');
  assert.equal(reviewRun?.path,'.github/workflows/agent-review.yml',
    'wrong Reviewer workflow path');
  assert.equal(reviewRun?.event,'workflow_dispatch','wrong Reviewer event');
  assert.equal(reviewRun?.head_branch,'main','Reviewer not main-owned');
  assert.equal(reviewRun?.repository?.full_name,REPO,'foreign Reviewer repository');
  assert.equal(reviewRun?.head_repository?.full_name,REPO,'foreign Reviewer head repository');
  assert.equal(reviewRun?.status,'completed','Reviewer incomplete');
  assert.equal(reviewRun?.conclusion,'success','Reviewer workflow unsuccessful');
  assert.equal(storeResult?.schema_version,2,'invalid committed result version');
  assert.equal(storeResult?.kind,'authenticated_agent_task_result','invalid committed result kind');
  assert.equal(storeResult?.issue,ISSUE,'wrong committed Issue');
  assert.equal(storeResult?.action_id,REVIEW_ACTION,'wrong committed Review Action');
  const result=storeResult.result;
  assert.equal(result?.kind,'reviewer','committed result is not Reviewer');
  assert.equal(result?.issue,ISSUE,'wrong Reviewer Issue');
  assert.equal(result?.run_id,REVIEW_RUN,'committed Reviewer Run mismatch');
  assert.equal(result?.run_attempt,1,'committed Reviewer attempt mismatch');
  assert.equal(result?.target_sha,HEAD,'committed Reviewer target mismatch');
  assert.equal(result?.task_id,REVIEW_ACTION,'committed task Action mismatch');
  assert.equal(result?.outcome,'approved','no supported Reviewer approval');
  const source=storeResult.source;
  assert.equal(source?.repository,REPO,'foreign committed source');
  assert.equal(source?.path,reviewRun.path,'committed workflow path mismatch');
  assert.equal(source?.name,reviewRun.name,'committed workflow name mismatch');
  assert.equal(source?.event,reviewRun.event,'committed event mismatch');
  assert.equal(source?.run_id,REVIEW_RUN,'committed source Run mismatch');
  assert.equal(source?.attempt,1,'committed source attempt mismatch');
  assert.equal(source?.ref,'refs/heads/main','committed source ref mismatch');
  assert.equal(source?.issue,ISSUE,'committed source Issue mismatch');
  assert.equal(source?.task_id,REVIEW_ACTION,'committed source Action mismatch');
  assert.equal(source?.agent_id,'review-qwen-01','wrong source reviewer identity');
  assert.equal(source?.input_sha,HEAD,'Reviewer input is not PR HEAD');
  assert.equal(source?.output_sha,HEAD,'Reviewer output is not PR HEAD');
  assert.equal(source?.verified,true,'committed Writer did not authenticate source');
  assert.equal(storeResult?.implementing_pr?.repository,REPO,'foreign attested PR');
  assert.equal(storeResult?.implementing_pr?.number,PR,'wrong attested PR');
  assert.equal(storeResult?.implementing_pr?.head_sha_at_attestation,HEAD,
    'Reviewer attested a different PR HEAD');
  const artifact=storeResult.artifact;
  assert.ok(Number.isSafeInteger(artifact?.id)&&artifact.id>0,'missing original result Artifact');
  assert.ok(DIGEST.test(artifact?.digest??''),'invalid original Artifact digest');
  assert.ok(SHA.test(artifact?.json_sha256?.slice(0,40)) &&
    /^[a-f0-9]{64}$/.test(artifact.json_sha256),'invalid original JSON digest');
  assert.equal(artifact?.source_run_id,REVIEW_RUN,'wrong Artifact source Run');
  assert.equal(artifact?.source_run_attempt,1,'wrong Artifact source attempt');
  assert.ok(Array.isArray(artifacts?.artifacts)&&artifacts.artifacts.length<=100 &&
    artifacts.total_count===artifacts.artifacts.length,'ambiguous Artifact inventory');
  const matched=artifacts.artifacts.filter(x=>x?.name===
    'agent-result-'+REVIEW_RUN+'-1-'+REVIEW_ACTION);
  assert.equal(matched.length,1,'missing or duplicate original Reviewer result Artifact');
  assert.equal(matched[0].id,artifact.id,'Artifact ID does not match immutable Store');
  assert.equal(matched[0].digest,artifact.digest,'Artifact digest does not match immutable Store');
  assert.equal(matched[0].expired,false,'original Reviewer Artifact has expired');
  return Object.freeze({
    kind:'authenticated_original_qwen_3001_implementation_review',
    issue:ISSUE,target_sha:targetSha,pr_number:PR,pr_head_sha:HEAD,
    pr_merge_commit_sha:MERGE,changed_file:FILE,
    authorized_patch:'implementation: qwen-verified -> qwen-v2-proven',
    unrelated_changes:0,review_marker_preserved:true,
    reviewer_run_id:REVIEW_RUN,reviewer_attempt:1,
    reviewer_verdict:'approved',reviewer_action_id:REVIEW_ACTION,
    reviewer_artifact_id:artifact.id,reviewer_artifact_digest:artifact.digest,
    immutable_store_commit:STORE_COMMIT,immutable_store_result_path:RESULT_PATH,
    original_pr_url:'https://github.com/'+REPO+'/pull/'+PR,
    reviewer_run_url:'https://github.com/'+REPO+'/actions/runs/'+REVIEW_RUN,
    proof:'exact original PR diff + original merge ancestry + main Reviewer Run/Attempt + immutable Store Writer result + original GitHub Artifact metadata',
  });
}

export async function collectOriginalQwenReview({repo,issue,stage,targetSha,get}){
  if(repo!==REPO||issue!==ISSUE||stage!=='pre-merge'||!SHA.test(targetSha??'')||
    typeof get!=='function')throw Error('invalid Qwen fixture evidence request');
  const pref='/repos/'+REPO;
  const [pr,files,comparison,reviewRun,contents,artifacts]=await Promise.all([
    get(pref+'/pulls/'+PR),get(pref+'/pulls/'+PR+'/files?per_page=100'),
    get(pref+'/compare/'+MERGE+'...'+targetSha),
    get(pref+'/actions/runs/'+REVIEW_RUN),
    get(pref+'/contents/'+RESULT_PATH+'?ref='+STORE_COMMIT),
    get(pref+'/actions/runs/'+REVIEW_RUN+'/artifacts?per_page=100'),
  ]);
  if(contents?.encoding!=='base64'||!Number.isInteger(contents?.size)||
    contents.size<100||contents.size>8192||typeof contents.content!=='string')
    throw Error('pinned Store Reviewer record is unavailable');
  const bytes=Buffer.from(contents.content.replace(/\s/g,''),'base64');
  if(bytes.length!==contents.size)throw Error('pinned Store record size mismatch');
  const storeResult=JSON.parse(bytes.toString('utf8'));
  return attestOriginalQwenReview({repo,issue,stage,targetSha,pr,files,
    comparison,reviewRun,storeResult,artifacts});
}

export function selfTestOriginalQwenReview(){
  const r={full_name:REPO}, artifact={id:93,
    digest:'sha256:'+'a'.repeat(64),json_sha256:'b'.repeat(64),
    source_run_id:REVIEW_RUN,source_run_attempt:1};
  const good={
    repo:REPO,issue:ISSUE,stage:'pre-merge',targetSha:'e'.repeat(40),
    pr:{number:PR,state:'closed',merged:true,base:{ref:'main',repo:r},
      head:{sha:HEAD,repo:r},merge_commit_sha:MERGE,merged_at:'2026-11-08T14:27:23Z',
      merged_by:{login:'BestNathan'}},
    files:[{filename:FILE,status:'modified',additions:1,deletions:1,
      patch:'@@ -9,3 +9,3 @@\n-implementation: qwen-verified\n+implementation: qwen-v2-proven\n review: pending\n'}],
    comparison:{status:'ahead',merge_base_commit:{sha:MERGE}},
    reviewRun:{id:REVIEW_RUN,run_attempt:1,name:'Agent / Review',
      path:'.github/workflows/agent-review.yml',event:'workflow_dispatch',
      head_branch:'main',repository:r,head_repository:r,status:'completed',
      conclusion:'success'},
    storeResult:{schema_version:2,kind:'authenticated_agent_task_result',
      issue:ISSUE,action_id:REVIEW_ACTION,
      result:{kind:'reviewer',issue:ISSUE,run_id:REVIEW_RUN,run_attempt:1,
        target_sha:HEAD,outcome:'approved',task_id:REVIEW_ACTION},
      source:{repository:REPO,path:'.github/workflows/agent-review.yml',
        name:'Agent / Review',event:'workflow_dispatch',run_id:REVIEW_RUN,
        attempt:1,ref:'refs/heads/main',issue:ISSUE,task_id:REVIEW_ACTION,
        agent_id:'review-qwen-01',input_sha:HEAD,output_sha:HEAD,verified:true},
      implementing_pr:{repository:REPO,number:PR,head_sha_at_attestation:HEAD},
      artifact},
    artifacts:{total_count:1,artifacts:[{id:93,
      name:'agent-result-'+REVIEW_RUN+'-1-'+REVIEW_ACTION,
      digest:artifact.digest,expired:false}]},
  };
  const positive=attestOriginalQwenReview(good);
  assert.equal(positive.reviewer_verdict,'approved');
  assert.equal(positive.unrelated_changes,0);
  const bad=(mutate)=>{
    const value=structuredClone(good);
    mutate(value);
    assert.throws(()=>attestOriginalQwenReview(value));
  };
  bad(x=>{x.issue=1974;});
  bad(x=>{x.stage='post-merge';});
  bad(x=>{x.pr.head.sha='1'.repeat(40);});
  bad(x=>{x.pr.base.repo.full_name='evil/repo';});
  bad(x=>{x.pr.merge_commit_sha='1'.repeat(40);});
  bad(x=>{x.comparison.merge_base_commit.sha='1'.repeat(40);});
  bad(x=>{x.files.push({...x.files[0]});});
  bad(x=>{x.files[0].patch+='+unrelated\n';});
  bad(x=>{x.files[0].patch=x.files[0].patch.replace(' review: pending',' review: approved');});
  bad(x=>{x.reviewRun.run_attempt=2;});
  bad(x=>{x.reviewRun.conclusion='failure';});
  bad(x=>{x.storeResult.result.outcome='pending';});
  bad(x=>{x.storeResult.source.verified=false;});
  bad(x=>{x.storeResult.source.agent_id='foreign';});
  bad(x=>{x.storeResult.implementing_pr.head_sha_at_attestation='1'.repeat(40);});
  bad(x=>{x.artifacts.artifacts[0].digest='sha256:'+'2'.repeat(64);});
  bad(x=>{x.artifacts.artifacts[0].expired=true;});
  bad(x=>{x.artifacts.artifacts[0].id+=1;}); // historical Result ID must agree
  bad(x=>{x.storeResult.artifact.source_run_attempt=2;}); // no guessed replay
  bad(x=>{x.reviewRun.head_repository.full_name='foreign/repository';});
  bad(x=>{x.files[0].additions=2;}); // even the same source file cannot contain extra changes
  bad(x=>{x.comparison.status='behind';}); // source must precede target
  return true;
}
