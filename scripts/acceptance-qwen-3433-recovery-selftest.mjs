#!/usr/bin/env node
// #3655: synthetic positive and forged-source negative fixtures. No network or verdict writes.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {attestQwen3433Recovery,collectQwen3433Recovery,
  QWEN_3433_RUN_SPECS as R,decodeQwen3433StoreContent}
  from './acceptance-qwen-3433-recovery.mjs';

const A='a9b3f9e1d78ef5c9ae0f97136d753da0ca6fc9ba';
const B='1159e58c19b927b4e53d4fe594174a50b6bbf092';
const F='d6f6e70958336f8f4b80433be510bf54a1f55c08';
const repo={full_name:'BestNathan/nession'};
const oldId='6'.repeat(64),replacementId='c'.repeat(64),
  repairId='d'.repeat(64),malformedId='8'.repeat(64),recoveredId='f'.repeat(64);
const task=(role,type,sha)=>({type:'dispatch',role,task:type,sha,
  agent_id:role==='reviewer'?'review-qwen-01':'dev-qwen-01'});
const reviewerA=task('reviewer','review',A);
const reviewerB=task('reviewer','review',B);
const repairTask=task('developer','repair',A);
const action=(id,t,status,sourceRun,code)=>({id,task:t,status,
  attempts:status==='pending'?0:1,receipt:sourceRun==null?null:{
    status:status==='failed'?'failed':'verified',dispatch_id:id,
    source_run_id:sourceRun,...(code?{failure_code:code,source_attempt:1}:{})
  }});
const original=action(oldId,reviewerA,'dispatched',R.firstReview[0]);
const retired=action(oldId,reviewerA,'failed',R.firstReview[0],
  'qwen_reviewer_publisher_trigger_pre_model_failure');
const later=action(malformedId,reviewerB,'failed',R.malformedReview[0],
  'qwen_reviewer_invalid_json_after_model');
const pubA={kind:'publisher',run_id:R.initialPublisher[0],
  target_sha:A,outcome:'published'};
const reviewA={kind:'reviewer',run_id:R.recoveredReview[0],
  target_sha:A,outcome:'changes_requested'};
const pubB={kind:'publisher',run_id:R.repairPublisher[0],
  target_sha:B,outcome:'published'};
const reviewB={kind:'reviewer',run_id:R.finalReview[0],
  target_sha:B,outcome:'approved'};
function state(version,phase,sha,transitions,outbox){
  return {schema_version:1,issue:3433,version,phase,target_sha:sha,
    repair_attempts:1,assignments:{developer:'dev-qwen-01',
      reviewer:'review-qwen-01',acceptor:'accept-qwen-01'},
    transitions,outbox};
}
const states={
  6:state(6,'review',A,[pubA],[original]),
  7:state(7,'review',A,[pubA],[retired,
    action(replacementId,reviewerA,'pending')]),
  9:state(9,'review',A,[pubA],[retired,
    action(replacementId,reviewerA,'dispatched',R.recoveredReview[0])]),
  10:state(10,'repair',A,[pubA,reviewA],[retired,
    action(repairId,repairTask,'pending')]),
  13:state(13,'repair',A,[pubA,reviewA],[retired,
    action(repairId,repairTask,'dispatched',R.repairWorker[0])]),
  14:state(14,'review',B,[pubA,reviewA,pubB],[retired,
    action(malformedId,reviewerB,'pending')]),
  16:state(16,'review',B,[pubA,reviewA,pubB],[retired,
    action(malformedId,reviewerB,'dispatched',R.malformedReview[0])]),
  17:state(17,'review',B,[pubA,reviewA,pubB],[retired,later,
    action(recoveredId,reviewerB,'pending')]),
  19:state(19,'review',B,[pubA,reviewA,pubB],[retired,later,
    action(recoveredId,reviewerB,'dispatched',R.finalReview[0])]),
  20:state(20,'quality',B,[pubA,reviewA,pubB,reviewB],[retired,later,
    {id:'5'.repeat(64),task:{type:'verify',gate:'quality',sha:B,agent_id:null},
      status:'pending',attempts:0,receipt:null}]),
};
const runs=Object.fromEntries(Object.entries(R).map(([key,s])=>[
  key,{id:s[0],name:s[1],path:'.github/workflows/'+s[2],
    event:s[3],actor:{login:s[4]},head_sha:s[5],head_branch:'main',
    status:'completed',conclusion:s[6],run_attempt:1,
    repository:repo,head_repository:repo}
]));
const artifact=(name,id,run)=>({name,id,size_in_bytes:1024,expired:false,
  digest:'sha256:'+'a'.repeat(64),workflow_run:{
    id:run,head_sha:R[run===R.finalReview[0]?'finalReview':'malformedReview'][5]
  }});
