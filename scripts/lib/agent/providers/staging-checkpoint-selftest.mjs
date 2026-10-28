#!/usr/bin/env node
import assert from 'node:assert/strict';
import {stagingSeedMetadata} from './claude-resume-fixture.mjs';

const base={sourceSha:'a'.repeat(40),runId:7001,attempt:1,
  sessionId:'11111111-1111-4111-8111-111111111111',
  projectKey:'-Users-runner-work-nession',cliVersion:'2.1.312',
  model:'qwen3.7-plus',dispatchId:'d'.repeat(64),cwdSha:'c'.repeat(64)};
const value=stagingSeedMetadata(base);
assert.equal(value.source_sha,base.sourceSha);
assert.equal(value.model,'qwen3.7-plus');
assert.equal(value.issue,2319);
assert.equal(value.agent_id,'dev-qwen-01');
assert.equal(value.dispatch_id,base.dispatchId);
assert.match(value.harness_digest,/^[a-f0-9]{64}$/);
// The harness digest binds the model: a later default switch cannot reuse it.
assert.notEqual(stagingSeedMetadata({...base,model:'qwen3.7-max'}).harness_digest,
  value.harness_digest);
assert.notEqual(stagingSeedMetadata({...base,cliVersion:'2.1.313'}).harness_digest,
  value.harness_digest);
for(const [change,error] of [
  [{sourceSha:'short'},/invalid staging seed metadata/],
  [{runId:0},/invalid staging seed metadata/],
  [{attempt:2},/invalid staging seed metadata/],
  [{sessionId:'not-a-uuid'},/invalid staging seed metadata/],
  [{projectKey:'../escape'},/invalid staging seed metadata/],
  [{cliVersion:'latest'},/invalid staging seed metadata/],
  [{model:'claude-sonnet-5'},/invalid staging seed metadata/],
  [{model:''},/invalid staging seed metadata/],
  [{dispatchId:'0'.repeat(63)},/invalid staging seed metadata/],
  [{cwdSha:'x'.repeat(64)},/invalid staging seed metadata/],
]) assert.throws(()=>stagingSeedMetadata({...base,...change}),error);
console.log('Staging checkpoint metadata: pinned model/CLI, harness binding and negative fixtures passed');
