#!/usr/bin/env node
// #4046: independent historical Github Run/Job/log attestation must never
// trust a model claim, generic Owner comment, or missing result artifact.
import assert from 'node:assert/strict';
import {SOURCE as f,verifyQwenRepairPrewriteFailure}
  from './qwen-repair-prewrite-failure.mjs';
import {qwenRepairPrewriteRecoveryPath}
  from './qwen-repair-intent.mjs';

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
console.log('✓ source-attested real Qwen pre-write Run 44476308903, exact Job/Log/WAL locator, spoof/attempt-2/Artifact negatives');
