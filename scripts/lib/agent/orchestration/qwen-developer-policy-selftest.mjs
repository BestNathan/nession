#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {bindQwenDeveloper,qwenDeveloperModel,qwenGatewayEndpoint,
  verifyQwenNativeContinuation} from './qwen-developer-policy.mjs';

const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const env={
  ANTHROPIC_MODEL:'qwen3.7-plus',
  ANTHROPIC_BASE_URL:'https://coding.dashscope.aliyuncs.com/apps/anthropic',
  ANTHROPIC_AUTH_TOKEN:'SECRET_NEVER_HASH_OR_LOG',
};
const admission={authorized:true,role:'developer',task:'implement',
  issue:2274,action_id:'a'.repeat(64),input_sha:'b'.repeat(40),run_id:401,
  agent_id:'dev-qwen-01',provider:'claude-code',environment:'dev-claude-qwen'};
const plan=bindQwenDeveloper(admission,registry,env,{cliVersion:'2.1.34'});
assert.equal(plan.model,env.ANTHROPIC_MODEL);
assert.equal(plan.provider,'claude-code');
assert.equal(plan.environment,'dev-claude-qwen');
assert.equal(plan.tools.join(','),'Read,Edit,Write');
assert.match(plan.harness_digest,/^[a-f0-9]{64}$/);
assert.ok(!JSON.stringify(plan).includes(env.ANTHROPIC_AUTH_TOKEN));
assert.equal(plan.harness_digest,bindQwenDeveloper(admission,registry,env,
  {cliVersion:'2.1.34'}).harness_digest);
assert.notEqual(plan.harness_digest,bindQwenDeveloper(admission,registry,
  {...env,ANTHROPIC_MODEL:'qwen3-coder-plus'},
  {cliVersion:'2.1.34'}).harness_digest);
assert.notEqual(plan.harness_digest,bindQwenDeveloper(admission,registry,
  {...env,ANTHROPIC_BASE_URL:'https://other.example.test/model'},
  {cliVersion:'2.1.34'}).harness_digest);
assert.notEqual(plan.harness_digest,bindQwenDeveloper(admission,registry,env,
  {cliVersion:'2.1.35'}).harness_digest);
assert.throws(()=>qwenDeveloperModel({...env,ANTHROPIC_MODEL:'claude-sonnet-5'}),/Qwen/);
assert.throws(()=>qwenDeveloperModel({...env,ANTHROPIC_MODEL:undefined}),/Qwen/);
assert.throws(()=>qwenGatewayEndpoint({...env,ANTHROPIC_BASE_URL:'http://host.test/'}),/HTTPS/);
assert.throws(()=>qwenGatewayEndpoint({...env,ANTHROPIC_BASE_URL:'https://user:pass@host.test/'}),/HTTPS/);
assert.throws(()=>qwenGatewayEndpoint({...env,ANTHROPIC_BASE_URL:'https://host.test/?api_key=bad'}),/HTTPS/);
assert.throws(()=>qwenGatewayEndpoint({...env,ANTHROPIC_AUTH_TOKEN:'',
  ANTHROPIC_API_KEY:''}),/credentials/);
assert.throws(()=>bindQwenDeveloper({...admission,authorized:false},registry,env,
  {cliVersion:'2.1.34'}),/signed Store-backed/);
assert.throws(()=>bindQwenDeveloper({...admission,role:'reviewer'},registry,env,
  {cliVersion:'2.1.34'}),/signed Store-backed/);
assert.throws(()=>bindQwenDeveloper({...admission,agent_id:'dev-cursor-01',
  provider:'cursor',environment:'agent-dev-cursor-01'},registry,env,
  {cliVersion:'2.1.34'}),/mismatch/);
assert.throws(()=>bindQwenDeveloper({...admission,environment:'deepseek'},registry,env,
  {cliVersion:'2.1.34'}),/mismatch/);
assert.throws(()=>bindQwenDeveloper(admission,registry,env,{cliVersion:'latest'}),/pinned/);
assert.throws(()=>bindQwenDeveloper(admission,registry,env,
  {cliVersion:'2.1.34',model:'qwen3-coder-plus'}),/model differs/);
const metadata={session_id:'550e8400-e29b-41d4-a716-446655440000',
  source_sha:plan.source_sha,harness_digest:plan.harness_digest,
  cli_version:plan.cli_version};
const continuation={...admission,resume_from:{
  parent_action_id:'c'.repeat(64),checkpoint_version:1}};
assert.equal(verifyQwenNativeContinuation(continuation,plan,metadata).session_id,
  metadata.session_id);
assert.throws(()=>verifyQwenNativeContinuation(admission,plan,metadata),/unbound/);
assert.throws(()=>verifyQwenNativeContinuation(continuation,plan,
  {...metadata,harness_digest:'d'.repeat(64)}),/incompatible/);
assert.throws(()=>verifyQwenNativeContinuation(continuation,plan,
  {...metadata,cli_version:'2.1.35'}),/incompatible/);
assert.throws(()=>verifyQwenNativeContinuation(continuation,plan,
  {...metadata,source_sha:'c'.repeat(40)}),/incompatible/);
assert.throws(()=>verifyQwenNativeContinuation(continuation,plan,
  {...metadata,session_id:'bad'}),/incompatible/);
console.log('Qwen Developer runtime binding: exact model/endpoint/CLI and native Resume denials pass');
