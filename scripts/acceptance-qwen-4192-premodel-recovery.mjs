#!/usr/bin/env node
// #4192: read-only exact Run/Job/Artifact/Store-CAS attestation for the
// already completed Qwen Reviewer *pre-model* admission failure on the
// unchanged PR #4191 source SHA, its single owner-authenticated signed
// successor, and the independently ingested changes_requested Result.
// This is historical evidence for the independent SC Agent, never a Pass
// projector, a replay command, or authority to alter the original Issue.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const REPO='BestNathan/nession',ISSUE=4192,ROOT=4065,PR=4191;
const SHA=/^[0-9a-f]{40}$/,SHA256=/^sha256:[0-9a-f]{64}$/;
// Original published PR base (Publisher workflow SHA) and the exact reviewed
// PR #4191 HEAD. The PR later advanced/merged; the reviewed source SHA is
// immutable and must remain the bound target of every recovery receipt.
const BASE_SHA='a1e9ae535f5581cfbfeaee6b0ce35a07aab40b3e';
const PUB_SHA='f79547b0def78418e109aba82673d7f20edbc341';
// #4205 workflow-only activation merge: Controller, successor Review and
// Result Ingest all executed on this exact trusted main SHA.
const ACTIVATION_SHA='d81b5b0af5b18b3ded368f04b12da9ad8c657f9f';
const PR_HEAD_REF='agent/4065/qwen-74024299b457f8c0';
const SOURCE_PATH='crates/nession-server/src/server/websocket.rs';
const DEV_FAIL_ACTION='f085d5919b3277e4fb68d49f48f9a311a83ad5032a90ec651aba93392888eb44';
const INITIAL_REVIEW_ACTION='73e869fffc416a387c9058da0fcfa8804d339341e1f1daf89a9111fc57f63127';
const SUCCESSOR_ACTION='b95eb42b102c484a9c4613e38a896e456d08c806b09e678f714a1a0f4d2b69ee';
const REPAIR_ACTION='dc7099c5355e73e51b579cecb5d822cdc6be2ef6a4c51148b9514214144e04ee';
const FAILURE_CODE='qwen_reviewer_large_base_premodel_failure';
const OWNER='BestNathan',OWNER_COMMENT_ID=7044714190;
const OWNER_COMMAND='/nession recover-review-preflight issue=4065 run=44744956936';
const OWNER_COMMENT_AT='2026-11-20T16:24:37Z';
const CONTROLLER_CREATED_AT='2026-11-20T16:24:42Z';
const RESULT_PATH='workflows/issues/4065/results/44773349621-1-'+SUCCESSOR_ACTION+'.json';
const RESULT_ARTIFACT='agent-result-44773349621-1-'+SUCCESSOR_ACTION;
const RESULT_ARTIFACT_ID=14650180358;
const RESULT_DIGEST='sha256:bcb5994925b80661f4af3aaeed7558d109289c5428d6d7c8e5da2415e1de11c6';
const statePath=n=>'workflows/issues/4065/states/'+String(n).padStart(8,'0')+'.json';
const WORKFLOWS=Object.freeze({
  original:[44744956936,'Agent / Review','agent-review.yml',BASE_SHA,'failure','workflow_dispatch','github-actions[bot]'],
  controller:[44773114347,'Agent / Controller Dispatch','agent-controller-dispatch.yml',ACTIVATION_SHA,'success','issue_comment',OWNER],
  reviewer:[44773349621,'Agent / Review','agent-review.yml',ACTIVATION_SHA,'success','workflow_dispatch','github-actions[bot]'],
  ingest:[44774913166,'Store / Agent Review Result Ingest','store-agent-review-result-ingest.yml',ACTIVATION_SHA,'success','repository_dispatch','github-actions[bot]'],
});
const ORIGINAL_JOBS=Object.freeze([
  [136317768286,'prepare','failure'],
  [136318020115,'review','skipped'],
  [136318020333,'notify-metrics','skipped'],
]);
const FAILING_STEP='Prepare the reviewer admission';
const CONTROLLER_JOB=Object.freeze([136415669961,'trusted-dispatch','success']);
// Immutable historical Git blobs on the append-only agent-store orphan.
const EXPECTED_BLOB=Object.freeze({
  [statePath(9)]:'61f7c10844930e08efe51e53f54819dbafd95df3',
  [statePath(12)]:'928bd5cfa35df4f18e7287b64ecb889f4107ca52',
  [statePath(13)]:'e25c11e3e9a2b7683d3b5c6641f339550525cda8',
  [RESULT_PATH]:'38058aac7201f27e8e734b4670d7a8f766791c5b',
});
const HASH=s=>createHash('sha256').update(s).digest('hex');
function deny(message){throw Error('authenticated #4192 Reviewer pre-model recovery: '+message);}
function requireIt(value,message){if(!value)deny(message);}
function action(state,id){return state?.outbox?.find(x=>x.id===id);}
function reviewerActions(state){return (state?.outbox??[]).filter(x=>x?.task?.role==='reviewer');}
function reviewerTransition(state){
  return (state?.transitions??[]).filter(t=>t?.kind==='reviewer'&&
    t.run_id===WORKFLOWS.reviewer[0]);
}
function validRun(run,key){
  const [id,name,file,sha,conclusion,event,actor]=WORKFLOWS[key];
  requireIt(run?.id===id&&run.name===name&&
    run.path==='.github/workflows/'+file&&run.head_sha===sha&&
    run.run_attempt===1&&run.event===event&&
    run.head_branch==='main'&&run.actor?.login===actor&&
    run.repository?.full_name===REPO&&run.head_repository?.full_name===REPO&&
    run.status==='completed'&&run.conclusion===conclusion,
    'invalid signed '+key+' Run/Attempt/Actor/Event/SHA');
}
function attestOriginalJobs(payload){
  requireIt(payload?.total_count===ORIGINAL_JOBS.length&&
    Array.isArray(payload.jobs)&&payload.jobs.length===ORIGINAL_JOBS.length,
    'original Reviewer Run must have exactly the three pre-model jobs');
  for(const [id,name,conclusion] of ORIGINAL_JOBS){
    const matches=payload.jobs.filter(j=>j?.id===id&&j?.name===name);
    requireIt(matches.length===1&&matches[0].status==='completed'&&
      matches[0].conclusion===conclusion,
      'original Reviewer job '+name+' identity/conclusion changed');
  }
  const prepare=payload.jobs.find(j=>j.id===ORIGINAL_JOBS[0][0]);
  const steps=Array.isArray(prepare?.steps)?prepare.steps:[];
  const failing=steps.filter(s=>s?.name===FAILING_STEP);
  requireIt(failing.length===1&&failing[0].status==='completed'&&
    failing[0].conclusion==='failure',
    'original failure is not the exact reviewer admission prepare step');
  const upload=steps.filter(s=>s?.name==='Upload the verified admission');
  requireIt(upload.length===1&&upload[0].conclusion==='skipped',
    'failed prepare must not have uploaded an admission');
}
function attestControllerJobs(payload){
  const [id,name,conclusion]=CONTROLLER_JOB;
  requireIt(payload?.total_count===1&&Array.isArray(payload.jobs)&&
    payload.jobs.length===1&&payload.jobs[0]?.id===id&&
    payload.jobs[0].name===name&&payload.jobs[0].status==='completed'&&
    payload.jobs[0].conclusion===conclusion,
    'owner Controller dispatch job identity/conclusion changed');
}
function attestOriginalArtifacts(payload){
  requireIt(payload?.total_count===0&&Array.isArray(payload.artifacts)&&
    payload.artifacts.length===0,
    'pre-model failure must have zero Artifacts (no verdict/telemetry)');
}
function attestReviewerArtifacts(payload){
  const runId=WORKFLOWS.reviewer[0],sha=WORKFLOWS.reviewer[3];
  requireIt(Array.isArray(payload?.artifacts)&&payload.artifacts.length>0&&
    payload.artifacts.length<25,'missing/broad successor Reviewer Artifact inventory');
  for(const a of payload.artifacts){
    requireIt(a?.workflow_run?.id===runId&&a.workflow_run?.head_sha===sha,
      'successor Artifact inventory contains a foreign Run/SHA');
  }
  const matching=payload.artifacts.filter(a=>a?.name===RESULT_ARTIFACT);
  const a=matching[0];
  requireIt(matching.length===1&&a.expired===false&&
    a.id===RESULT_ARTIFACT_ID&&Number.isSafeInteger(a.id)&&a.id>0&&
    a.size_in_bytes>0&&a.digest===RESULT_DIGEST&&SHA256.test(a.digest),
    'missing/expired/forged signed Reviewer Result Artifact');
  return Object.freeze({id:a.id,name:RESULT_ARTIFACT,digest:a.digest});
}
function attestStoreCas(states,latest,head){
  for(const n of [9,12,13]){
    const s=states?.[n];
    requireIt(s?.issue===ROOT&&s.version===n&&s.schema_version===1&&
      Array.isArray(s.outbox)&&Array.isArray(s.transitions)&&
      s.assignments?.developer==='dev-qwen-01'&&
      s.assignments?.reviewer==='review-qwen-01',
      'missing/authenticity failure in Store v'+n);
  }
  const v9=states[9],v12=states[12],v13=states[13];
  const devFailure=s=>{
    const dev=action(s,DEV_FAIL_ACTION);
    requireIt(dev?.status==='failed'&&dev.task?.role==='developer'&&
      dev.receipt?.failure_code==='qwen_tracked_source_gate_rejected',
      'predecessor Developer failure was not preserved');
  };
  devFailure(v9);devFailure(v12);devFailure(v13);
  requireIt(v9.phase==='review'&&v9.target_sha===PUB_SHA&&
    reviewerActions(v9).length===1&&
    action(v9,INITIAL_REVIEW_ACTION)?.status==='dispatched'&&
    action(v9,INITIAL_REVIEW_ACTION).task?.task==='review'&&
    action(v9,INITIAL_REVIEW_ACTION).task?.agent_id==='review-qwen-01'&&
    action(v9,INITIAL_REVIEW_ACTION).task?.sha===PUB_SHA&&
    action(v9,INITIAL_REVIEW_ACTION).receipt?.status==='verified'&&
    action(v9,INITIAL_REVIEW_ACTION).receipt?.source_run_id===WORKFLOWS.original[0],
    'Store v9 does not bind the original dispatched Reviewer to the exact PR HEAD');
  const retired=action(v12,INITIAL_REVIEW_ACTION);
  const successor=action(v12,SUCCESSOR_ACTION);
  requireIt(v12.phase==='review'&&v12.target_sha===PUB_SHA&&
    reviewerActions(v12).length===2&&
    retired?.status==='failed'&&retired.task?.sha===PUB_SHA&&
    retired.receipt?.status==='failed'&&
    retired.receipt?.source_run_id===WORKFLOWS.original[0]&&
    retired.receipt?.source_attempt===1&&
    retired.receipt?.failure_code===FAILURE_CODE&&
    successor?.id!==retired.id&&successor?.status==='dispatched'&&
    successor.task?.role==='reviewer'&&successor.task?.task==='review'&&
    successor.task?.agent_id==='review-qwen-01'&&successor.task?.sha===PUB_SHA&&
    successor.receipt?.status==='verified'&&
    successor.receipt?.dispatch_id===SUCCESSOR_ACTION&&
    successor.receipt?.source_run_id===WORKFLOWS.reviewer[0],
    'original Reviewer was not CAS-retired pre-model with exactly one distinct signed successor');
  const review=reviewerTransition(v13);
  const repair=action(v13,REPAIR_ACTION);
  requireIt(v13.phase==='repair'&&v13.target_sha===PUB_SHA&&
    review.length===1&&review[0].attempt===1&&
    review[0].target_sha===PUB_SHA&&review[0].outcome==='changes_requested'&&
    action(v13,INITIAL_REVIEW_ACTION)?.receipt?.failure_code===FAILURE_CODE&&
    repair?.status==='pending'&&repair.task?.role==='developer'&&
    repair.task?.task==='repair'&&repair.task?.sha===PUB_SHA,
    'independent Reviewer Result was not CAS-ingested as changes_requested at the exact SHA');
  requireIt(Number.isSafeInteger(head?.version)&&head.version>=13&&
    head.path===statePath(head.version)&&
    /^[0-9a-f]{64}$/.test(head.sha256??'')&&
    latest?.digest===head.sha256&&latest?.value?.version===head.version,
    'canonical latest Store state does not match head digest');
  const persisted=reviewerTransition(latest.value);
  requireIt(persisted.length===1&&persisted[0].attempt===1&&
    persisted[0].target_sha===PUB_SHA&&
    persisted[0].outcome==='changes_requested'&&
    action(latest.value,INITIAL_REVIEW_ACTION)?.status==='failed'&&
    action(latest.value,INITIAL_REVIEW_ACTION)?.receipt?.failure_code===FAILURE_CODE,
    'append-only Store history dropped the original pre-model failure or its Result');
}
function attestResult(result){
  requireIt(result?.schema_version===2&&
    result.kind==='authenticated_agent_task_result'&&
    result.issue===ROOT&&result.action_id===SUCCESSOR_ACTION&&
    result.acceptance_result===null,
    'persisted Reviewer Result identity changed or carries an acceptance verdict');
  requireIt(result.result?.kind==='reviewer'&&result.result.issue===ROOT&&
    result.result.run_id===WORKFLOWS.reviewer[0]&&
    result.result.run_attempt===1&&result.result.target_sha===PUB_SHA&&
    result.result.outcome==='changes_requested'&&
    result.result.task_id===SUCCESSOR_ACTION,
    'persisted Reviewer Result outcome/SHA/attempt forged');
  requireIt(result.source?.repository===REPO&&
    result.source.path==='.github/workflows/agent-review.yml'&&
    result.source.name==='Agent / Review'&&
    result.source.run_id===WORKFLOWS.reviewer[0]&&result.source.attempt===1&&
    result.source.event==='workflow_dispatch'&&
    result.source.ref==='refs/heads/main'&&result.source.issue===ROOT&&
    result.source.agent_id==='review-qwen-01'&&
    result.source.input_sha===PUB_SHA&&result.source.output_sha===PUB_SHA&&
    result.source.verified===true,
    'persisted Reviewer Result source identity forged');
  requireIt(result.artifact?.id===RESULT_ARTIFACT_ID&&
    result.artifact.digest===RESULT_DIGEST&&
    result.artifact.source_run_id===WORKFLOWS.reviewer[0]&&
    result.artifact.source_run_attempt===1&&
    /^[0-9a-f]{64}$/.test(result.artifact.json_sha256??''),
    'persisted Reviewer Result artifact binding forged');
  requireIt(result.implementing_pr?.repository===REPO&&
    result.implementing_pr.number===PR&&
    result.implementing_pr.head_sha_at_attestation===PUB_SHA&&
    result.implementing_pr.relation==='trusted_pr_head_at_result_attestation',
    'persisted Reviewer Result is not bound to the exact original PR HEAD');
}
export function attestQwen4192Premodel({targetSha,head,states,latest,result,
  runs,jobs,artifacts,comment,pr,sourceCommit,mainAncestry,prAncestry}){
  requireIt(SHA.test(targetSha??'')&&
    ['identical','ahead'].includes(mainAncestry?.status)&&
    mainAncestry?.merge_base_commit?.sha===ACTIVATION_SHA&&
    mainAncestry.behind_by===0,
    'target main does not descend from the exact recovery activation SHA');
  requireIt(['identical','ahead'].includes(prAncestry?.status)&&
    prAncestry?.merge_base_commit?.sha===PUB_SHA&&prAncestry.behind_by===0,
    'current PR head no longer descends from the exact reviewed source SHA');
  requireIt(pr?.number===PR&&pr.head?.repo?.full_name===REPO&&
    pr.base?.repo?.full_name===REPO&&pr.base.ref==='main'&&
    pr.head.ref===PR_HEAD_REF&&SHA.test(pr.head.sha??''),
    'Publisher PR ownership changed');
  requireIt(sourceCommit?.sha===PUB_SHA&&
    sourceCommit?.parents?.length===1&&
    sourceCommit.parents[0]?.sha===BASE_SHA&&
    sourceCommit?.files?.length===1&&
    sourceCommit.files[0].filename===SOURCE_PATH&&
    sourceCommit.files[0].status==='modified',
    'original Git commit ownership or single-file patch scope changed');
  requireIt(comment?.id===OWNER_COMMENT_ID&&comment.user?.login===OWNER&&
    comment.body===OWNER_COMMAND&&comment.created_at===OWNER_COMMENT_AT&&
    comment.issue_url==='https://api.github.com/repos/'+REPO+'/issues/'+ROOT,
    'owner recovery command comment identity/body/target changed');
  for(const key of Object.keys(WORKFLOWS))validRun(runs?.[key],key);
  requireIt(Date.parse(comment.created_at)<Date.parse(runs.controller.created_at)&&
    runs.controller.created_at===CONTROLLER_CREATED_AT,
    'owner command did not precede the exact Controller dispatch');
  attestOriginalJobs(jobs?.original);
  attestControllerJobs(jobs?.controller);
  attestOriginalArtifacts(artifacts?.original);
  const verifiedResultArtifact=attestReviewerArtifacts(artifacts?.reviewer);
  attestStoreCas(states,latest,head);
  attestResult(result);
  return Object.freeze({
    schema_version:1,kind:'verified_qwen_4192_reviewer_premodel_recovery',
    verified:true,subject_issue:ISSUE,source_issue:ROOT,target_sha:targetSha,
    original_failed_review_run:WORKFLOWS.original[0],
    original_failed_review_attempt:1,
    original_failing_job:'prepare',original_failing_step:FAILING_STEP,
    original_review_and_metrics:'skipped',original_artifact_count:0,
    retired_review_action:INITIAL_REVIEW_ACTION,
    retirement_failure_code:FAILURE_CODE,
    owner_recovery_comment:OWNER_COMMENT_ID,
    authenticated_controller_run:WORKFLOWS.controller[0],
    distinct_signed_successor_action:SUCCESSOR_ACTION,
    successor_reviewer_run:WORKFLOWS.reviewer[0],successor_attempt:1,
    authenticated_result_ingest_run:WORKFLOWS.ingest[0],
    authenticated_reviewer_outcome:'changes_requested',
    reviewer_exact_sha:PUB_SHA,original_pr:PR,
    persisted_result_path:RESULT_PATH,
    verified_result_artifact:verifiedResultArtifact,
    immutable_store_source_versions:[9,12,13],
    recovery_activation_sha:ACTIVATION_SHA,
    source_main_ancestor:true,reviewed_pr_ancestry_verified:true,
    evidence_scope:'SC-02: independently attested original pre-model failure + owner-authenticated Controller + exactly one signed CAS successor on the unchanged PR SHA; SC-03: fresh native Reviewer executed and its changes_requested Result independently ingested at the exact original PR HEAD',
    limitation:'No issue-level automatic Pass, later repair-cycle approval, Rust Quality, deployment or #4012 historical contract migration inferred',
  });
}
function decodePinned(json,sourcePath){
  requireIt(json?.type==='file'&&json.path===sourcePath&&
    json.encoding==='base64'&&json.sha===EXPECTED_BLOB[sourcePath]&&
    typeof json.content==='string'&&
    Number.isSafeInteger(json.size)&&json.size>0&&json.size<=256*1024,
    'untrusted immutable Git blob '+sourcePath);
  const encoded=json.content.replace(/\s/g,'');
  const data=Buffer.from(encoded,'base64');
  const sha=createHash('sha1').update(Buffer.from('blob '+data.length+'\0'))
    .update(data).digest('hex');
  requireIt(data.length===json.size&&sha===json.sha&&
    data.toString('base64')===encoded,'immutable Store Git blob bytes mismatch '+sourcePath);
  return JSON.parse(data.toString('utf8'));
}
function decodeMutable(json,sourcePath){
  requireIt(json?.type==='file'&&json.path===sourcePath&&
    json.encoding==='base64'&&SHA.test(json.sha??'')&&
    Number.isSafeInteger(json.size)&&json.size>0&&json.size<=256*1024&&
    typeof json.content==='string','untrusted Store Contents object '+sourcePath);
  const encoded=json.content.replace(/\s/g,'');
  const data=Buffer.from(encoded,'base64');
  const sha=createHash('sha1').update(Buffer.from('blob '+data.length+'\0'))
    .update(data).digest('hex');
  requireIt(data.length===json.size&&sha===json.sha&&
    data.toString('base64')===encoded,'Store Git blob bytes mismatch '+sourcePath);
  return {value:JSON.parse(data.toString('utf8')),digest:HASH(data)};
}
export async function collectQwen4192Premodel({repo=REPO,stage,issue,targetSha,get}={}){
  if(stage!=='post-merge'||issue!==ISSUE)return null;
  requireIt(repo===REPO&&SHA.test(targetSha??'')&&typeof get==='function',
    'wrong repository or main-stage authority');
  const root='/repos/'+REPO,store=p=>root+'/contents/'+p+'?ref=agent-store';
  const head=await get(store('workflows/issues/4065/head.json'))
    .then(x=>decodeMutable(x,'workflows/issues/4065/head.json').value);
  requireIt(Number.isSafeInteger(head?.version)&&head.version>=13&&
    head.path===statePath(head.version),'canonical source Store head unavailable');
  const [v9,v12,v13,result,latest]=await Promise.all([
    get(store(statePath(9))).then(x=>decodePinned(x,statePath(9))),
    get(store(statePath(12))).then(x=>decodePinned(x,statePath(12))),
    get(store(statePath(13))).then(x=>decodePinned(x,statePath(13))),
    get(store(RESULT_PATH)).then(x=>decodePinned(x,RESULT_PATH)),
    // The mutable head pointer is independently checked against the exact
    // current file bytes, never trusted merely because it names a version.
    get(store(head.path)).then(x=>decodeMutable(x,head.path)),
  ]);
  const specs=Object.entries(WORKFLOWS);
  const [runEntries,originalJobs,controllerJobs,originalArtifacts,
    reviewerArtifacts,comment,pr,sourceCommit,mainAncestry]=await Promise.all([
    Promise.all(specs.map(async([key,s])=>[key,await get(root+'/actions/runs/'+s[0])])),
    get(root+'/actions/runs/'+WORKFLOWS.original[0]+'/attempts/1/jobs'),
    get(root+'/actions/runs/'+WORKFLOWS.controller[0]+'/attempts/1/jobs'),
    get(root+'/actions/runs/'+WORKFLOWS.original[0]+'/artifacts?per_page=100'),
    get(root+'/actions/runs/'+WORKFLOWS.reviewer[0]+'/artifacts?per_page=100'),
    get(root+'/issues/comments/'+OWNER_COMMENT_ID),
    get(root+'/pulls/'+PR),
    get(root+'/commits/'+PUB_SHA),
    get(root+'/compare/'+ACTIVATION_SHA+'...'+targetSha),
  ]);
  const prAncestry=await get(root+'/compare/'+PUB_SHA+'...'+pr.head.sha);
  return attestQwen4192Premodel({
    targetSha,head,states:{9:v9,12:v12,13:v13},latest,result,
    runs:Object.fromEntries(runEntries),
    jobs:{original:originalJobs,controller:controllerJobs},
    artifacts:{original:originalArtifacts,reviewer:reviewerArtifacts},
    comment,pr,sourceCommit,mainAncestry,prAncestry,
  });
}
function runFixture(key){
  const [id,name,file,sha,conclusion,event,actor]=WORKFLOWS[key];
  return {id,name,path:'.github/workflows/'+file,head_sha:sha,
    run_attempt:1,event,head_branch:'main',actor:{login:actor},
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    status:'completed',conclusion,
    created_at:key==='controller'?CONTROLLER_CREATED_AT:'2026-11-20T13:30:50Z'};
}
function outboxFixture(entries){return entries.map(e=>({...e,task:{...e.task},receipt:e.receipt?{...e.receipt}:null}));}
function devFailEntry(){return {id:DEV_FAIL_ACTION,status:'failed',
  task:{role:'developer',task:'implement',agent_id:'dev-qwen-01',sha:'8b7777f48a577d01961fd7d9e75311f75d6d57a1'},
  receipt:{status:'failed',dispatch_id:DEV_FAIL_ACTION,source_run_id:44733719096,
    source_attempt:1,failure_code:'qwen_tracked_source_gate_rejected'}};}
