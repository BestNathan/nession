#!/usr/bin/env node
// #4046: independent historical Github Run/Job/log attestation must never
// trust a model claim, generic Owner comment, or missing result artifact.
import assert from 'node:assert/strict';
import {SOURCE as f,verifyQwenRepairPrewriteFailure}
  from './qwen-repair-prewrite-failure.mjs';
import {qwenRepairPrewriteRecoveryPath}
  from './qwen-repair-intent.mjs';
import {isValidQwenPrewriteRecoveryGrant} from './qwen-repair-github.mjs';

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
console.log('✓ source-attested real Qwen pre-write Run 44476308903, exact Job/Log/WAL locator, spoof/attempt-2/Artifact negatives');
