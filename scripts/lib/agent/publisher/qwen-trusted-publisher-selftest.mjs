#!/usr/bin/env node
import assert from 'node:assert/strict';
import {assertQwenPublisherRunAuthority,isQwenPrewriteOwnerRecovery,
  QWEN_PREWRITE_RECOVERY_COMMAND} from './qwen-trusted-publisher.mjs';
import {SOURCE as QWEN_PREWRITE_FAILURE}
  from './qwen-repair-prewrite-failure.mjs';
import {composeQwenDeveloperResult,appendAuthenticatedResult}
  from '../orchestration/result-artifact.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
// A manually recovered Ingest Run is still authenticated by its exact path,
// name, head, artifact and receipt; only the event shape differs.
assert.equal(assertQwenPublisherRunAuthority(env,event,
  {...ingester,event:'issue_comment'},receipt).source_run_id,87001);
// #3491: a bot/main workflow_dispatch after completed Store Ingest is
// source-bound to the same original receipt and no new Publisher authority.
const botEnv={...env,GITHUB_EVENT_NAME:'workflow_dispatch',
  GITHUB_ACTOR:'github-actions[bot]'};
const botIngester={...ingester,event:'workflow_dispatch',
  name:'Qwen Developer Ingest worker:87001',
  actor:{login:'github-actions[bot]'}};
const botEvent={repository:{full_name:REPO},sender:{login:'github-actions[bot]'},
  inputs:{source_ingest_run_id:'88001'}};
assert.equal(assertQwenPublisherRunAuthority(botEnv,botEvent,botIngester,receipt)
  .source_run_id,87001);
for(const [environment,e,source] of [
  [{...botEnv,GITHUB_ACTOR:'BestNathan'},botEvent,botIngester],
  [{...botEnv,GITHUB_RUN_ATTEMPT:'2'},botEvent,botIngester],
  [botEnv,{...botEvent,repository:{full_name:'evil/repo'}},botIngester],
  [botEnv,{...botEvent,sender:{login:'BestNathan'}},botIngester],
  [botEnv,{...botEvent,inputs:{source_ingest_run_id:'88002'}},botIngester],
  [botEnv,{...botEvent,inputs:{source_ingest_run_id:'88001-x'}},botIngester],
  [botEnv,botEvent,{...botIngester,actor:{login:'BestNathan'}}],
  [botEnv,botEvent,{...botIngester,event:'issue_comment'}],
  [botEnv,botEvent,{...botIngester,name:'Store / Agent Development Ingest'}],
  [botEnv,botEvent,{...botIngester,name:'Qwen Developer Ingest worker:87002'}],
])assert.throws(()=>assertQwenPublisherRunAuthority(
  environment,e,source,receipt),/trusted Qwen Publisher Runner/);
