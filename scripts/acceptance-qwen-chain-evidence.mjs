// #2817: authenticate the one controlled real Qwen Developer -> Store ->
// Publisher -> Reviewer chain from its exact GitHub Runs, committed Store
// bytes and merged PR. This module only reads evidence; it never writes the
// Store, Issues or a PR. The Acceptance Agent remains the SC verdict owner.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createGitHubResultArtifactReader,decodeResultZip}
  from './lib/agent/orchestration/result-artifact.mjs';

const REPO='BestNathan/nession',ISSUE=2817;
const HEX40=/^[a-f0-9]{40}$/,HEX64=/^[a-f0-9]{64}$/;
const INIT_SHA='149df703ff383e7bb6958eb6d1448f6ad7248ca6';
const WORKER_SHA='c5372a9c4865750182319f38ec642238b23dc2f5';
const FIX_SHA='0bd85f78ce315323c617d11e65d0cc9861cebe35';
const PR_HEAD='52ecf6640f6d22f97e58a3ef559aa03493651680';
const PR_MERGE='357b5aa17554cbdeb426c1bb94ca710f82caf8cf';
const PR_NUMBER=2891;
const SOURCE_FILE='e2e/fixtures/agent-development/qwen-source.md';
const WORKER_ACTION='1eafaeb9a57b5ed5619fb0bfbce7474b11618239348ec334f142020b95ee9ef7';
const REVIEW_ACTION='152e80d25594beccd24b4b1f60820c5def69393a7af8cd1f81bcab6a77c8c6f1';
const INIT_ACTION='61bced6ae498054e883d8a52d7398e7877852ef6a3c41e93644138a4b47dacb3';
const CHECKPOINT='roles/developer/dev-qwen-01/issues/2817/checkpoints/00000001.json';
const RUN_RECEIPT='roles/developer/dev-qwen-01/issues/2817/runs/42344231027-1.json';
const CONTROLLER='.github/workflows/agent-controller-dispatch.yml';
const RUNS=Object.freeze({
  initController:{id:42183468789,attempt:1,name:'Acceptance / Agent Controller',
    path:'.github/workflows/acceptance-agent-controller.yml',event:'workflow_dispatch',
    head_sha:INIT_SHA,actor:'BestNathan'},
  initIngest:{id:42183508227,attempt:1,name:'Store / Agent Controller Ingest',
    path:'.github/workflows/store-agent-controller-ingest.yml',event:'workflow_run',
    head_sha:INIT_SHA,actor:'BestNathan'},
  initDispatch:{id:42187563201,attempt:1,name:'Agent / Controller Dispatch',
    path:CONTROLLER,event:'workflow_dispatch',head_sha:INIT_SHA,actor:'BestNathan'},
  workerDispatch:{id:42344200839,attempt:1,name:'Agent / Controller Dispatch',
    path:CONTROLLER,event:'workflow_dispatch',head_sha:WORKER_SHA,actor:'BestNathan'},
  worker:{id:42344231027,attempt:1,name:'Agent / Development',
    path:'.github/workflows/agent-develop.yml',event:'workflow_dispatch',
    head_sha:WORKER_SHA,actor:'github-actions[bot]'},
  developmentIngest:{id:42353290383,attempt:1,name:'Store / Agent Development Ingest',
    path:'.github/workflows/store-agent-development-ingest.yml',event:'issue_comment',
    head_sha:FIX_SHA,actor:'BestNathan'},
  publisher:{id:42353330828,attempt:1,name:'Store / Qwen Publisher',
    path:'.github/workflows/store-qwen-publisher.yml',event:'workflow_run',
    head_sha:FIX_SHA,actor:'BestNathan'},
  reviewDispatch:{id:42354141027,attempt:1,name:'Agent / Controller Dispatch',
    path:CONTROLLER,event:'workflow_dispatch',head_sha:FIX_SHA,actor:'BestNathan'},
  review:{id:42354175666,attempt:6,name:'Agent / Review',
    path:'.github/workflows/agent-review.yml',event:'workflow_dispatch',
    head_sha:FIX_SHA,actor:'github-actions[bot]'},
  reviewIngest:{id:42355972712,attempt:1,name:'Store / Agent Review Result Ingest',
    path:'.github/workflows/store-agent-review-result-ingest.yml',
    event:'repository_dispatch',head_sha:FIX_SHA,actor:'github-actions[bot]'},
});
function fail(message){throw Error('authenticated Qwen chain evidence: '+message);}
function sha256(bytes){return createHash('sha256').update(bytes).digest('hex');}
function positive(n){return Number.isSafeInteger(n)&&n>0;}
function git(dir,args){
  try{return execFileSync('git',['-C',dir,...args],{encoding:'utf8',
    stdio:['ignore','pipe','pipe'],timeout:45000,maxBuffer:64*1024*1024,
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
  }).trim();}
  catch{fail('read-only Git Store access failed');}
}
function relative(value){
  if(typeof value!=='string'||!value||value.startsWith('/')||value.includes('\\')||
     value.split('/').some(x=>!x||x==='.'||x==='..')||value.includes('\0'))
    fail('unsafe Store path');
  return value;
}
function readJson(root,file,max){
  const rel=relative(file),full=path.join(root,rel);
  let st;
  try{st=fs.lstatSync(full);}catch{fail('missing immutable Store object '+rel);}
  if(!st.isFile()||st.isSymbolicLink()||st.size<2||st.size>max)
    fail('untrusted Store object '+rel);
  let value;
  try{value=JSON.parse(fs.readFileSync(full,'utf8'));}
  catch{fail('invalid Store JSON '+rel);}
  return value;
}
function readBytes(root,file,max){
  const rel=relative(file),full=path.join(root,rel);
  const st=fs.lstatSync(full);
  if(!st.isFile()||st.isSymbolicLink()||st.size<2||st.size>max)
    fail('untrusted Store bytes '+rel);
  return fs.readFileSync(full);
}
export function assertQwenChainRun(run,spec){
  if(!run||typeof run!=='object'||Array.isArray(run)||
     run.id!==spec.id||run.run_attempt!==spec.attempt||
     run.name!==spec.name||run.path!==spec.path||run.event!==spec.event||
     run.head_sha!==spec.head_sha||run.head_branch!=='main'||
     run.status!=='completed'||run.conclusion!=='success'||
     run.actor?.login!==spec.actor||run.repository?.full_name!==REPO||
     run.head_repository?.full_name!==REPO||
     !HEX40.test(run.head_sha??'')||!Number.isFinite(Date.parse(run.created_at??'')))
    fail('untrusted '+spec.name+' Run '+spec.id+'/'+spec.attempt);
  return Object.freeze({id:run.id,attempt:run.run_attempt,
    run_attempt:run.run_attempt,name:run.name,
    path:run.path,event:run.event,head_sha:run.head_sha,
    status:run.status,conclusion:run.conclusion,
    actor:run.actor.login,created_at:run.created_at,html_url:run.html_url});
}
export function assertQwenStateOne(state){
  const task=state?.outbox?.[0]?.task;
  if(state?.version!==1||state.phase!=='ready'||state.target_sha!==null||
     state.assignments?.developer!=='dev-qwen-01'||
     state.assignments?.reviewer!=='review-qwen-01'||
     state.assignments?.acceptor!=='accept-qwen-01'||
     !Array.isArray(state.transitions)||state.transitions.length!==0||
     !Array.isArray(state.outbox)||state.outbox.length!==1||
     state.outbox[0].id!==INIT_ACTION||state.outbox[0].status!=='pending'||
     task?.type!=='dispatch'||task?.role!=='developer'||
     task?.task!=='implement'||task?.agent_id!=='dev-qwen-01'||
     task?.sha!==INIT_SHA)
    fail('immutable v1 State does not establish the controlled fixture');
  return Object.freeze({version:1,phase:'ready',state_path:null,
    action_id:INIT_ACTION,action_sha:INIT_SHA,action_status:'pending',
    assignments:{...state.assignments}});
}
export function assertQwenWorkerReceipt(receipt,checkpoint){
  if(receipt?.schema_version!==1||receipt.kind!=='agent_checkpoint_run'||
     receipt.role!=='developer'||receipt.agent_id!=='dev-qwen-01'||
     receipt.issue!==ISSUE||receipt.run_id!==RUNS.worker.id||
     receipt.attempt!==RUNS.worker.attempt||receipt.source_sha!==INIT_SHA||
     receipt.workflow_sha!==WORKER_SHA||
     receipt.workflow!==RUNS.worker.path||
     receipt.checkpoint_path!==CHECKPOINT||receipt.version!==1||
     !HEX64.test(receipt.ciphertext_sha256??'')||
     !HEX64.test(receipt.harness_digest??'')||
     checkpoint?.schema_version!==1||checkpoint.kind!=='encrypted_agent_checkpoint'||
     checkpoint.version!==1||checkpoint.path!==CHECKPOINT||
     checkpoint.identity?.role!=='developer'||
     checkpoint.identity?.agent_id!=='dev-qwen-01'||
     checkpoint.identity?.issue!==ISSUE||
     checkpoint.ciphertext_sha256!==receipt.ciphertext_sha256||
     checkpoint.metadata?.provider!=='claude-code'||
     checkpoint.metadata?.source_sha!==INIT_SHA||
     checkpoint.metadata?.harness_digest!==receipt.harness_digest||
     !/^[0-9a-f-]{36}$/.test(checkpoint.metadata?.session_id??'')||
     typeof checkpoint.ciphertext!=='string'||checkpoint.ciphertext.length<1||
     sha256(Buffer.from(checkpoint.ciphertext,'base64'))!==
       receipt.ciphertext_sha256)
    fail('Worker receipt/checkpoint is not the exact encrypted native Session');
  return Object.freeze({run_id:receipt.run_id,attempt:receipt.attempt,
    workflow_sha:receipt.workflow_sha,source_sha:receipt.source_sha,
    checkpoint_version:receipt.version,
    ciphertext_sha256:receipt.ciphertext_sha256,
    harness_digest:receipt.harness_digest,
    provider:checkpoint.metadata.provider,
    session_id:checkpoint.metadata.session_id,
    checkpoint_path:CHECKPOINT});
}
export function assertQwenPublisherIntent(intent){
  const expected='workflows/issues/'+ISSUE+'/results/'+RUNS.worker.id+'-1-'+
    WORKER_ACTION+'.json';
  if(intent?.schema_version!==1||
     intent.kind!=='trusted_qwen_publisher_write_ahead_intent'||
     intent.repository!==REPO||intent.issue!==ISSUE||
     intent.action_id!==WORKER_ACTION||intent.worker_run_id!==RUNS.worker.id||
     intent.worker_run_attempt!==1||intent.worker_sha!==WORKER_SHA||
     intent.source_sha!==FIX_SHA||intent.worker_source_sha!==INIT_SHA||
     intent.checkpoint_version!==1||
     !HEX40.test(intent.checkpoint_commit_sha??'')||
     !HEX64.test(intent.checkpoint_ciphertext_sha256??'')||
     !HEX64.test(intent.patch_sha256??'')||
     !HEX64.test(intent.file_manifest_sha256??'')||
     intent.file_count!==1||intent.target_main_sha!==FIX_SHA||
     intent.branch!=='agent/'+ISSUE+'/qwen-'+WORKER_ACTION.slice(0,16)||
     intent.publisher_run_id!==RUNS.publisher.id||
     intent.publication!=='not_yet_attested')
    fail('Publisher write-ahead Intent is not the exact Worker publication');
  return {path:expected,action_id:WORKER_ACTION,
    worker_source_sha:intent.worker_source_sha,source_sha:intent.source_sha,
    target_main_sha:intent.target_main_sha,branch:intent.branch,
    patch_sha256:intent.patch_sha256,
    checkpoint_commit_sha:intent.checkpoint_commit_sha,
    checkpoint_ciphertext_sha256:intent.checkpoint_ciphertext_sha256};
}
export function assertQwenReviewResult(record,actionId=REVIEW_ACTION){
  const result=record?.result;
  if(record?.schema_version!==2||
     record.kind!=='authenticated_agent_task_result'||
     record.issue!==ISSUE||record.action_id!==actionId||
     result?.kind!=='reviewer'||result.issue!==ISSUE||
     result.run_id!==RUNS.review.id||
     result.run_attempt!==RUNS.review.attempt||
     result.target_sha!==PR_HEAD||result.outcome!=='approved'||
     result.task_id!==actionId||
     record.source?.repository!==REPO||record.source?.path!==RUNS.review.path||
     record.source?.name!==RUNS.review.name||
     record.source?.run_id!==RUNS.review.id||
     record.source?.attempt!==RUNS.review.attempt||
     record.source?.event!==RUNS.review.event||
     record.source?.agent_id!=='review-qwen-01'||
     record.source?.input_sha!==PR_HEAD||record.source?.output_sha!==PR_HEAD||
     record.source?.verified!==true||
     !positive(record.artifact?.id)||
     !/^sha256:[a-f0-9]{64}$/.test(record.artifact?.digest??'')||
     !HEX64.test(record.artifact?.json_sha256??'')||
     record.artifact?.source_run_id!==RUNS.review.id||
     record.artifact?.source_run_attempt!==RUNS.review.attempt||
     record.implementing_pr?.repository!==REPO||
     record.implementing_pr?.number!==PR_NUMBER||
     record.implementing_pr?.head_sha_at_attestation!==PR_HEAD)
    fail('Reviewer result is not the exact approved published PR verdict');
  return Object.freeze({action_id:actionId,
    run_id:result.run_id,attempt:result.run_attempt,
    target_sha:result.target_sha,outcome:result.outcome,
    artifact_id:record.artifact.id,artifact_digest:record.artifact.digest,
    artifact_json_sha256:record.artifact.json_sha256,
    pr_number:record.implementing_pr.number});
}
export function assertQwenPublishedPullRequest(pr,files,branchPulls){
  if(pr?.number!==PR_NUMBER||pr.state!=='closed'||pr.merged!==true||
     pr.base?.ref!=='main'||pr.base?.repo?.full_name!==REPO||
     pr.head?.sha!==PR_HEAD||pr.head?.repo?.full_name!==REPO||
     pr.merge_commit_sha!==PR_MERGE||!pr.merged_at||
     pr.merged_by?.login!=='BestNathan')
    fail('published PR is not the exact owner-merged main-target branch');
  if(!Array.isArray(branchPulls)||branchPulls.length!==1||
     branchPulls[0].number!==PR_NUMBER)
    fail('published branch has more than one PR');
  if(!Array.isArray(files)||files.length!==1||
     files[0].filename!==SOURCE_FILE||files[0].status!=='modified'||
     files[0].additions!==1||files[0].deletions!==1||
     typeof files[0].patch!=='string'||
     !files[0].patch.includes('-implementation: pending')||
     !files[0].patch.includes('+implementation: qwen-verified')||
     files[0].patch.includes('+implementation: pending'))
    fail('published PR does not contain the single authorized fixture edit');
  return Object.freeze({number:pr.number,head_sha:pr.head.sha,
    merge_commit_sha:pr.merge_commit_sha,base:pr.base.ref,
    merged_at:pr.merged_at,merged_by:pr.merged_by.login,
    one_pr_on_branch:true,
    files:[{path:files[0].filename,status:files[0].status,
      additions:files[0].additions,deletions:files[0].deletions}]});
}

