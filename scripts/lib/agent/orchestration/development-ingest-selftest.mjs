#!/usr/bin/env node
// #2010 fail-closed proof and integrity fixtures. Real Provider is intentionally
// not mocked into a success outcome: these assert only the trusted contract.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {matchingResult} from './development-ingest.mjs';

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