function initialEntry(status){return {id:INITIAL_REVIEW_ACTION,status,
  task:{role:'reviewer',task:'review',agent_id:'review-qwen-01',sha:PUB_SHA},
  receipt:status==='failed'
    ?{status:'failed',dispatch_id:INITIAL_REVIEW_ACTION,source_run_id:WORKFLOWS.original[0],
      source_attempt:1,failure_code:FAILURE_CODE}
    :{status:'verified',dispatch_id:INITIAL_REVIEW_ACTION,source_run_id:WORKFLOWS.original[0]}};}
function successorEntry(){return {id:SUCCESSOR_ACTION,status:'dispatched',
  task:{role:'reviewer',task:'review',agent_id:'review-qwen-01',sha:PUB_SHA},
  receipt:{status:'verified',dispatch_id:SUCCESSOR_ACTION,source_run_id:WORKFLOWS.reviewer[0]}};}
function stateFixture(version,phase,outbox,transitions=[]){
  return {issue:ROOT,version,schema_version:1,phase,target_sha:PUB_SHA,
    assignments:{developer:'dev-qwen-01',reviewer:'review-qwen-01',acceptor:'accept-qwen-01'},
    outbox:outboxFixture(outbox),transitions:transitions.map(t=>({...t}))};
}
const REVIEW_TRANSITION=Object.freeze({key:'ce7807f81dbab94a769c7267b1d8d54dad22933ba51f55a1ecd6a805864c168e',
  kind:'reviewer',run_id:WORKFLOWS.reviewer[0],attempt:1,target_sha:PUB_SHA,
  outcome:'changes_requested'});
