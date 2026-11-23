#!/usr/bin/env node
// #4012 SC-02: a strictly read-only historical, source-bound original Qwen
// Reviewer result, not proof of SC-04 or of final #3919's rewritten HEAD.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const REPO='BestNathan/nession';
const ISSUE=4012,SOURCE_ISSUE=3784,PR=3919,RUN_ID=44466992692;
const RUN_SHA='c3fee88b5ed6ded03541f00039e6bcdd87be2d0b';
const REVIEW_SHA='51f82d64ec159397ea501e6cbb99e7039ee141bd';
const PREVIOUS_SHA='5d7e9118b7e954e760cc680fff7d43b4f9e17612';
const ACTION='beea663c7f989c7b0837de8ea53c8cd18c07cfe1856c2b00c20d34b4cc49746b';
const SOURCE_PATH='crates/nession-agent/src/sandbox_images.rs';
const RESULT_PATH='workflows/issues/3784/results/44466992692-1-'+ACTION+'.json';
const STATE26='workflows/issues/3784/states/00000026.json';
const STATE35='workflows/issues/3784/states/00000035.json';
const DIGESTS=Object.freeze({
  result:'sha256:b38b2a68bff2b9f39adb937e8903ae138b2f5dd2b382b22a2475533d7bcd9d15',
  reviewer_slice:'sha256:45adbe5ae1991e60c338a547cc67865ad63b74886e86a835ccc8adbc7bebc730',
});
const expectedBlob=Object.freeze({
  [STATE26]:'7f61f5a326f175203d734c796aec816010af9895',
  [STATE35]:'c22e5e75168df996ec5354aaccc9663f656e6f1e',
  [RESULT_PATH]:'28c51f83deeebfd9453045a547b2ad2af626e54e',
  [SOURCE_PATH]:'3ff378a6f4d499c3595b39bf1ea866fcf1ec4ff4',
});
const hex40=/^[0-9a-f]{40}$/;
function need(ok,why){if(!ok)throw Error('#4012 source-bound Reviewer: '+why);}
function decodeContents(json,path){
  need(json?.type==='file'&&json.path===path&&
    json.encoding==='base64'&&json.sha===expectedBlob[path]&&
    typeof json.content==='string'&&
    Number.isSafeInteger(json.size)&&json.size>0&&json.size<300000,
    'untrusted immutable Git blob '+path);
  const base64=json.content.replace(/\s/g,'');
  const data=Buffer.from(base64,'base64');
  const object=createHash('sha1').update(Buffer.from('blob '+data.length+'\0')).update(data).digest('hex');
  need(data.length===json.size&&
    data.toString('base64')===base64&&object===json.sha,
    'Git blob bytes mismatch '+path);
  return {text:data.toString('utf8'),value:path.endsWith('.json')?
    JSON.parse(data.toString('utf8')):null};
}
export function attestOriginalCompositeReviewer4012({run,artifacts,result,
  state26,state35,source,commit,comment,targetSha}){
  need(hex40.test(targetSha||''),'target SHA invalid');
  need(run?.id===RUN_ID&&run.name==='Agent / Review'&&
    run.path==='.github/workflows/agent-review.yml'&&
    run.head_sha===RUN_SHA&&run.head_branch==='main'&&
    run.run_attempt===1&&run.event==='workflow_dispatch'&&
    run.actor?.login==='github-actions[bot]'&&
    run.repository?.full_name===REPO&&
    run.status==='completed'&&run.conclusion==='success',
    'wrong signed Reviewer Run/Attempt/Actor/SHA/conclusion');
  const matches=(name)=>artifacts?.artifacts?.filter(a=>a.name===name)||[];
  for(const [name,digest] of [
    ['agent-result-44466992692-1-'+ACTION,DIGESTS.result],
    ['reviewer-slice-44466992692-1',DIGESTS.reviewer_slice],
  ]){
    const xs=matches(name),a=xs[0];
    need(xs.length===1&&a.digest===digest&&a.expired===false&&
      Number.isSafeInteger(a.id)&&a.id>0&&a.size_in_bytes>0&&
      a.workflow_run?.id===RUN_ID&&a.workflow_run?.head_sha===RUN_SHA,
      'missing/expired/mismatched original signed Reviewer Artifact '+name);
  }
  need(result?.schema_version===2&&
    result.kind==='authenticated_agent_task_result'&&
    result.issue===SOURCE_ISSUE&&result.action_id===ACTION&&
    result.result?.kind==='reviewer'&&result.result.issue===SOURCE_ISSUE&&
    result.result.run_id===RUN_ID&&result.result.run_attempt===1&&
    result.result.target_sha===REVIEW_SHA&&
    result.result.outcome==='changes_requested'&&result.result.task_id===ACTION&&
    result.source?.repository===REPO&&
    result.source.path==='.github/workflows/agent-review.yml'&&
    result.source.name==='Agent / Review'&&
    result.source.run_id===RUN_ID&&result.source.attempt===1&&
    result.source.ref==='refs/heads/main'&&
    result.source.issue===SOURCE_ISSUE&&
    result.source.agent_id==='review-qwen-01'&&
    result.source.task_id===ACTION&&
    result.source.input_sha===REVIEW_SHA&&
    result.source.output_sha===REVIEW_SHA&&result.source.verified===true&&
    result.artifact?.digest===DIGESTS.result&&
    result.artifact.id===matches('agent-result-44466992692-1-'+ACTION)[0].id&&
    result.implementing_pr?.number===PR&&
    result.implementing_pr.repository===REPO&&
    result.implementing_pr.head_sha_at_attestation===REVIEW_SHA&&
    result.acceptance_result===null,
    'independent Result Ingest missing or wrong original Issue/Action/PR SHA');
  for(const [version,state] of [[26,state26],[35,state35]]){
    need(state?.schema_version===1&&state.issue===SOURCE_ISSUE&&
      state.version===version&&state.assignments?.reviewer==='review-qwen-01'&&
      state.transitions?.some(t=>t.kind==='reviewer'&&
        t.run_id===RUN_ID&&t.attempt===1&&
        t.target_sha===REVIEW_SHA&&t.outcome==='changes_requested'),
      'authenticated Store-CAS Reviewer transition missing in v'+version);
  }
  need(state26.phase==='repair'&&state26.target_sha===REVIEW_SHA,
    'v26 was not the exact-HEAD Repair state');
  need(commit?.sha===REVIEW_SHA&&
    commit.parents?.length===1&&
    commit.parents[0].sha===PREVIOUS_SHA&&
    commit.files?.length===1&&
    commit.files[0].filename===SOURCE_PATH&&
    commit.author?.login==='nession-publisher[bot]',
    'original Publisher source commit changed or lost lineage');
  need(source?.includes('fn reject_referenced_composite(')&&
    source.includes('fn prepare(')&&
    source.includes('Sandbox image composition preparation'),
    'original sandbox source blob missing expected Composite admission');
  // The bot's text is a corroborating, explicitly untrusted observation;
  // immutable signed Store Result+Run+Artifact is the verdict authority.
  const marker='<!-- nession-review-result:v1:3784:'+ACTION+':'+RUN_ID+':1 -->';
  need(comment?.id===7000945790&&
    comment.user?.login==='github-actions[bot]'&&
    comment.body?.startsWith(marker)&&
    comment.body.includes('Verdict: `changes_requested`')&&
    comment.body.includes('Reviewed PR: #3919 at `'+REVIEW_SHA+'`')&&
    comment.body.includes('No test exists that constructs a ResolvedGrantImage')&&
    comment.body.includes('workspace cleanup')&&
    comment.body.includes('wrong/missing Composite dependency grants'),
    'original Reviewer observations not correlated with independent result');
  return Object.freeze({
    schema_version:1,kind:'verified_qwen_4012_historical_composite_reviewer',
    verified:true,subject_issue:ISSUE,historical_source_issue:SOURCE_ISSUE,
    historical_reviewed_pr:PR,historical_reviewed_sha:REVIEW_SHA,
    signed_reviewer_run:RUN_ID,run_attempt:1,workflow_sha:RUN_SHA,
    signed_action:ACTION,source_file:SOURCE_PATH,
    original_reviewer_outcome:'changes_requested',
    observed_missing_regressions:[
      'Composite rejection across Base/Workspace/Toolchain roles',
      'workspace allocation / cleanup on rejected Composite',
      'wrong/missing Composite dependency grants fail-closed',
    ],
    immutable_store_versions:[26,35],
    original_reviewer_result_artifact_sha256:DIGESTS.result,
    original_review_slice_artifact_sha256:DIGESTS.reviewer_slice,
    current_acceptance_target_sha:targetSha,
    scope:'SC-02 only: exact original PR HEAD independent Review and signed Store Result Ingest',
    non_proof:'NOT SC-04 final Qwen Developer->Review->Repair->Quality->Acceptance, NOT original #3919 final rewritten/merged SHA, NOT a new Reviewer approval; bot observation text is contextual and untrusted',
  });
}
export async function collectOriginalCompositeReviewer4012({
  repo=REPO,issue,stage,targetSha,get,
}={}){
  if(issue!==ISSUE||stage!=='post-merge')return null;
  need(repo===REPO&&hex40.test(targetSha||'')&&typeof get==='function',
    'invalid exact Issue/repository/target stage');
  const root='/repos/'+REPO;
  const store=(p)=>root+'/contents/'+p+'?ref=agent-store';
  const fetchJSON=async p=>decodeContents(await get(store(p)),p).value;
  const [run,artifacts,result,state26,state35,source,commit,comment]=
    await Promise.all([
      get(root+'/actions/runs/'+RUN_ID),
      get(root+'/actions/runs/'+RUN_ID+'/artifacts?per_page=100'),
      fetchJSON(RESULT_PATH),fetchJSON(STATE26),fetchJSON(STATE35),
      get(root+'/contents/'+SOURCE_PATH+'?ref='+REVIEW_SHA)
        .then(x=>decodeContents(x,SOURCE_PATH).text),
      get(root+'/commits/'+REVIEW_SHA),
      get(root+'/issues/comments/7000945790'),
    ]);
  return attestOriginalCompositeReviewer4012({
    run,artifacts,result,state26,state35,source,commit,comment,targetSha,
  });
}
export function selfTestOriginalCompositeReviewer4012(){
  assert.equal(REPO,'BestNathan/nession');
  assert.notEqual(PREVIOUS_SHA,REVIEW_SHA);
  assert.equal(Object.keys(expectedBlob).length,4);
  assert.equal(RUN_ID,44466992692);
  assert.equal(ACTION.length,64);
  assert.equal(DIGESTS.result.length,71);
  const record={kind:'reviewer',issue:SOURCE_ISSUE,run_id:RUN_ID,
    run_attempt:1,target_sha:REVIEW_SHA,outcome:'changes_requested',
    task_id:ACTION};
  assert.equal(record.outcome,'changes_requested');
  for(const key of ['issue','run_id','run_attempt','target_sha','outcome','task_id']){
    assert.notEqual({...record,[key]:null}[key],record[key]);
  }
  assert.throws(()=>decodeContents({path:STATE26,type:'file',
    sha:'a'.repeat(40),encoding:'base64',size:1,content:'eA=='},STATE26),
    /untrusted immutable Git blob/);
  console.log('#4012: original Reviewer source-binding and hostile source-identity fixtures passed');
}
if(process.argv[2]==='self-test')selfTestOriginalCompositeReviewer4012();
