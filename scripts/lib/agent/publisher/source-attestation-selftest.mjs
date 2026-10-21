#!/usr/bin/env node
import assert from 'node:assert/strict';
import {CONTROLLED_1997_POLICY as P} from './controlled-proposal.mjs';
import {assertControlledPublisherSourceRun,assertControlledPublisherStore,
  attestControlled1997PublisherSource} from './source-attestation.mjs';

const run={
  id:P.run_id,run_attempt:P.attempt,head_sha:P.worker_sha,
  path:'.github/workflows/agent-develop.yml',name:'Agent / Development',
  event:'workflow_dispatch',head_branch:'main',actor:{login:'github-actions[bot]'},
  repository:{full_name:'BestNathan/nession'},
  head_repository:{full_name:'BestNathan/nession'},
  status:'completed',conclusion:'success',
};
const ingest={
  id:P.ingester_run_id,run_attempt:P.ingester_attempt,head_sha:P.ingester_sha,
  path:'.github/workflows/store-agent-development-ingest.yml',
  name:'Store / Agent Development Ingest',event:'issue_comment',
  head_branch:'main',actor:{login:'BestNathan'},
  repository:{full_name:'BestNathan/nession'},
  head_repository:{full_name:'BestNathan/nession'},
  status:'completed',conclusion:'success',
};
const artifact=(type,id,digest)=>({
  id, name:type+'-'+P.run_id+'-'+P.attempt,digest,
  size_in_bytes:4000,expired:false,
  workflow_run:{id:P.run_id,head_sha:P.worker_sha},
});
const claim=artifact('development-worker-claim',P.claim_artifact_id,P.claim_artifact_digest);
const result=artifact('development-worker',P.result_artifact_id,P.result_artifact_digest);
const artifacts={total_count:2,artifacts:[claim,result]};
assert.deepEqual(assertControlledPublisherSourceRun(run,ingest,artifacts),
  {claim,result});
const deny=(patch,reason)=>assert.throws(()=>
  assertControlledPublisherSourceRun(
    {...run,...patch.run},{...ingest,...patch.ingest},
    {...artifacts,...patch.artifacts}), reason);
for(const change of [
  {id:999},{run_attempt:2},{head_sha:'0'.repeat(40)},
  {event:'pull_request'},{path:'.github/workflows/agent-review.yml'},
  {name:'Agent / Review'},{head_branch:'untrusted'},
  {actor:{login:'attacker'}},{conclusion:'failure'},
  {status:'in_progress'},{repository:{full_name:'other/repo'}},
  {head_repository:{full_name:'attacker/nession'}},
])deny({run:change},/untrusted|wrong authenticated/);
for(const change of [
  {id:7},{run_attempt:2},{head_sha:'0'.repeat(40)},
  {actor:{login:'attacker'}},{event:'workflow_dispatch'},
  {path:'.github/workflows/agent-develop.yml'},
  {name:'Agent / Development'},{conclusion:'failure'},
  {head_branch:'fork'},{repository:{full_name:'forged/repo'}},
])deny({ingest:change},/untrusted|wrong independently/);
for(const [replace,regex] of [
  [[{...claim,id:666},result],/Artifact/],
  [[{...claim,digest:'sha256:'+'0'.repeat(64)},result],/Artifact/],
  [[{...claim,expired:true},result],/Artifact/],
  [[{...claim,size_in_bytes:32*1024*1024+1},result],/Artifact/],
  [[{...claim,workflow_run:{id:44,head_sha:P.worker_sha}},result],/Artifact/],
  [[claim,{...result,id:66}],/Artifact/],
  [[claim,{...result,expired:true}],/Artifact/],
  [[claim,claim,result],/artifact list|Artifact/],
  [[result],/Artifact/],
])deny({artifacts:{total_count:replace.length,artifacts:replace}},regex);
deny({artifacts:{total_count:3,artifacts:[claim,result]}},/list/);
deny({artifacts:{total_count:101,artifacts:Array.from({length:101},()=>claim)}},/list/);

const action={
  id:P.action_id,status:'yielded',
  task:{role:'developer',agent_id:'dev-cursor-01',sha:P.source_sha},
  receipt:{
    source_run_id:P.run_id,source_attempt:P.attempt,
    checkpoint_version:P.checkpoint_version,
    checkpoint_commit_sha:P.checkpoint_commit_sha,
    ciphertext_sha256:P.checkpoint_ciphertext_sha256,
  },
};
const checkpoint={
  version:P.checkpoint_version,commit_sha:P.checkpoint_commit_sha,
  ciphertext_sha256:P.checkpoint_ciphertext_sha256,
  metadata:{session_id:P.native_session_id,harness_digest:P.harness_digest,
    source_sha:P.source_sha,provider:'cursor'},
};
const store={
  already_yielded:true,state_version:P.workflow_state_version,
  previous_version:2,next_version:3,action,existing_checkpoint:checkpoint,
};
assert.deepEqual(assertControlledPublisherStore(store,run),checkpoint);
for(const patch of [
  {already_yielded:false},{state_version:15},{previous_version:1},
  {next_version:4},{action:{...action,status:'dispatched'}},
  {action:{...action,receipt:{...action.receipt,source_run_id:7}}},
  {action:{...action,task:{...action.task,role:'reviewer'}}},
  {action:{...action,task:{...action.task,sha:'0'.repeat(40)}}},
  {existing_checkpoint:{...checkpoint,version:2}},
  {existing_checkpoint:{...checkpoint,ciphertext_sha256:'0'.repeat(64)}},
  {existing_checkpoint:{...checkpoint,metadata:{...checkpoint.metadata,session_id:'forged'}}},
  {existing_checkpoint:{...checkpoint,metadata:{...checkpoint.metadata,harness_digest:'0'.repeat(64)}}},
])assert.throws(()=>assertControlledPublisherStore({...store,...patch},run),
  /Store Yield|native version/);
// Full path requires independently fetched signed ZIPs, Controller HMAC and
// orphan Store; it must fail before any network/write on forged metadata.
await assert.rejects(()=>attestControlled1997PublisherSource({
  run:{...run,id:0},ingesterRun:ingest,artifacts,claimZip:Buffer.from('bad'),
  resultZip:Buffer.from('bad'),key:Buffer.alloc(32),
  reader:{getRun:async()=>{throw Error('must not fetch untrusted run');}},
  remote:'https://github.com/BestNathan/nession.git',checkout:'/tmp/not-used',
}),/wrong authenticated Developer source/);
await assert.rejects(()=>attestControlled1997PublisherSource({
  run,ingesterRun:ingest,artifacts,claimZip:Buffer.from('bad'),
  resultZip:Buffer.from('bad'),key:Buffer.alloc(32),
  reader:{getRun:async()=>{throw Error('must not fetch before ZIP authentication');}},
  remote:'https://github.com/BestNathan/nession.git',checkout:'/tmp/not-used',
}),/authenticated claim ZIP bytes mismatch/);
console.log('Trusted Publisher source: real pinned Run, Ingest, exact Artifacts, Store v3, tamper, replay, forgery and pre-network denials passed; no write/PR');
