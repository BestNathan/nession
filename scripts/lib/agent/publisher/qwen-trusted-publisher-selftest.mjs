#!/usr/bin/env node
import assert from 'node:assert/strict';
import {assertQwenPublisherRunAuthority}
  from './qwen-trusted-publisher.mjs';

const REPO='BestNathan/nession',sha='b'.repeat(40);
const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:REPO,
  GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_run',
  GITHUB_WORKFLOW:'Store / Qwen Publisher',GITHUB_RUN_ATTEMPT:'1',
  GITHUB_RUN_ID:'89001',GITHUB_SHA:sha};
const ingester={id:88001,run_attempt:1,
  status:'completed',conclusion:'success',event:'workflow_run',
  path:'.github/workflows/store-agent-development-ingest.yml',
  name:'Store / Agent Development Ingest',head_branch:'main',
  head_sha:sha,repository:{full_name:REPO},
  head_repository:{full_name:REPO}};
const receipt={schema_version:1,
  kind:'authenticated_qwen_development_checkpoint_receipt',
  status:'committed',ingester_run_id:88001,ingester_sha:sha,
  run_id:87001,attempt:1,worker_sha:'a'.repeat(40),
  issue:2274,action_id:'c'.repeat(64),
  checkpoint_version:1,checkpoint_commit_sha:'d'.repeat(40),
  ciphertext_sha256:'e'.repeat(64)};
const event={action:'completed',workflow_run:{
  id:88001,head_sha:sha,conclusion:'success'}};
assert.equal(assertQwenPublisherRunAuthority(env,event,ingester,receipt)
  .source_run_id,87001);
for(const bad of [
  {env:{...env,GITHUB_EVENT_NAME:'pull_request'}},
  {env:{...env,GITHUB_REF:'refs/pull/99/merge'}},
  {env:{...env,GITHUB_RUN_ATTEMPT:'2'}},
  {env:{...env,GITHUB_WORKFLOW:'another'}},
  {event:{...event,workflow_run:{...event.workflow_run,id:0}}},
  {event:{...event,workflow_run:{...event.workflow_run,
    conclusion:'failure'}}},
  {ingester:{...ingester,head_branch:'staging'}},
  {ingester:{...ingester,run_attempt:2}},
  {ingester:{...ingester,conclusion:'failure'}},
  {ingester:{...ingester,
    path:'.github/workflows/attacker.yml'}},
  {ingester:{...ingester,repository:{full_name:'attacker/repo'}}},
  {receipt:{...receipt,kind:'synthetic_canary'}},
  {receipt:{...receipt,ingester_run_id:88002}},
  {receipt:{...receipt,ingester_sha:'0'.repeat(40)}},
  {receipt:{...receipt,action_id:'bad'}},
  {receipt:{...receipt,checkpoint_commit_sha:'bad'}},
  {receipt:{...receipt,run_id:0}},
]){
  assert.throws(()=>assertQwenPublisherRunAuthority(
    bad.env??env,bad.event??event,bad.ingester??ingester,
    bad.receipt??receipt),/trusted Qwen Publisher Runner/);
}
console.log('Qwen main Publisher: independently bound Ingest Run, exact Worker/Checkpoint receipt and all unsafe event/replay denials pass');