for(const bad of [
  {env:{...env,GITHUB_EVENT_NAME:'pull_request'}},
  {env:{...env,GITHUB_REF:'refs/pull/99/merge'}},
  {env:{...env,GITHUB_RUN_ATTEMPT:'2'}},
  {env:{...env,GITHUB_WORKFLOW:'another'}},
  {event:{...event,workflow_run:{...event.workflow_run,id:0}}},
  {event:{...event,workflow_run:{...event.workflow_run,
    conclusion:'failure'}}},
  {ingester:{...ingester,head_branch:'staging'}},
  {ingester:{...ingester,event:'pull_request'}},
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
// #4046: a very narrow Owner/main comment (not a generic Owner request)
// may recover exactly one pre-write Publisher failure. The completed original
// Store Ingest is independently reauthenticated against one real Worker.
const historical=QWEN_PREWRITE_FAILURE;
const ownerEnv={...env,GITHUB_EVENT_NAME:'issue_comment',
  GITHUB_ACTOR:'BestNathan',GITHUB_RUN_ID:'44479999999'};
const ownerEvent={action:'created',repository:{full_name:REPO},
  sender:{login:'BestNathan'},issue:{number:historical.issue,state:'open'},
  comment:{id:7002991001,user:{login:'BestNathan'},
    body:QWEN_PREWRITE_RECOVERY_COMMAND}};
const ownerIngest={...botIngester,id:historical.source_ingest_run_id,
  name:'Qwen Developer Ingest worker:'+historical.worker_run_id};
const ownerReceipt={...receipt,ingester_run_id:ownerIngest.id,
  issue:historical.issue,run_id:historical.worker_run_id,
  action_id:historical.action_id};
assert.equal(isQwenPrewriteOwnerRecovery(ownerEnv,ownerEvent),true);
assert.equal(assertQwenPublisherRunAuthority(ownerEnv,ownerEvent,
  ownerIngest,ownerReceipt).source_run_id,historical.worker_run_id);
for(const wrong of [
  {env:{...ownerEnv,GITHUB_ACTOR:'github-actions[bot]'}},
  {env:{...ownerEnv,GITHUB_RUN_ATTEMPT:'2'}},
  {env:{...ownerEnv,GITHUB_REF:'refs/heads/staging'}},
  {event:{...ownerEvent,action:'edited'}},
  {event:{...ownerEvent,issue:{number:historical.issue,state:'closed'}}},
  {event:{...ownerEvent,issue:{number:historical.issue,state:'open',
      pull_request:{url:'https://evil.invalid'}}}},
  {event:{...ownerEvent,comment:{...ownerEvent.comment,id:0}}},
  {event:{...ownerEvent,comment:{...ownerEvent.comment,
      body:QWEN_PREWRITE_RECOVERY_COMMAND+' '}}},
  {event:{...ownerEvent,comment:{...ownerEvent.comment,
      body:'/nession recover-qwen-publisher issue=3784 failed_run=44476308904'}}},
  {event:{...ownerEvent,comment:{...ownerEvent.comment,
      user:{login:'attacker'}}}},
  {event:{...ownerEvent,sender:{login:'attacker'}}},
  {ingester:{...ownerIngest,id:ownerIngest.id+1}},
  {ingester:{...ownerIngest,actor:{login:'attacker'}}},
  {ingester:{...ownerIngest,name:'Store / Agent Development Ingest'}},
  {receipt:{...ownerReceipt,run_id:ownerReceipt.run_id+1}},
  {receipt:{...ownerReceipt,issue:4046}},
  {receipt:{...ownerReceipt,action_id:'f'.repeat(64)}},
]){
  assert.throws(()=>assertQwenPublisherRunAuthority(
    wrong.env??ownerEnv,wrong.event??ownerEvent,
    wrong.ingester??ownerIngest,wrong.receipt??ownerReceipt),
    /trusted Qwen Publisher Runner/);
}
// A Worker cannot invent a PR HEAD. Only a producer that already verified
// the original ZIP/claim and Publisher's exact GitHub readback can compose v2.
// Signed task source is a different historical main SHA from the Worker
// workflow code. This real #3784 shape must produce a Developer v2 receipt.
const attReceipt={...receipt,source_sha:'7'.repeat(40)};
const action=attReceipt.action_id;
const claim={inputs:{task:'implement',agent_id:'dev-qwen-01',
  issue_number:String(attReceipt.issue),action_id:action,
  input_sha:attReceipt.source_sha}};
const worker={id:87001,run_attempt:1,head_sha:attReceipt.worker_sha,
  head_branch:'main',name:'Agent / Development',
  path:'.github/workflows/agent-develop.yml',
  event:'workflow_dispatch',status:'completed',conclusion:'success',
  repository:{full_name:REPO},head_repository:{full_name:REPO}};
const originalResult={id:7771,expired:false,
  digest:'sha256:'+'f'.repeat(64),workflow_run:{id:87001,head_sha:worker.head_sha}};
const resultJsonBytes=Buffer.from('{"outcome":"implementation_ready"}');
const readback={kind:'authenticated_qwen_publisher_pr_receipt',
  status:'published_verified_by_github',issue:attReceipt.issue,
  action_id:action,source_run_id:worker.id,source_run_attempt:1,
  publisher_run_id:89001,pull_request:2275,
  head_sha:'1'.repeat(40),target_main_sha:sha,
  publication_intent_store_sha:'2'.repeat(40),
  checkpoint_commit_sha:attReceipt.checkpoint_commit_sha,
  branch:'agent/2274/qwen-'+action.slice(0,16)};
const make=(override={})=>composeQwenDeveloperResult({
  receipt:attReceipt,claim,worker,originalResult,
  resultJsonBytes,readback,publisherRunId:89001,
  signedSourceSha:attReceipt.source_sha,...override});
const good=make();
assert.equal(good.schema_version,2);
assert.equal(good.source.input_sha,attReceipt.source_sha);
assert.notEqual(good.source.input_sha,worker.head_sha);
assert.equal(good.source.output_sha,readback.head_sha);
assert.equal(good.implementing_pr.head_sha_at_attestation,readback.head_sha);
assert.equal(good.artifact.id,originalResult.id);
for(const bad of [
  {claim:{inputs:{...claim.inputs,input_sha:'e'.repeat(40)}}},
  {signedSourceSha:'e'.repeat(40)},
  {signedSourceSha:worker.head_sha},
  {signedSourceSha:null},
  {worker:{...worker,run_attempt:2}},
  {worker:{...worker,repository:{full_name:'evil/repo'}}},
  {worker:{...worker,path:'.github/workflows/foreign.yml'}},
  {originalResult:{...originalResult,digest:'fake'}},
  {originalResult:{...originalResult,expired:true}},
  {originalResult:{...originalResult,workflow_run:{id:888,head_sha:worker.head_sha}}},
  {claim:{inputs:{...claim.inputs,action_id:'e'.repeat(64)}}},
  {claim:{inputs:{...claim.inputs,task:'repair'}}},
  {readback:{...readback,pull_request:0}},
  {readback:{...readback,head_sha:'zzz'}},
  {readback:{...readback,source_run_id:1}},
  {readback:{...readback,checkpoint_commit_sha:'a'.repeat(40)}},
  {publisherRunId:89002},
])assert.throws(()=>make(bad),/Qwen Developer source|Agent result ingest/);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-v2-receipt-'));
try{
  const first=appendAuthenticatedResult(dir,good,{namespace:'producer-results-v2'});
  assert.equal(first.changed,true);
  assert.match(first.path,/\/producer-results-v2\/87001-1-[a-f0-9]{64}\.json$/);
  assert.equal(appendAuthenticatedResult(dir,good,
    {namespace:'producer-results-v2'}).changed,false);
  assert.throws(()=>appendAuthenticatedResult(dir,
    {...good,result:{...good.result,target_sha:'3'.repeat(40)},
      source:{...good.source,output_sha:'3'.repeat(40)},
      implementing_pr:{...good.implementing_pr,
        head_sha_at_attestation:'3'.repeat(40)}},
    {namespace:'producer-results-v2'}),/immutable evidence collision/);
  assert.throws(()=>appendAuthenticatedResult(dir,good,
    {namespace:'../../escape'}),/unapproved immutable producer-result namespace/);
}finally{fs.rmSync(dir,{recursive:true,force:true});}
console.log('Qwen Developer v2: exact Worker/Artifact/PR composition, collision-free append and negative replay/source fixtures passed');

console.log('Qwen main Publisher: independently bound Ingest Run, exact Worker/Checkpoint receipt and all unsafe event/replay denials pass');

// #3885: only GET-only original PR reconciliation may advance an attested Store.
await import('./qwen-publisher-reconcile-selftest.mjs');