function fixtures(){
  const v9=stateFixture(9,'review',[devFailEntry(),initialEntry('dispatched')]);
  const v12=stateFixture(12,'review',[devFailEntry(),initialEntry('failed'),successorEntry()]);
  const v13=stateFixture(13,'repair',[devFailEntry(),initialEntry('failed'),
    {id:REPAIR_ACTION,status:'pending',
      task:{role:'developer',task:'repair',agent_id:'dev-qwen-01',sha:PUB_SHA},receipt:null}],
    [REVIEW_TRANSITION]);
  const latestValue=stateFixture(37,'quality',
    [devFailEntry(),initialEntry('failed')],[REVIEW_TRANSITION]);
  const head={version:37,path:statePath(37),sha256:'d'.repeat(64)};
  const prepareSteps=[
    {name:'Set up job',status:'completed',conclusion:'success'},
    {name:FAILING_STEP,status:'completed',conclusion:'failure'},
    {name:'Upload the verified admission',status:'completed',conclusion:'skipped'},
  ];
  return {
    targetSha:'c'.repeat(40),head,
    states:{9:v9,12:v12,13:v13},
    latest:{value:latestValue,digest:head.sha256},
    result:{schema_version:2,kind:'authenticated_agent_task_result',issue:ROOT,
      action_id:SUCCESSOR_ACTION,acceptance_result:null,
      result:{kind:'reviewer',issue:ROOT,run_id:WORKFLOWS.reviewer[0],run_attempt:1,
        target_sha:PUB_SHA,outcome:'changes_requested',task_id:SUCCESSOR_ACTION},
      source:{repository:REPO,path:'.github/workflows/agent-review.yml',
        name:'Agent / Review',run_id:WORKFLOWS.reviewer[0],attempt:1,
        event:'workflow_dispatch',ref:'refs/heads/main',issue:ROOT,
        task_id:SUCCESSOR_ACTION,agent_id:'review-qwen-01',
        input_sha:PUB_SHA,output_sha:PUB_SHA,verified:true},
      artifact:{id:RESULT_ARTIFACT_ID,digest:RESULT_DIGEST,
        json_sha256:'75b471b2298a6793a36514ec65af266044c8d6cfba203a2790d0c917babe75bf',
        source_run_id:WORKFLOWS.reviewer[0],source_run_attempt:1},
      implementing_pr:{repository:REPO,number:PR,head_sha_at_attestation:PUB_SHA,
        relation:'trusted_pr_head_at_result_attestation'}},
    runs:{original:runFixture('original'),controller:runFixture('controller'),
      reviewer:runFixture('reviewer'),ingest:runFixture('ingest')},
    jobs:{original:{total_count:3,jobs:[
      {id:136317768286,name:'prepare',status:'completed',conclusion:'failure',steps:prepareSteps},
      {id:136318020115,name:'review',status:'completed',conclusion:'skipped',steps:[]},
      {id:136318020333,name:'notify-metrics',status:'completed',conclusion:'skipped',steps:[]}]},
      controller:{total_count:1,jobs:[{id:136415669961,name:'trusted-dispatch',
        status:'completed',conclusion:'success'}]}},
    artifacts:{original:{total_count:0,artifacts:[]},
      reviewer:{artifacts:[{id:RESULT_ARTIFACT_ID,name:RESULT_ARTIFACT,
        expired:false,size_in_bytes:335,digest:RESULT_DIGEST,
        workflow_run:{id:WORKFLOWS.reviewer[0],head_sha:ACTIVATION_SHA}}]}},
    comment:{id:OWNER_COMMENT_ID,user:{login:OWNER},body:OWNER_COMMAND,
      created_at:OWNER_COMMENT_AT,
      issue_url:'https://api.github.com/repos/'+REPO+'/issues/'+ROOT},
    pr:{number:PR,head:{sha:'e'.repeat(40),ref:PR_HEAD_REF,repo:{full_name:REPO}},
      base:{ref:'main',repo:{full_name:REPO}}},
    sourceCommit:{sha:PUB_SHA,parents:[{sha:BASE_SHA}],
      files:[{filename:SOURCE_PATH,status:'modified'}]},
    mainAncestry:{status:'ahead',behind_by:0,merge_base_commit:{sha:ACTIVATION_SHA}},
    prAncestry:{status:'ahead',behind_by:0,merge_base_commit:{sha:PUB_SHA}},
  };
}
export function selfTestQwen4192Premodel(){
  assert.notEqual(INITIAL_REVIEW_ACTION,SUCCESSOR_ACTION);
  assert.equal(WORKFLOWS.original[4],'failure');
  assert.equal(WORKFLOWS.controller[5],'issue_comment');
  assert.equal(WORKFLOWS.ingest[5],'repository_dispatch');
  const positive=attestQwen4192Premodel(fixtures());
  assert.equal(positive.verified,true);
  assert.equal(positive.kind,'verified_qwen_4192_reviewer_premodel_recovery');
  assert.equal(positive.authenticated_reviewer_outcome,'changes_requested');
  assert.equal(positive.reviewer_exact_sha,PUB_SHA);
  assert.equal(positive.original_artifact_count,0);
  const negatives=[
    ['wrong original Run',f=>{f.runs.original.id=1;}],
    ['attempt-2 original',f=>{f.runs.original.run_attempt=2;}],
    ['push-event original',f=>{f.runs.original.event='push';}],
    ['owner-actor original',f=>{f.runs.original.actor={login:OWNER};}],
    ['wrong original SHA',f=>{f.runs.original.head_sha='f'.repeat(40);}],
    ['success original',f=>{f.runs.original.conclusion='success';}],
    ['bot-actor controller',f=>{f.runs.controller.actor={login:'github-actions[bot]'};}],
    ['dispatch-event controller',f=>{f.runs.controller.event='workflow_dispatch';}],
    ['failed successor reviewer',f=>{f.runs.reviewer.conclusion='failure';}],
    ['dispatch-event ingest',f=>{f.runs.ingest.event='workflow_dispatch';}],
    ['attempt-2 ingest',f=>{f.runs.ingest.run_attempt=2;}],
    ['staging branch',f=>{f.runs.reviewer.head_branch='staging';}],
    ['prepare succeeded',f=>{f.jobs.original.jobs[0].conclusion='success';}],
    ['renamed failing step',f=>{f.jobs.original.jobs[0].steps[1].name='Other step';}],
    ['review not skipped',f=>{f.jobs.original.jobs[1].conclusion='success';}],
    ['extra original job',f=>{f.jobs.original.total_count=4;
      f.jobs.original.jobs.push({id:9,name:'extra',status:'completed',conclusion:'success'});}],
    ['admission uploaded',f=>{f.jobs.original.jobs[0].steps[2].conclusion='success';}],
    ['controller job failed',f=>{f.jobs.controller.jobs[0].conclusion='failure';}],
    ['original artifact exists',f=>{f.artifacts.original={total_count:1,
      artifacts:[{name:'forged'}]};}],
    ['expired result artifact',f=>{f.artifacts.reviewer.artifacts[0].expired=true;}],
    ['forged result digest',f=>{f.artifacts.reviewer.artifacts[0].digest='sha256:'+'0'.repeat(64);}],
    ['foreign artifact run',f=>{f.artifacts.reviewer.artifacts[0].workflow_run.id=1;}],
    ['duplicate result artifact',f=>{f.artifacts.reviewer.artifacts.push(
      {...f.artifacts.reviewer.artifacts[0]});}],
    ['missing retirement code',f=>{delete f.states[12].outbox[1].receipt.failure_code;}],
    ['wrong retirement source run',f=>{f.states[12].outbox[1].receipt.source_run_id=1;}],
    ['retirement attempt 2',f=>{f.states[12].outbox[1].receipt.source_attempt=2;}],
    ['two successors',f=>{f.states[12].outbox.push({...successorEntry(),id:'a'.repeat(64)});}],
    ['v9 reviewer already failed',f=>{f.states[9].outbox[1]=initialEntry('failed');}],
    ['v13 approved outcome',f=>{f.states[13].transitions[0].outcome='approved';}],
    ['v13 wrong target SHA',f=>{f.states[13].target_sha='f'.repeat(40);}],
    ['v13 no repair action',f=>{f.states[13].outbox.pop();}],
    ['latest dropped transition',f=>{f.latest.value.transitions=[];}],
    ['latest revived original action',f=>{f.latest.value.outbox[1].status='dispatched';}],
    ['head too old',f=>{f.head={version:12,path:statePath(12),sha256:'d'.repeat(64)};}],
    ['head digest mismatch',f=>{f.latest.digest='e'.repeat(64);}],
    ['forged result outcome',f=>{f.result.result.outcome='approved';}],
    ['result wrong attested HEAD',f=>{f.result.implementing_pr.head_sha_at_attestation='f'.repeat(40);}],
    ['result wrong artifact digest',f=>{f.result.artifact.digest='sha256:'+'0'.repeat(64);}],
    ['result carries acceptance',f=>{f.result.acceptance_result={result:'Pass'};}],
    ['result unverified source',f=>{f.result.source.verified=false;}],
    ['result wrong PR',f=>{f.result.implementing_pr.number=1;}],
    ['external comment author',f=>{f.comment.user={login:'external'};}],
    ['edited command body',f=>{f.comment.body=OWNER_COMMAND+' attempt=2';}],
    ['comment on a PR',f=>{f.comment.issue_url='https://api.github.com/repos/'+REPO+'/issues/'+PR;}],
    ['comment after dispatch',f=>{f.comment.created_at='2026-11-20T16:25:00Z';}],
    ['main behind activation',f=>{f.mainAncestry.behind_by=1;}],
    ['wrong main merge base',f=>{f.mainAncestry.merge_base_commit={sha:'f'.repeat(40)};}],
    ['PR head unrelated',f=>{f.prAncestry.merge_base_commit={sha:'f'.repeat(40)};}],
    ['wrong PR number',f=>{f.pr.number=1;}],
    ['wrong PR head ref',f=>{f.pr.head.ref='agent/other';}],
    ['two-file source commit',f=>{f.sourceCommit.files.push({filename:'other.rs',status:'added'});}],
    ['wrong source parent',f=>{f.sourceCommit.parents=[{sha:'f'.repeat(40)}];}],
  ];
  for(const [label,mutate] of negatives){
    const f=fixtures();mutate(f);
    assert.throws(()=>attestQwen4192Premodel(f),
      /authenticated #4192 Reviewer pre-model recovery/,'negative fixture accepted: '+label);
  }
  console.log('#4192 Reviewer pre-model recovery: exact Run/Job/Step/Artifact/Store-CAS/owner-command positive and '+
    negatives.length+' fail-closed negative fixtures passed');
}
if(process.argv[2]==='self-test')selfTestQwen4192Premodel();
