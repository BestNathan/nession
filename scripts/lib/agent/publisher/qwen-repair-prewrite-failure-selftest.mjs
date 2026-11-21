#!/usr/bin/env node
// #4046: independent historical Github Run/Job/log attestation must never
// trust a model claim, generic Owner comment, or missing result artifact.
import assert from 'node:assert/strict';
import {SOURCE as f,verifyQwenRepairPrewriteFailure,
  SECOND_SOURCE as g,verifySecondQwenRepairPrewriteFailure}
  from './qwen-repair-prewrite-failure.mjs';
import {qwenRepairPrewriteRecoveryPath,qwenRepairSecondPrewriteRecoveryPath}
  from './qwen-repair-intent.mjs';
import {isValidQwenPrewriteRecoveryGrant,
  attestQwenRepairPriorGitHistory} from './qwen-repair-github.mjs';
import {createHash} from 'node:crypto';

const repo={full_name:'BestNathan/nession'};
const run={id:f.run_id,run_attempt:1,status:'completed',
  conclusion:'failure',name:'Store / Qwen Publisher',
  path:'.github/workflows/store-qwen-publisher.yml',
  event:'workflow_dispatch',head_branch:'main',head_sha:f.head_sha,
  actor:{login:'github-actions[bot]'},repository:repo,head_repository:repo};
const step=(name,conclusion)=>({name,conclusion});
const job=(name,id,conclusion,steps=[])=>({
  name,id,status:'completed',conclusion,run_id:f.run_id,
  run_attempt:1,steps});
const jobs={total_count:4,jobs:[
  job('detect',135397610503,'success'),
  job('reconcile-original',135397613085,'skipped'),
  job('publish',135397672702,'failure',[
    step('Validate signed Qwen/Store/Publisher negative contracts before secrets','success'),
    step('Fetch exact trusted Ingest receipt and original Worker ZIPs','success'),
    step('Checkout inert publication source strictly as Git data','success'),
    step('Mint repository-scoped Store Writer App token outside model jobs','success'),
    step('Mint separate Publisher GitHub App token','success'),
    step('Authenticate original Qwen and publish/reconcile one real PR','failure'),
    step('Publish bounded Developer v2 producer and Store writer receipt','skipped'),
  ]),
  job('wake-reviewer',135397974161,'skipped'),
]};
const artifacts={total_count:0,artifacts:[]};
const log='Qwen Repair PR update: original Qwen PR-A commit parent or tree was rewritten\n'+
  '##[error]Process completed with exit code 1.\n';
const proof=verifyQwenRepairPrewriteFailure(run,jobs,artifacts,log);
assert.equal(proof.verified,true);
assert.equal(proof.issue,3784);
assert.equal(proof.run_id,44476308903);
assert.equal(proof.worker_run_id,44475622445);
assert.equal(proof.source_ingest_run_id,44476225367);
assert.equal(proof.source_sha,f.source_sha);
assert.match(qwenRepairPrewriteRecoveryPath(),
  /^workflows\/issues\/3784\/results\/44476308903-1-[a-f0-9]{64}\.json$/);
assert.equal(qwenRepairPrewriteRecoveryPath(),
  qwenRepairPrewriteRecoveryPath(),'one deterministic recovery path');
for(const wrong of [
  {run:{...run,run_attempt:2}},
  {run:{...run,head_sha:f.source_sha}},
  {run:{...run,actor:{login:'BestNathan'}}},
  {run:{...run,conclusion:'success'}},
  {run:{...run,path:'.github/workflows/evil.yml'}},
  {run:{...run,head_repository:{full_name:'evil/repo'}}},
  {jobs:{...jobs,total_count:5}},
  {jobs:{...jobs,jobs:jobs.jobs.map(x=>x.name==='publish'
    ?{...x,conclusion:'success'}:x)}},
  {jobs:{...jobs,jobs:jobs.jobs.map(x=>x.name==='publish'
    ?{...x,id:1}:x)}},
  {jobs:{...jobs,jobs:jobs.jobs.map(x=>x.name==='publish'
    ?{...x,steps:x.steps.map(s=>s.name.startsWith('Authenticate original')
      ?{...s,conclusion:'success'}:s)}:x)}},
  {jobs:{...jobs,jobs:jobs.jobs.map(x=>x.name==='publish'
    ?{...x,steps:x.steps.filter(s=>!s.name.startsWith('Fetch exact'))}:x)}},
  {artifacts:{total_count:1,artifacts:[{name:'unexpected'}]}},
  {log:'Qwen Repair PR update: another unexpected failure'},
  {log:'Process completed with exit code 1.'},
]){
  assert.throws(()=>verifyQwenRepairPrewriteFailure(
    wrong.run??run,wrong.jobs??jobs,
    wrong.artifacts??artifacts,wrong.log??log),
    /trusted Qwen pre-write Publisher failure/);
}
// Validate the SECOND one-shot Store marker independently of the old WAL.
// A forged intent shape or arbitrary Issue/Run/branch never grants a write.
const original={issue:f.issue,action_id:f.action_id,
  worker_run_id:f.worker_run_id,source_sha:f.source_sha,
  checkpoint_version:f.checkpoint_version,publisher_run_id:f.run_id};