async function fetchChainRuns(get){
  const entries=await Promise.all(Object.entries(RUNS).map(async([key,spec])=>{
    const run=await get('/repos/'+REPO+'/actions/runs/'+spec.id);
    return [key,assertQwenChainRun(run,spec)];
  }));
  return Object.fromEntries(entries);
}
function assertAncestor(workspace,ancestor,target){
  if(!HEX40.test(ancestor)||!HEX40.test(target))fail('invalid ancestry input');
  try{execFileSync('git',['-C',workspace,'merge-base','--is-ancestor',ancestor,target],{
    stdio:['ignore','ignore','pipe'],timeout:45000,
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
  });}
  catch{fail(ancestor+' is not an ancestor of the accepted target');}
}
function readCurrentState(store){
  const head=readJson(store,'workflows/issues/'+ISSUE+'/head.json',8192);
  if(typeof head.path!=='string'||
     !new RegExp('^workflows/issues/'+ISSUE+'/states/[0-9]{8}\\.json$').test(head.path)||
     !HEX64.test(head.sha256??''))
    fail('invalid Issue Store head');
  const raw=readBytes(store,head.path,1024*1024);
  if(sha256(raw)!==head.sha256)fail('Issue Store head hash mismatch');
  let state;
  try{state=JSON.parse(raw.toString('utf8'));}
  catch{fail('invalid Issue Store state JSON');}
  if(state.version!==head.version||!positive(state.version))
    fail('Issue Store head/version mismatch');
  const transition=(kind,run,attempt,target,outcome)=>state.transitions?.some(t=>
    t.kind===kind&&t.run_id===run&&t.attempt===attempt&&
    t.target_sha===target&&t.outcome===outcome);
  if(!transition('publisher',RUNS.publisher.id,RUNS.publisher.attempt,
      PR_HEAD,'published')||
     !transition('reviewer',RUNS.review.id,RUNS.review.attempt,
      PR_HEAD,'approved')||
     state.target_sha!==PR_HEAD||
     state.assignments?.developer!=='dev-qwen-01'||
     state.assignments?.reviewer!=='review-qwen-01'||
     state.assignments?.acceptor!=='accept-qwen-01'||
     !['quality','acceptance','waiting-merge','post-merge-acceptance','done']
       .includes(state.phase))
    fail('Store has not accepted the exact Publisher and Reviewer results');
  return Object.freeze({version:state.version,phase:state.phase,
    target_sha:state.target_sha,head_path:head.path,head_sha256:head.sha256,
    publisher_transition:true,reviewer_transition:true});
}
function listResults(store){
  const dir=path.join(store,'workflows/issues/'+ISSUE+'/results');
  const names=fs.readdirSync(dir).filter(x=>x.endsWith('.json')).sort();
  if(names.length>16)fail('excessive Issue result records');
  return names.map(name=>{
    const rel='workflows/issues/'+ISSUE+'/results/'+name;
    return {name,rel,value:readJson(store,rel,64*1024)};
  });
}
export async function collectAuthenticatedQwenChain({
  repo,targetSha,issue,stage,workspace,get,telemetryForRun,token=process.env.GITHUB_TOKEN,
}={}){
  if(stage!=='post-merge'||issue!==ISSUE)return null;
  if(repo!==REPO||!HEX40.test(targetSha??'')||typeof workspace!=='string'||
     !path.isAbsolute(workspace)||typeof get!=='function'||
     typeof telemetryForRun!=='function'||
     typeof token!=='string'||token.length<8)
    fail('invalid collection request');
  // The fixture becomes a finished chain only at/after its merged PR. An
  // acceptance run on an earlier ancestor simply has no fixture evidence and
  // must not fail the unrelated acceptance attempt.
  try{assertAncestor(workspace,PR_MERGE,targetSha);}catch{return null;}
  for(const sha of [INIT_SHA,WORKER_SHA,FIX_SHA,PR_HEAD])
    assertAncestor(workspace,sha,targetSha);
  const runs=await fetchChainRuns(get);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-chain-evidence-'));
  try{
    const store=path.join(temp,'agent-store');
    try{execFileSync('git',['clone','--quiet','--no-tags','--single-branch',
      '--branch','agent-store','--','https://github.com/'+REPO+'.git',store],{
      stdio:['ignore','pipe','pipe'],timeout:90000,
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
    });}catch{fail('cannot read the committed agent-store branch');}
    const state1Path='workflows/issues/'+ISSUE+'/states/00000001.json';
    const one=assertQwenStateOne(readJson(store,state1Path,1024*1024));
    const state1Sha256=sha256(readBytes(store,state1Path,1024*1024));
    const state1Commit=git(store,['log','--diff-filter=A','-1','--format=%H',
      'HEAD','--',state1Path]);
    if(!HEX40.test(state1Commit))fail('missing immutable v1 State commit');
    if(git(store,['log','-1','--format=%H','HEAD','--',state1Path])!==
       state1Commit)fail('immutable v1 State was modified after creation');
    const current=readCurrentState(store);
    const receipt=readJson(store,RUN_RECEIPT,8192);
    const checkpoint=readJson(store,CHECKPOINT,32*1024*1024);
    const worker=assertQwenWorkerReceipt(receipt,checkpoint);
    const checkpointCommit=git(store,['log','-1','--format=%H','HEAD','--',
      CHECKPOINT]);
    if(!HEX40.test(checkpointCommit))
      fail('missing committed Qwen checkpoint creator');
    const results=listResults(store);
    const intents=results.filter(x=>
      x.name.startsWith(RUNS.worker.id+'-1-'));
    if(intents.length!==1)fail('missing unique Publisher Intent');
    const intent=assertQwenPublisherIntent(intents[0].value);
    if(intent.path!==intents[0].rel||
       intent.checkpoint_commit_sha!==checkpointCommit||
       intent.checkpoint_ciphertext_sha256!==worker.ciphertext_sha256)
      fail('Publisher Intent does not bind the committed checkpoint');
    const reviews=results.filter(x=>
      x.name.startsWith(RUNS.review.id+'-'+RUNS.review.attempt+'-'));
    if(reviews.length!==1)fail('missing unique Reviewer result record');
    const review=assertQwenReviewResult(reviews[0].value);
    const checkpoints=git(store,['ls-tree','-r','--name-only','HEAD','--',
      'roles']).split('\n').filter(x=>x.includes('/issues/'+ISSUE+'/checkpoints/'));
    if(checkpoints.length!==1||checkpoints[0]!==CHECKPOINT)
      fail('unexpected additional native checkpoint');
    const pr=await get('/repos/'+REPO+'/pulls/'+PR_NUMBER);
    const files=await get('/repos/'+REPO+'/pulls/'+PR_NUMBER+'/files?per_page=100');
    const branchPulls=await get('/repos/'+REPO+'/pulls?state=all&head='+
      encodeURIComponent('BestNathan:'+intent.branch)+'&per_page=100');
    const pull=assertQwenPublishedPullRequest(pr,files,branchPulls);
    const artifacts=createGitHubResultArtifactReader(token);
    const reviewArtifacts=await artifacts.listRunArtifacts(RUNS.review.id);
    const listed=Array.isArray(reviewArtifacts?.artifacts)&&
      reviewArtifacts.artifacts.length===reviewArtifacts.total_count
      ? reviewArtifacts.artifacts : [];
    const resultArtifact=listed.filter(x=>
      x.name==='agent-result-'+RUNS.review.id+'-'+RUNS.review.attempt+'-'+
        REVIEW_ACTION);
    if(resultArtifact.length!==1||
       resultArtifact[0].id!==review.artifact_id||
       resultArtifact[0].digest!==review.artifact_digest)
      fail('Reviewer Agent result artifact identity changed');
    const resultZip=await artifacts.downloadZip(review.artifact_id);
    if(sha256(resultZip)!==review.artifact_digest.slice(7))
      fail('Reviewer Agent result artifact digest mismatch');
    const resultBytes=decodeResultZip(resultZip,'agent-result.json');
    if(sha256(resultBytes)!==review.artifact_json_sha256)
      fail('Reviewer Agent result JSON digest mismatch');
    const resultDoc=JSON.parse(new TextDecoder('utf-8',{fatal:true})
      .decode(resultBytes));
    if(resultDoc.kind!=='reviewer'||resultDoc.issue!==ISSUE||
       resultDoc.run_id!==RUNS.review.id||
       resultDoc.run_attempt!==RUNS.review.attempt||
       resultDoc.target_sha!==PR_HEAD||resultDoc.outcome!==review.outcome||
       resultDoc.task_id!==REVIEW_ACTION)
      fail('Reviewer Agent result artifact is not the exact approval');
    const verdictArtifact=listed.filter(x=>
      x.name==='reviewer-slice-'+RUNS.review.id+'-'+RUNS.review.attempt);
    if(verdictArtifact.length!==1)
      fail('missing unique Reviewer verdict artifact');
    const verdictZip=await artifacts.downloadZip(verdictArtifact[0].id);
    const verdictBytes=decodeResultZip(verdictZip,'review-verdict.json');
    const verdict=JSON.parse(new TextDecoder('utf-8',{fatal:true})
      .decode(verdictBytes));
    if(verdict.kind!=='reviewer_verdict'||verdict.issue!==ISSUE||
       verdict.action_id!==REVIEW_ACTION||verdict.target_sha!==PR_HEAD||
       verdict.outcome!=='approved')
      fail('Reviewer verdict artifact is not the exact approval');
    const ingestArtifacts=await artifacts.listRunArtifacts(
      RUNS.developmentIngest.id);
    const ingestReceiptArtifact=Array.isArray(ingestArtifacts?.artifacts)&&
      ingestArtifacts.artifacts.length===ingestArtifacts.total_count
      ? ingestArtifacts.artifacts.filter(x=>
        x.name==='development-qwen-ingest-'+RUNS.developmentIngest.id+'-'+
          RUNS.developmentIngest.attempt)
      : [];
    if(ingestReceiptArtifact.length!==1)
      fail('missing unique Qwen Store Ingest receipt artifact');
    const ingestZip=await artifacts.downloadZip(ingestReceiptArtifact[0].id);
    const ingestBytes=decodeResultZip(ingestZip,'development-ingest-receipt.json');
    const ingestReceipt=JSON.parse(new TextDecoder('utf-8',{fatal:true})
      .decode(ingestBytes));
    if(ingestReceipt.kind!=='authenticated_qwen_development_checkpoint_receipt'||
       ingestReceipt.issue!==ISSUE||
       ingestReceipt.ingester_run_id!==RUNS.developmentIngest.id||
       ingestReceipt.ingester_sha!==FIX_SHA||
       ingestReceipt.action_id!==WORKER_ACTION||
       ingestReceipt.run_id!==RUNS.worker.id||
       ingestReceipt.attempt!==RUNS.worker.attempt||
       ingestReceipt.worker_sha!==WORKER_SHA||
       ingestReceipt.checkpoint_version!==1||
       ingestReceipt.checkpoint_commit_sha!==checkpointCommit||
       ingestReceipt.ciphertext_sha256!==worker.ciphertext_sha256)
      fail('Qwen Store Ingest receipt does not bind the Worker checkpoint');
    const workerTelemetry=(await telemetryForRun(WORKER_SHA,runs.worker))
      .filter(x=>x.run_id===RUNS.worker.id&&
        x.attempt===RUNS.worker.attempt&&
        x.agent?.id==='dev-qwen-01'&&
        x.task?.issue===ISSUE&&x.task?.id===WORKER_ACTION);
    const reviewTelemetry=(await telemetryForRun(FIX_SHA,runs.review))
      .filter(x=>x.run_id===RUNS.review.id&&
        x.attempt===RUNS.review.attempt&&
        x.agent?.id==='review-qwen-01'&&
        x.task?.issue===ISSUE&&x.task?.action_id===REVIEW_ACTION);
    if(workerTelemetry.length!==1||reviewTelemetry.length!==1)
      fail('missing canonical Worker/Reviewer telemetry record');
    return Object.freeze({
      schema_version:1,kind:'authenticated_qwen_chain_fixture',
      repository:REPO,issue:ISSUE,target_sha:targetSha,
      verdict:'Verified',establishes_sc_verdict:false,
      scope:'one controlled real Qwen Developer -> Store -> Publisher -> Reviewer fixture; not a staging or production deployment proof',
      initialization:{state_version:one.version,state_path:state1Path,
        state_sha256:state1Sha256,state_immutable:true,
        state_commit_sha:state1Commit,action_id:one.action_id,
        action_sha:one.action_sha,action_status:one.action_status,
        assignments:one.assignments,
        controller_run:runs.initController,ingest_run:runs.initIngest,
        dispatch_run:runs.initDispatch},
      worker:{run:runs.worker,dispatch_run:runs.workerDispatch,
        source_sha:worker.source_sha,workflow_sha:worker.workflow_sha,
        action_id:WORKER_ACTION,
        checkpoint_version:worker.checkpoint_version,
        checkpoint_path:worker.checkpoint_path,
        checkpoint_commit_sha:checkpointCommit,
        ciphertext_sha256:worker.ciphertext_sha256,
        provider:worker.provider,session_id:worker.session_id,
        telemetry:{run_id:workerTelemetry[0].run_id,
          attempt:workerTelemetry[0].attempt,
          agent_id:workerTelemetry[0].agent.id,
          task_id:workerTelemetry[0].task.id,
          result_status:workerTelemetry[0].result?.status,
          tools:workerTelemetry[0].execution?.tools??null}},
      store_ingest:{run:runs.developmentIngest,
        receipt_status:ingestReceipt.status,
        receipt_artifact_id:ingestReceiptArtifact[0].id,
        checkpoint_commit_sha:ingestReceipt.checkpoint_commit_sha,
        ciphertext_sha256:ingestReceipt.ciphertext_sha256},
      publisher:{run:runs.publisher,intent_path:intent.path,
        action_id:intent.action_id,
        worker_source_sha:intent.worker_source_sha,
        source_sha:intent.source_sha,
        target_main_sha:intent.target_main_sha,
        branch:intent.branch,patch_sha256:intent.patch_sha256},
      reviewer:{dispatch_run:runs.reviewDispatch,run:runs.review,
        result_path:reviews[0].rel,result:review,
        agent_result_artifact:{id:review.artifact_id,
          digest:review.artifact_digest,
          json_sha256:review.artifact_json_sha256},
        verdict_artifact:{id:verdictArtifact[0].id,
          digest:verdictArtifact[0].digest,outcome:verdict.outcome},
        telemetry:{run_id:reviewTelemetry[0].run_id,
          attempt:reviewTelemetry[0].attempt,
          agent_id:reviewTelemetry[0].agent.id,
          task_id:reviewTelemetry[0].task.action_id,
          result_status:reviewTelemetry[0].result?.status,
          tools:reviewTelemetry[0].execution?.tools??null}},
      review_ingest_run:runs.reviewIngest,
      store:{version:current.version,phase:current.phase,
        target_sha:current.target_sha,head_path:current.head_path,
        head_sha256:current.head_sha256,
        publisher_transition:current.publisher_transition,
        reviewer_transition:current.reviewer_transition,
        checkpoint_count:checkpoints.length,
        cursor_checkpoint_present:checkpoints.some(x=>x.includes('cursor'))},
      pull_request:pull,
    });
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
export function selfTestQwenChainEvidence(){
  const spec=RUNS.worker;
  const run={id:spec.id,run_attempt:spec.attempt,name:spec.name,path:spec.path,
    event:spec.event,head_sha:spec.head_sha,head_branch:'main',
    status:'completed',conclusion:'success',actor:{login:spec.actor},
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    created_at:'2026-11-07T05:47:54Z',html_url:'https://example.invalid'};
  assert.equal(assertQwenChainRun(run,spec).id,spec.id);
  for(const bad of [
    {...run,head_sha:FIX_SHA},{...run,actor:{login:'attacker'}},
    {...run,name:'Agent / Review'},{...run,event:'workflow_run'},
    {...run,conclusion:'failure'},{...run,run_attempt:2},
  ])assert.throws(()=>assertQwenChainRun(bad,spec),/untrusted/);
  const state1={version:1,phase:'ready',target_sha:null,
    assignments:{developer:'dev-qwen-01',reviewer:'review-qwen-01',
      acceptor:'accept-qwen-01'},transitions:[],
    outbox:[{id:INIT_ACTION,status:'pending',task:{type:'dispatch',
      role:'developer',task:'implement',agent_id:'dev-qwen-01',sha:INIT_SHA}}]};
  assert.equal(assertQwenStateOne(state1).version,1);
  for(const bad of [
    {...state1,version:2},{...state1,phase:'review'},
    {...state1,assignments:{...state1.assignments,developer:'dev-cursor-01'}},
    {...state1,outbox:[{...state1.outbox[0],status:'failed'}]},
    {...state1,outbox:[{...state1.outbox[0],task:{...state1.outbox[0].task,
      sha:FIX_SHA}}]},
  ])assert.throws(()=>assertQwenStateOne(bad),/v1 State/);
  const intent={schema_version:1,
    kind:'trusted_qwen_publisher_write_ahead_intent',repository:REPO,
    issue:ISSUE,action_id:WORKER_ACTION,worker_run_id:RUNS.worker.id,
    worker_run_attempt:1,worker_sha:WORKER_SHA,source_sha:FIX_SHA,
    worker_source_sha:INIT_SHA,checkpoint_version:1,
    checkpoint_commit_sha:'a'.repeat(40),
    checkpoint_ciphertext_sha256:'b'.repeat(64),patch_sha256:'c'.repeat(64),
    file_manifest_sha256:'d'.repeat(64),file_count:1,
    target_main_sha:FIX_SHA,branch:'agent/'+ISSUE+'/qwen-'+WORKER_ACTION.slice(0,16),
    publisher_run_id:RUNS.publisher.id,publication:'not_yet_attested'};
  assert.equal(assertQwenPublisherIntent(intent).action_id,WORKER_ACTION);
  for(const bad of [
    {...intent,source_sha:INIT_SHA},{...intent,worker_source_sha:FIX_SHA},
    {...intent,worker_run_id:RUNS.worker.id+1},
    {...intent,publisher_run_id:RUNS.publisher.id+1},
    {...intent,publication:'attested'},
  ])assert.throws(()=>assertQwenPublisherIntent(bad),/Publisher/);
  const record={schema_version:2,kind:'authenticated_agent_task_result',
    issue:ISSUE,action_id:REVIEW_ACTION,result:{kind:'reviewer',issue:ISSUE,
      run_id:RUNS.review.id,run_attempt:RUNS.review.attempt,
      target_sha:PR_HEAD,outcome:'approved',task_id:REVIEW_ACTION},
    source:{repository:REPO,path:RUNS.review.path,name:RUNS.review.name,
      run_id:RUNS.review.id,attempt:RUNS.review.attempt,
      event:RUNS.review.event,agent_id:'review-qwen-01',
      input_sha:PR_HEAD,output_sha:PR_HEAD,verified:true},
    artifact:{id:42,digest:'sha256:'+'e'.repeat(64),
      json_sha256:'f'.repeat(64),source_run_id:RUNS.review.id,
      source_run_attempt:RUNS.review.attempt},
    implementing_pr:{repository:REPO,number:PR_NUMBER,
      head_sha_at_attestation:PR_HEAD}};
  assert.equal(assertQwenReviewResult(record).outcome,'approved');
  for(const bad of [
    {...record,result:{...record.result,outcome:'changes_requested'}},
    {...record,result:{...record.result,target_sha:FIX_SHA}},
    {...record,source:{...record.source,verified:false}},
    {...record,artifact:{...record.artifact,source_run_id:1}},
    {...record,implementing_pr:{...record.implementing_pr,number:1}},
  ])assert.throws(()=>assertQwenReviewResult(bad),/Reviewer result/);
  const pr={number:PR_NUMBER,state:'closed',merged:true,
    merged_at:'2026-11-07T08:35:24Z',merge_commit_sha:PR_MERGE,
    merged_by:{login:'BestNathan'},
    base:{ref:'main',repo:{full_name:REPO}},
    head:{sha:PR_HEAD,repo:{full_name:REPO}}};
  const files=[{filename:SOURCE_FILE,status:'modified',additions:1,
    deletions:1,patch:'@@\n-implementation: pending\n+implementation: qwen-verified\n'}];
  const branchPulls=[{number:PR_NUMBER}];
  assert.equal(assertQwenPublishedPullRequest(pr,files,branchPulls).number,PR_NUMBER);
  for(const bad of [
    [pr,[],branchPulls],[pr,[{...files[0],filename:'other.md'}],branchPulls],
    [{...pr,merge_commit_sha:FIX_SHA},files,branchPulls],
    [{...pr,head:{...pr.head,sha:FIX_SHA}},files,branchPulls],
    [pr,[{...files[0],patch:'+implementation: pending\n'}],branchPulls],
    [pr,files,[{number:PR_NUMBER},{number:PR_NUMBER+1}]],
    [{...pr,merged_by:{login:'github-actions[bot]'}},files,branchPulls],
  ])assert.throws(()=>assertQwenPublishedPullRequest(...bad),/published/);
  return true;
}

if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(
  new URL(import.meta.url).pathname)){
  selfTestQwenChainEvidence();
  console.log('Qwen chain acceptance evidence: exact Run/State/Intent/Review/PR positives and negative fixtures pass');
}
