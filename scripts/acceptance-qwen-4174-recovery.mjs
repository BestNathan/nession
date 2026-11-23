#!/usr/bin/env node
// #4174: read-only exact Run/Artifact/Store-CAS attestation for the already
// completed Qwen tracked-source failure and its distinct signed successor.
// This is historical evidence for the independent SC Agent, never a Pass
// projector, a replay command, or authority to alter the original Issue.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const REPO='BestNathan/nession',ISSUE=4174,ROOT=4065;
const SHA=/^[0-9a-f]{40}$/,SHA256=/^sha256:[0-9a-f]{64}$/;
const TARGET_BASE='2f3c247c5b9695daa0b5cfed17af2309f686df3e';
const SOURCE='8b7777f48a577d01961fd7d9e75311f75d6d57a1';
const PUB_SHA='f79547b0def78418e109aba82673d7f20edbc341';
const PR=4191;
const FAIL_ACTION='f085d5919b3277e4fb68d49f48f9a311a83ad5032a90ec651aba93392888eb44';
const NEXT_ACTION='74024299b457f8c0049c191e9750d61bce424608086f169e771486e65fc245ae';
const REVIEW_ACTION='b95eb42b102c484a9c4613e38a896e456d08c806b09e678f714a1a0f4d2b69ee';
const INITIAL_REVIEW_ACTION='73e869fffc416a387c9058da0fcfa8804d339341e1f1daf89a9111fc57f63127';
const WORKFLOWS=Object.freeze({
  fail:[44733719096,'Agent / Development','agent-develop.yml','8b7777f48a577d01961fd7d9e75311f75d6d57a1','failure'],
  worker:[44742578069,'Agent / Development','agent-develop.yml',TARGET_BASE,'success'],
  publisher:[44744656206,'Store / Qwen Publisher','store-qwen-publisher.yml','a1e9ae535f5581cfbfeaee6b0ce35a07aab40b3e','success'],
  reviewer:[44773349621,'Agent / Review','agent-review.yml','d81b5b0af5b18b3ded368f04b12da9ad8c657f9f','success'],
});
const ARTIFACTS=Object.freeze({
  fail:[['development-worker-claim-44733719096-1','sha256:20a4679663ea9afc518a1713c3497e5f1c7bc0a0675a39540ed55955681e605f']],
  worker:[
    ['development-worker-claim-44742578069-1','sha256:a3d52b742da41bf061715124e0d4ec56a67ef6b4930e2232e7005a7fc324c941'],
    ['development-worker-44742578069-1','sha256:543fdc5c5336a79539468d0949aa17144dc35761bdfbab72baf8396acf0d8d04']
  ],
  reviewer:[
    ['review-claim-44773349621-1','sha256:c09dd8cb2a7b964acba016e537e1af6ba913874702d79968418ae702635d5cbc'],
    ['agent-result-44773349621-1-'+REVIEW_ACTION,'sha256:bcb5994925b80661f4af3aaeed7558d109289c5428d6d7c8e5da2415e1de11c6'],
  ],
});
const HASH=s=>createHash('sha256').update(s).digest('hex');
function deny(message){throw Error('authenticated #4174 Qwen recovery: '+message);}
function requireIt(value,message){if(!value)deny(message);}
function action(state,id){return state?.outbox?.find(x=>x.id===id);}
function validRun(run,key){
  const [id,name,file,sha,conclusion]=WORKFLOWS[key];
  requireIt(run?.id===id&&run.name===name&&
    run.path==='.github/workflows/'+file&&run.head_sha===sha&&
    run.run_attempt===1&&run.event==='workflow_dispatch'&&
    run.head_branch==='main'&&run.actor?.login==='github-actions[bot]'&&
    run.repository?.full_name===REPO&&run.head_repository?.full_name===REPO&&
    run.status==='completed'&&run.conclusion===conclusion,
    'invalid signed '+key+' Run/Attempt/Actor/SHA');
}
function artifactSet(list,key){
  const runId=WORKFLOWS[key][0],sha=WORKFLOWS[key][3];
  requireIt(Array.isArray(list?.artifacts)&&list.artifacts.length<25,
    'missing/broad '+key+' Artifact inventory');
  const found=[];
  for(const [name,digest] of ARTIFACTS[key]){
    const matching=list.artifacts.filter(a=>a?.name===name);
    const a=matching[0];
    requireIt(matching.length===1&&a.expired===false&&
      Number.isSafeInteger(a.id)&&a.id>0&&a.size_in_bytes>0&&
      a.digest===digest&&SHA256.test(a.digest)&&
      a.workflow_run?.id===runId&&a.workflow_run?.head_sha===sha,
      'missing/expired/forged '+key+' Artifact '+name);
    found.push({id:a.id,name,digest});
  }
  return found;
}
export function attestQwen4174({targetSha,head,states,runs,artifacts,
  receipt,pr,sourceCommit,mainAncestry,prAncestry}){
  requireIt(SHA.test(targetSha??'')&&
    ['identical','ahead'].includes(mainAncestry?.status)&&
    mainAncestry?.merge_base_commit?.sha===TARGET_BASE&&
    mainAncestry.behind_by===0&&
    ['identical','ahead'].includes(prAncestry?.status)&&
    prAncestry?.merge_base_commit?.sha===PUB_SHA&&prAncestry.behind_by===0,
    'target main / original published PR ancestry not proven');
  requireIt(Number.isSafeInteger(head?.version)&&head.version>=37&&
    head.path==='workflows/issues/4065/states/'+
      String(head.version).padStart(8,'0')+'.json'&&
    /^[0-9a-f]{64}$/.test(head.sha256??''),
    'canonical source Store head unavailable');
  for(const n of [6,7,12,13,37]){
    const s=states?.[n];
    requireIt(s?.issue===ROOT&&s.version===n&&s.schema_version===1&&
      Array.isArray(s.outbox)&&Array.isArray(s.transitions)&&
      s.assignments?.developer==='dev-qwen-01'&&
      s.assignments?.reviewer==='review-qwen-01',
      'missing/authenticity failure in Store v'+n);
  }
  const v6=states[6],v7=states[7],v12=states[12],v13=states[13],v37=states[37];
  const failed=action(v6,FAIL_ACTION),successor=action(v6,NEXT_ACTION);
  requireIt(v6.phase==='ready'&&v6.target_sha===null&&v6.outbox.length===2&&
    failed?.status==='failed'&&
    failed.task?.role==='developer'&&failed.task.task==='implement'&&
    failed.task.agent_id==='dev-qwen-01'&&failed.task.sha===SOURCE&&
    failed.receipt?.failure_code==='qwen_tracked_source_gate_rejected'&&
    failed.receipt?.source_run_id===WORKFLOWS.fail[0]&&
    failed.receipt.source_attempt===1&&
    successor?.id!==failed.id&&successor?.status==='dispatched'&&
    successor.task?.role==='developer'&&successor.task.task==='implement'&&
    successor.task.agent_id==='dev-qwen-01'&&successor.task.sha===SOURCE&&
    successor.receipt?.status==='verified'&&
    successor.receipt.source_run_id===WORKFLOWS.worker[0]&&
    successor.receipt.dispatch_id===NEXT_ACTION,
    'original failure was not CAS-retired with one distinct verified successor');
  const pub=v7.transitions.filter(t=>t.kind==='publisher');
  requireIt(v7.phase==='review'&&v7.target_sha===PUB_SHA&&
    pub.length===1&&pub[0].run_id===WORKFLOWS.publisher[0]&&
    pub[0].attempt===1&&pub[0].outcome==='published'&&
    pub[0].target_sha===PUB_SHA&&
    action(v7,FAIL_ACTION)?.status==='failed'&&
    action(v7,INITIAL_REVIEW_ACTION)?.status==='pending',
    'trusted Publisher did not publish original PR from successor');
  requireIt(v12.phase==='review'&&v12.target_sha===PUB_SHA&&
    action(v12,REVIEW_ACTION)?.status==='dispatched'&&
    action(v12,REVIEW_ACTION).receipt?.status==='verified'&&
    action(v12,REVIEW_ACTION).receipt?.source_run_id===WORKFLOWS.reviewer[0],
    'original Reviewer was not a uniquely verified independent dispatch');
  const review=v13.transitions.filter(t=>t.kind==='reviewer');
  requireIt(v13.phase==='repair'&&v13.target_sha===PUB_SHA&&
    review.length===1&&review[0].run_id===WORKFLOWS.reviewer[0]&&
    review[0].attempt===1&&review[0].target_sha===PUB_SHA&&
    review[0].outcome==='changes_requested'&&
    v37.transitions.some(t=>t.kind==='publisher'&&t.run_id===WORKFLOWS.publisher[0]&&
      t.target_sha===PUB_SHA)&&
    v37.transitions.some(t=>t.kind==='reviewer'&&t.run_id===WORKFLOWS.reviewer[0]&&
      t.target_sha===PUB_SHA&&t.outcome==='changes_requested'),
    'independent Reviewer / Store-CAS outcome missing or mutated');
  requireIt(receipt?.schema_version===1&&receipt.kind==='agent_checkpoint_run'&&
    receipt.role==='developer'&&receipt.agent_id==='dev-qwen-01'&&
    receipt.issue===ROOT&&receipt.run_id===WORKFLOWS.worker[0]&&
    receipt.attempt===1&&receipt.source_sha===SOURCE&&
    receipt.workflow_sha===TARGET_BASE&&receipt.version===1&&
    receipt.checkpoint_path===
      'roles/developer/dev-qwen-01/issues/4065/checkpoints/00000001.json'&&
    /^[0-9a-f]{64}$/.test(receipt.ciphertext_sha256??'')&&
    receipt.workflow==='.github/workflows/agent-develop.yml',
    'successor has no immutable native checkpoint receipt');
  requireIt(pr?.number===PR&&pr.head?.repo?.full_name===REPO&&
    pr.base?.repo?.full_name===REPO&&pr.base.ref==='main'&&
    pr.head.ref==='agent/4065/qwen-74024299b457f8c0'&&
    pr.changed_files===1&&SHA.test(pr.head.sha??'')&&
    sourceCommit?.sha===PUB_SHA&&sourceCommit?.parents?.length===1&&
    sourceCommit.parents[0]?.sha===WORKFLOWS.publisher[3]&&
    sourceCommit?.files?.length===1&&
    sourceCommit.files[0].filename==='crates/nession-server/src/server/websocket.rs'&&
    sourceCommit.files[0].status==='modified',
    'Publisher PR / original Git commit ownership or patch scope changed');
  for(const key of Object.keys(WORKFLOWS))validRun(runs?.[key],key);
  const verifiedArtifacts={
    fail:artifactSet(artifacts.fail,'fail'),
    worker:artifactSet(artifacts.worker,'worker'),
    reviewer:artifactSet(artifacts.reviewer,'reviewer'),
  };
  return Object.freeze({
    schema_version:1,kind:'verified_qwen_4174_failure_successor_publisher_reviewer',
    verified:true,subject_issue:ISSUE,source_issue:ROOT,target_sha:targetSha,
    original_failed_run:WORKFLOWS.fail[0],
    failed_action:FAIL_ACTION,failed_source_sha:SOURCE,
    failed_source_failure_code:'qwen_tracked_source_gate_rejected',
    distinct_signed_successor_action:NEXT_ACTION,
    successor_worker_run:WORKFLOWS.worker[0],successor_attempt:1,
    original_authenticated_publisher_run:WORKFLOWS.publisher[0],
    original_published_pr:PR,original_published_sha:PUB_SHA,
    authenticated_reviewer_run:WORKFLOWS.reviewer[0],
    authenticated_reviewer_outcome:'changes_requested',
    reviewer_exact_sha:PUB_SHA,
    immutable_store_source_versions:[6,7,12,13,37],
    verified_original_artifacts:verifiedArtifacts,
    source_main_ancestor:true,published_pr_ancestry_verified:true,
    evidence_scope:'SC-02: real original final-source failure + unique CAS successor; SC-03: real bounded tracked-only Developer→checkpoint→Publisher→independently ingested Reviewer at one exact PR HEAD',
    limitation:'No issue-level automatic Pass, Reviewer approval, Rust Quality, deployment or #4012/#3784 historical evidence inferred',
  });
}
function decodeStore(json,sourcePath) {
  requireIt(json?.type==='file'&&json.path===sourcePath&&
    json.encoding==='base64'&&SHA.test(json.sha??'')&&
    Number.isSafeInteger(json.size)&&json.size>0&&json.size<=256*1024&&
    typeof json.content==='string','untrusted Store Contents object '+sourcePath);
  const encoded=json.content.replace(/\s/g,'');
  const data=Buffer.from(encoded,'base64');
  const sha=createHash('sha1').update(Buffer.from('blob '+data.length+'\0'))
    .update(data).digest('hex');
  requireIt(data.length===json.size&&sha===json.sha&&
    data.toString('base64')===encoded,'immutable Store Git blob bytes mismatch');
  return {value:JSON.parse(data.toString('utf8')),digest:HASH(data)};
}
export async function collectQwen4174({repo=REPO,stage,issue,targetSha,get}={}){
  if(stage!=='post-merge'||issue!==ISSUE)return null;
  requireIt(repo===REPO&&SHA.test(targetSha??'')&&typeof get==='function',
    'wrong repository or main-stage authority');
  const root='/repos/'+REPO,store=p=>root+'/contents/'+p+'?ref=agent-store';
  const statePath=n=>'workflows/issues/4065/states/'+
    String(n).padStart(8,'0')+'.json';
  const [head,...states]=await Promise.all([
    get(store('workflows/issues/4065/head.json'))
      .then(x=>decodeStore(x,'workflows/issues/4065/head.json').value),
    ...[6,7,12,13,37].map(n=>get(store(statePath(n)))
      .then(x=>decodeStore(x,statePath(n)).value)),
  ]);
  // Source HEAD is independently checked against the exact corresponding
  // current file bytes, not merely trusted because a mutable pointer names it.
  const last=await get(store(head.path)).then(x=>decodeStore(x,head.path));
  requireIt(last.digest===head.sha256&&last.value?.version===head.version,
    'canonical latest Store state does not match head digest');
  const specs=Object.entries(WORKFLOWS),artifactKeys=Object.keys(ARTIFACTS);
  const [runEntries,artEntries,receipt,pr,sourceCommit,mainAncestry,prAncestry]=
    await Promise.all([
      Promise.all(specs.map(async([key,s])=>[key,await get(root+'/actions/runs/'+s[0])])),
      Promise.all(artifactKeys.map(async key=>[
        key,await get(root+'/actions/runs/'+WORKFLOWS[key][0]+'/artifacts?per_page=100')
      ])),
      get(store('roles/developer/dev-qwen-01/issues/4065/runs/44742578069-1.json'))
        .then(x=>decodeStore(x,'roles/developer/dev-qwen-01/issues/4065/runs/44742578069-1.json').value),
      get(root+'/pulls/4191'),
      get(root+'/commits/'+PUB_SHA),
      get(root+'/compare/'+TARGET_BASE+'...'+targetSha),
      get(root+'/compare/'+PUB_SHA+'...'+(await get(root+'/pulls/4191')).head.sha),
    ]);
  return attestQwen4174({
    targetSha,head,states:Object.fromEntries([6,7,12,13,37].map((n,i)=>[n,states[i]])),
    runs:Object.fromEntries(runEntries),artifacts:Object.fromEntries(artEntries),
    receipt,pr,sourceCommit,mainAncestry,prAncestry,
  });
}
export function selfTestQwen4174(){
  assert.equal(ARTIFACTS.worker.length,2);
  assert.equal(ARTIFACTS.reviewer.length,2);
  assert.notEqual(FAIL_ACTION,NEXT_ACTION);
  assert.equal(WORKFLOWS.fail[4],'failure');
  assert.equal(WORKFLOWS.worker[4],'success');
  assert.equal(WORKFLOWS.publisher[4],'success');
  assert.equal(WORKFLOWS.reviewer[4],'success');
  const fixtures={id:44742578069,name:'Agent / Development',
    path:'.github/workflows/agent-develop.yml',head_sha:TARGET_BASE,
    run_attempt:1,event:'workflow_dispatch',head_branch:'main',
    actor:{login:'github-actions[bot]'},repository:{full_name:REPO},
    head_repository:{full_name:REPO},status:'completed',conclusion:'success'};
  assert.doesNotThrow(()=>validRun(fixtures,'worker'));
  for(const bad of [
    {id:44742578070},{run_attempt:2},{event:'push'},
    {actor:{login:'external'}},{head_sha:'f'.repeat(40)},
    {head_branch:'staging'},{conclusion:'failure'},
  ])assert.throws(()=>validRun({...fixtures,...bad},'worker'),/invalid signed/);
  const source={artifacts:[{name:ARTIFACTS.worker[0][0],
    digest:ARTIFACTS.worker[0][1],id:1,expired:false,size_in_bytes:1,
    workflow_run:{id:WORKFLOWS.worker[0],head_sha:TARGET_BASE}},
    {name:ARTIFACTS.worker[1][0],digest:ARTIFACTS.worker[1][1],
      id:2,expired:false,size_in_bytes:1,
      workflow_run:{id:WORKFLOWS.worker[0],head_sha:TARGET_BASE}}]};
  assert.equal(artifactSet(source,'worker').length,2);
  for(const changed of [
    {expired:true},{digest:'sha256:'+'0'.repeat(64)},
    {workflow_run:{id:1,head_sha:TARGET_BASE}},
  ])assert.throws(()=>artifactSet({artifacts:[
    {...source.artifacts[0],...changed},source.artifacts[1]]},'worker'),
    /missing\/expired\/forged/);
  console.log('#4174 source recovery: exact Run, Actor, Attempt, SHA, Artifact and replay-denial fixtures passed');
}
if(process.argv[2]==='self-test')selfTestQwen4174();