const marker='e'.repeat(40),originalWal='a'.repeat(40);
const grant={status:'prewrite_recovery',may_publish:true,
  store_commit_sha:marker,recovery:{verified:true,
    failed_run_id:f.run_id,run_id:f.run_id+100,
    wal_commit_sha:originalWal,
    marker_path:qwenRepairPrewriteRecoveryPath(),
    marker_store_commit_sha:marker},record:original};
assert.equal(isValidQwenPrewriteRecoveryGrant(grant,original),true);
for(const wrong of [
  {intent:{...grant,status:'reconcile'}},
  {intent:{...grant,may_publish:false}},
  {intent:{...grant,store_commit_sha:'bad'}},
  {intent:{...grant,recovery:{...grant.recovery,verified:false}}},
  {intent:{...grant,recovery:{...grant.recovery,failed_run_id:f.run_id+1}}},
  {intent:{...grant,recovery:{...grant.recovery,run_id:f.run_id}}},
  {intent:{...grant,recovery:{...grant.recovery,wal_commit_sha:'bad'}}},
  {intent:{...grant,recovery:{...grant.recovery,marker_store_commit_sha:originalWal}}},
  {intent:{...grant,recovery:{...grant.recovery,marker_path:'workflows/issues/3784/results/evil.json'}}},
  {record:{...original,issue:4046}},
  {record:{...original,worker_run_id:0}},
  {record:{...original,source_sha:'0'.repeat(40)}},
  {record:{...original,checkpoint_version:2}},
  {record:{...original,publisher_run_id:f.run_id+1}},
]){
  assert.equal(isValidQwenPrewriteRecoveryGrant(
    wrong.intent??grant,wrong.record??original),false);
}

// The SECOND actual Owner/main attempt 44495243036 consumed the first CAS
// marker, but the local read-only plan refused to materialize its patch.
const secondRun={...run,id:g.run_id,event:'issue_comment',head_sha:g.head_sha,
  actor:{login:'BestNathan'}};
const secondJobs={total_count:4,jobs:jobs.jobs.map(j=>({
  ...j,run_id:g.run_id,id:j.name==='publish'?g.publish_job_id:j.id,
}))};
const secondLog='Qwen Repair PR update: missing exact immutable Store-fenced Repair grant or manifest\n'+
  '##[error]Process completed with exit code 1.\n';
const secondProof=verifySecondQwenRepairPrewriteFailure(
  secondRun,secondJobs,artifacts,secondLog);
assert.equal(secondProof.verified,true);
assert.equal(secondProof.run_id,g.run_id);
assert.equal(secondProof.previous_marker_path,g.previous_marker_path);
assert.match(qwenRepairSecondPrewriteRecoveryPath(),
  /^workflows\/issues\/3784\/results\/44495243036-1-[a-f0-9]{64}\.json$/);