const failedArtifacts={total_count:2,artifacts:[
  artifact('review-admission-43681851455-1',11,R.malformedReview[0]),
  artifact('review-claim-43681851455-1',12,R.malformedReview[0])
]};
const finalArtifacts={total_count:5,artifacts:[
  artifact('review-admission-43711883444-1',21,R.finalReview[0]),
  artifact('review-claim-43711883444-1',22,R.finalReview[0]),
  artifact('reviewer-slice-43711883444-1',23,R.finalReview[0]),
  artifact('agent-telemetry-reviewer-slice-43711883444-1',24,R.finalReview[0]),
  artifact('agent-result-43711883444-1-'+recoveredId,25,R.finalReview[0])
]};
function jobsFor(key,names){
  const jobs=Object.entries(names).map(([name,conclusion])=>({
    run_id:R[key][0],name,status:'completed',conclusion
  }));
  return {total_count:jobs.length,jobs};
}
const jobs={
  firstReview:jobsFor('firstReview',{
    prepare:'failure',review:'skipped','notify-metrics':'skipped'}),
  repairWorker:jobsFor('repairWorker',{
    claim:'success','qwen-developer':'success'}),
  finalReview:jobsFor('finalReview',{
    prepare:'success',review:'success','notify-metrics':'success'})
};
const fixture={issue:3578,stage:'post-merge',
  targetSha:'27c0b832f5202db8c6a8f86fa279c3c1a877c0e6',
  states,head:{version:20,
    path:'workflows/issues/3433/states/00000020.json',
    sha256:'a'.repeat(64)},
  runs,failedArtifacts,finalArtifacts,jobs,
  pr:{number:3530,state:'open',head:{repo,sha:B},changed_files:1},
  sourceAncestry:{status:'identical',behind_by:0},
  targetAncestry:{status:'ahead',behind_by:0}};
const proof=attestQwen3433Recovery(fixture);
assert.equal(proof.verified,true);
assert.equal(proof.original_published_pr_sha,B);
assert.equal(proof.protected_state_chain.at(-1).approved_reviewer_run,R.finalReview[0]);
assert.equal(proof.quality_outcome,'unverified');
// Historical source PR is now merged, but the original Reviewed head remains
// an ancestor: a closed merged PR does not invalidate its signed evidence.
const merged=structuredClone(fixture);
merged.pr.state='closed';
merged.pr.merged_at='2026-11-15T13:00:00Z';
assert.equal(attestQwen3433Recovery(merged).verified,true);
function reject(mutator){
  const value=structuredClone(fixture);
  mutator(value);
  assert.throws(()=>attestQwen3433Recovery(value),
    /trusted #3433 Qwen recovery evidence/);
}
reject(x=>x.issue=3434);
reject(x=>x.stage='deployed');
reject(x=>x.targetSha='not-a-sha');
reject(x=>x.sourceAncestry.behind_by=1);
reject(x=>x.targetAncestry.status='diverged');
reject(x=>x.pr.changed_files=2);
reject(x=>x.pr.head.repo.full_name='other/repo');
reject(x=>x.head.path='../unsafe');
reject(x=>x.states[7].issue=1);
reject(x=>x.states[7].outbox[0].receipt.failure_code='forged');
reject(x=>x.states[7].outbox[1].task.sha=B);
reject(x=>x.states[9].outbox[1].receipt.source_run_id=1);
reject(x=>x.states[10].phase='quality');
reject(x=>x.states[10].transitions[1].outcome='approved');
reject(x=>x.states[13].outbox[1].status='pending');
reject(x=>x.states[14].transitions[2].target_sha=A);
reject(x=>x.states[14].outbox.unshift(
  action('1'.repeat(64),reviewerB,'pending')));
reject(x=>x.states[14].outbox[0].status='pending');
reject(x=>x.states[16].outbox[1].receipt.source_run_id=4);
reject(x=>x.states[17].outbox[1].receipt.failure_code='other');
reject(x=>x.states[19].outbox[2].receipt.source_run_id=2);
reject(x=>x.states[20].transitions[3].outcome='changes_requested');
reject(x=>x.states[20].outbox.pop());
reject(x=>x.runs.finalReview.actor.login='external');
reject(x=>x.runs.repairWorker.run_attempt=2);
reject(x=>x.runs.firstReview.head_sha=B);
reject(x=>x.runs.finalIngest.conclusion='failure');
reject(x=>x.jobs.firstReview.jobs[1].conclusion='success');
reject(x=>x.jobs.repairWorker.jobs[1].run_id=7);
reject(x=>x.jobs.finalReview.jobs[1].conclusion='failure');
reject(x=>x.failedArtifacts.artifacts.push(
  artifact('reviewer-slice-43681851455-1',13,R.malformedReview[0])));
reject(x=>x.finalArtifacts.artifacts.pop());
reject(x=>x.finalArtifacts.artifacts[2].digest='forged');
reject(x=>x.finalArtifacts.artifacts[4].name='agent-result-forged');
function githubContent(file,obj){
  const data=Buffer.from(JSON.stringify(obj)+'\n');
  const sha=createHash('sha1').update(Buffer.from('blob '+data.length+'\0'))
    .update(data).digest('hex');
  return {type:'file',path:file,encoding:'base64',size:data.length,sha,
    content:data.toString('base64')};
}
const path='workflows/issues/3433/head.json';
const content=githubContent(path,fixture.head);
assert.deepEqual(decodeQwen3433StoreContent(content,path).value,fixture.head);
assert.throws(()=>decodeQwen3433StoreContent({...content,sha:'b'.repeat(40)},path),
  /Store Git blob hash mismatch/);
assert.throws(()=>decodeQwen3433StoreContent(content,'other.json'),
  /invalid signed Store/);
assert.equal(await collectQwen3433Recovery({
  repo:'BestNathan/nession',issue:1,stage:'post-merge',
  targetSha:F,get:()=>{throw Error('unexpected GitHub call');}
}),null);
console.log('Qwen #3433 exact cross-Run/Store/PR provenance: positive, spoof/extra Artifact/CAS and negative fixtures pass');
