#!/usr/bin/env node
// #2010 fail-closed proof and integrity fixtures. Real Provider is intentionally
// not mocked into a success outcome: these assert only the trusted contract.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {matchingResult,resolveTrustedIngestSource,V2_INGEST_WORKER_RUN,V2_INGEST_COMMAND} from './development-ingest.mjs';
import {CONTROLLED_V2_CONTINUATION} from './development-resume.mjs';

const issue=1997,runId=33012,attempt=1,source_sha='a'.repeat(40);
const action_id='b'.repeat(64),digest=s=>createHash('sha256').update(s).digest('hex');
const ticket={issue_number:String(issue),action_id,input_sha:source_sha};
const claim={inputs:ticket},run={id:runId,run_attempt:attempt,
  status:'completed',conclusion:'success'};
const metadata={agent_id:'agent-123456',source_sha,
  harness_digest:'c'.repeat(64),run_id:runId,attempt,sdk_version:'1.2.3'};
const wrapped={schema_version:1,kind:'cursor-native-encrypted-snapshot',
  metadata,ciphertext_sha256:'d'.repeat(64)};
const proof={schema_version:1,kind:'bounded-development-native-session',
  issue,action_id,source_sha,run_id:runId,attempt,metadata,
  ciphertext_sha256:wrapped.ciphertext_sha256};
const result={schema_version:1,kind:'developer_proposal',
  issue,action_id,source_sha,run_id:runId,attempt,
  status:'proposed_not_published',native_read_edit_verified:true,
  file:'e2e/fixtures/agent-development/1997-canary.txt',
  content_sha256:digest('Durable Worker fixture: complete\n')};
const verified=matchingResult(result,proof,wrapped,claim,run);
assert.equal(verified.agent_id,metadata.agent_id);
for(const x of [
  {result:{...result,status:'published'}},
  {result:{...result,native_read_edit_verified:false}},
  {result:{...result,content_sha256:'e'.repeat(64)}},
  {result:{...result,issue:1998}},
  {proof:{...proof,run_id:runId+1}},
  {proof:{...proof,action_id:'0'.repeat(64)}},
  {proof:{...proof,ciphertext_sha256:'0'.repeat(64)}},
  {wrapped:{...wrapped,kind:'plaintext'}},
  {wrapped:{...wrapped,metadata:{...metadata,agent_id:'agent-tampered'}}},
  {run:{...run,conclusion:'failure'}},
  {run:{...run,run_attempt:2}},
])assert.throws(()=>matchingResult(x.result??result,x.proof??proof,
  x.wrapped??wrapped,claim,x.run??run),/no authentic/);
console.log('Development ingest: actual bounded outcome contract, encrypted native proof and tampering denial passed');

const resumedClaim={inputs:{...ticket,resume_from:'signed-native-continuation'}};
const resumedMeta={...metadata,agent_id:'agent-7d5b4a61-1476-4ce7-a38a-82907aa3b1a6'};
const resumedProof={...proof,metadata:resumedMeta};
const resumedWrapped={...wrapped,metadata:resumedMeta};
const resumedResult={...result,native_resumed:true,prior_turn_word_observed:true,
  parent_checkpoint_commit_sha:'d812e3655c0ad6337b1003aa0c1794c12335adb0',
  content_sha256:digest('Durable Worker fixture: complete\nPrevious value: pending\n')};
assert.equal(matchingResult(resumedResult,resumedProof,resumedWrapped,resumedClaim,run).agent_id,resumedMeta.agent_id);
for(const bad of [{native_resumed:false},{prior_turn_word_observed:false},
  {parent_checkpoint_commit_sha:'0'.repeat(40)},
  {content_sha256:result.content_sha256}])
  assert.throws(()=>matchingResult({...resumedResult,...bad},resumedProof,resumedWrapped,resumedClaim,run));
assert.throws(()=>matchingResult(resumedResult,proof,wrapped,resumedClaim,run));

const v2Claim={inputs:{...ticket,action_id:CONTROLLED_V2_CONTINUATION,
  resume_from:'immutable-signed-checkpoint-v2'}};
const v2Proof={...resumedProof,action_id:CONTROLLED_V2_CONTINUATION};
const v2Result={...resumedResult,action_id:CONTROLLED_V2_CONTINUATION,
  parent_checkpoint_commit_sha:'f9abdeca3cc26780fb0a7b2ed7000d2dd28cf142'};
assert.equal(matchingResult(v2Result,v2Proof,resumedWrapped,v2Claim,run).agent_id,
  resumedMeta.agent_id);
for(const bad of [
  {parent_checkpoint_commit_sha:'d812e3655c0ad6337b1003aa0c1794c12335adb0'},
  {parent_checkpoint_commit_sha:'0'.repeat(40)},
  {native_resumed:false},{prior_turn_word_observed:false},
  {content_sha256:result.content_sha256},
])assert.throws(()=>matchingResult({...v2Result,...bad},v2Proof,resumedWrapped,v2Claim,run),
  /no authentic/);
assert.throws(()=>matchingResult(v2Result,{...v2Proof,action_id:action_id},
  resumedWrapped,v2Claim,run),/no authentic/);
assert.throws(()=>matchingResult(v2Result,v2Proof,resumedWrapped,
  {...v2Claim,inputs:{...v2Claim.inputs,action_id}},run),/no authentic/);

const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'BestNathan/nession',
  GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW:'Store / Agent Development Ingest',
  GITHUB_SHA:'a'.repeat(40),GITHUB_EVENT_NAME:'issue_comment',GITHUB_ACTOR:'BestNathan'};
const event={action:'created',repository:{full_name:'BestNathan/nession'},
  issue:{number:1997},comment:{id:123,body:V2_INGEST_COMMAND,user:{login:'BestNathan'}}};
assert.deepEqual(resolveTrustedIngestSource({environment:env,event}),
  {run_id:V2_INGEST_WORKER_RUN,source:null,continuation:true,v2_recovery:true});
for(const patch of [
  {comment:{...event.comment,body:V2_INGEST_COMMAND+' '}},
  {comment:{...event.comment,body:V2_INGEST_COMMAND.replace(String(V2_INGEST_WORKER_RUN),'123')}},
  {comment:{...event.comment,user:{login:'attacker'}}},
  {issue:{number:1998}},{action:'edited'},
])assert.throws(()=>resolveTrustedIngestSource({environment:env,event:{...event,...patch}}),
  /exact owner\/main/);
assert.throws(()=>resolveTrustedIngestSource({environment:{...env,GITHUB_ACTOR:'attacker'},event}),
  /exact owner\/main/);
assert.throws(()=>resolveTrustedIngestSource({environment:{...env,GITHUB_REF:'refs/pull/1/merge'},event}),
  /main-owned/);
console.log('Development Ingest v2: signed parent, exact Worker/Action owner fallback and forgery negatives passed');