for(const wrong of [
  {run:{...secondRun,run_attempt:2}},
  {run:{...secondRun,actor:{login:'github-actions[bot]'}}},
  {run:{...secondRun,event:'workflow_dispatch'}},
  {run:{...secondRun,head_sha:f.head_sha}},
  {jobs:{...secondJobs,total_count:3}},
  {jobs:{...secondJobs,jobs:secondJobs.jobs.map(j=>
    j.name==='publish'?{...j,id:1}:j)}},
  {jobs:{...secondJobs,jobs:secondJobs.jobs.map(j=>
    j.name==='publish'?{...j,steps:j.steps.map(step=>
      step.name.startsWith('Authenticate original')
      ?{...step,conclusion:'success'}:step)}:j)}},
  {artifacts:{total_count:1,artifacts:[{name:'forged-result'}]}},
  {log:'Process completed with exit code 1.'},
]){
  assert.throws(()=>verifySecondQwenRepairPrewriteFailure(
    wrong.run??secondRun,wrong.jobs??secondJobs,
    wrong.artifacts??artifacts,wrong.log??secondLog),
    /trusted Qwen pre-write Publisher failure/);
}
// The spent FIRST marker must not authorize a new mutation. A second, source-
// pinned, separately CAS-authored marker may allow only its one Run.
const secondGrant={...grant,store_commit_sha:'d'.repeat(40),recovery:{
  ...grant.recovery,run_id:g.run_id+100,
  marker_path:qwenRepairSecondPrewriteRecoveryPath(),
  marker_store_commit_sha:'d'.repeat(40),
  second_attested:true,second_failed_run_id:g.run_id,
  first_marker_store_sha:g.previous_marker_store_sha,
}};
assert.equal(isValidQwenPrewriteRecoveryGrant(secondGrant,original),true);
for(const wrong of [
  {recovery:{...secondGrant.recovery,second_attested:false}},
  {recovery:{...secondGrant.recovery,second_failed_run_id:g.run_id+1}},
  {recovery:{...secondGrant.recovery,first_marker_store_sha:'f'.repeat(40)}},
  {recovery:{...secondGrant.recovery,run_id:g.run_id}},
  {recovery:{...secondGrant.recovery,marker_path:qwenRepairPrewriteRecoveryPath()}},
]){
  assert.equal(isValidQwenPrewriteRecoveryGrant({
    ...secondGrant,recovery:wrong.recovery},original),false);
}
// Exact source-bound record and manifest show the old read-only plan bug:
// the same prewrite_recovery marker is legal for reading a local patch and
// GitHub ancestors. It does NOT allow any new GitHub write on its own.
const sha=b=>createHash('sha256').update(b).digest('hex');
const patch='diff --git a/calc.js b/calc.js\n--- a/calc.js\n+++ b/calc.js\n@@ -1 +1 @@\n-old\n+new\n';
const manifest=[{path:'calc.js',old_sha256:'b'.repeat(64),
  new_sha256:'c'.repeat(64),old_bytes:4,new_bytes:4}];
const fullRecord={
  schema_version:1,kind:'trusted_qwen_repair_publisher_write_ahead',
  repository:'BestNathan/nession',issue:f.issue,action_id:f.action_id,
  worker_run_id:f.worker_run_id,worker_run_attempt:1,
  worker_sha:f.head_sha,source_sha:f.source_sha,
  original_main_sha:'ec2984381bda57491d764a9ba3e1123a63b89861',
  original_publisher_run_id:44281178406,
  branch:'refs/heads/agent/3784/qwen-39c01222a8d00fa3',
  checkpoint_version:3,checkpoint_commit_sha:'e'.repeat(40),
  checkpoint_ciphertext_sha256:'a'.repeat(64),
  patch_sha256:sha(patch),file_manifest_sha256:sha(JSON.stringify(manifest)),
  file_count:1,publisher_run_id:f.run_id,publication:'not_yet_attested',
};
const history=['5d7e9118b7e954e760cc680fff7d43b4f9e17612',
  f.source_sha];
const preflight={patch,origin:{published_head_shas:history},
  evidence:{schema_version:1,kind:'trusted_qwen_repair_preflight_only',
    status:'preflight_only',issue:f.issue,action_id:f.action_id,
    developer_run_id:f.worker_run_id,worker_sha:f.head_sha,
    source_sha:f.source_sha,original_main_sha:fullRecord.original_main_sha,
    original_publisher_run_id:fullRecord.original_publisher_run_id,
    original_pr_branch:fullRecord.branch,checkpoint_version:3,
    checkpoint_commit_sha:fullRecord.checkpoint_commit_sha,
    ciphertext_sha256:fullRecord.checkpoint_ciphertext_sha256,
    patch_sha256:fullRecord.patch_sha256,file_manifest:manifest,
  }};
const expectedParent=[fullRecord.original_main_sha,history[0]];
const api=async(method,url)=>{
  assert.equal(method,'GET','historical check performs no GitHub mutation');
  const index=history.findIndex(x=>url==='git/commits/'+x);
  assert.ok(index>=0,'only Store-attested original PR commits may be read');
  return {parents:[{sha:expectedParent[index]}],
    tree:{sha:String(index+1).repeat(40)}};
};
const result=await attestQwenRepairPriorGitHistory({
  preflight,intent:{...secondGrant,record:fullRecord},api});
assert.equal(result.predecessor_sha,f.source_sha);
assert.equal(result.length,2);
for(const bad of [
  {status:'replayed',may_publish:false},
  {recovery:{...secondGrant.recovery,second_attested:false}},
  {recovery:{...secondGrant.recovery,run_id:g.run_id}},
]){
  await assert.rejects(()=>attestQwenRepairPriorGitHistory({
    preflight,intent:{...secondGrant,record:fullRecord,...bad},api}),
    /Qwen Repair PR update/);
}
console.log('✓ source-attested real Qwen pre-write Run 44476308903, exact Job/Log/WAL locator, spoof/attempt-2/Artifact negatives');
