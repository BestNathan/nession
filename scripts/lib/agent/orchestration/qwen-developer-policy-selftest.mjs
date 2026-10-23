#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {sealClaudeNativeSession,openClaudeNativeSession}
  from '../providers/claude-native-store.mjs';
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
// This is an actual ciphertext restore proof, not only JSON-shape comparison.
// A model-version change must be rejected by the native Session cryptographic
// provenance check before any Claude CLI --resume invocation.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-developer-binding-'));
try {
  const seed=path.join(root,'seed'),projectKey='-workspace';
  const project=path.join(seed,'projects',projectKey);
  fs.mkdirSync(project,{recursive:true,mode:0o700});
  const nativeMarker='PRIVATE_NATIVE_CONTEXT_MARKER';
  fs.writeFileSync(path.join(project,metadata.session_id+'.jsonl'),
    JSON.stringify({sessionId:metadata.session_id,type:'user',message:nativeMarker})+'\n',
    {flag:'wx',mode:0o600});
  const pair=generateKeyPairSync('rsa',{modulusLength:2048});
  const publicKeyPem=pair.publicKey.export({type:'spki',format:'pem'});
  const privateKeyPem=pair.privateKey.export({type:'pkcs8',format:'pem'});
  const nativeMetadata={...metadata,project_key:projectKey,
    cwd_sha256:createHash('sha256').update('/workspace').digest('hex'),
    run_id:admission.run_id,attempt:1};
  const sealed=sealClaudeNativeSession({configDir:seed,metadata:nativeMetadata,
    publicKeyPem});
  assert.ok(!JSON.stringify(sealed).includes(nativeMarker),'native plaintext escaped ciphertext');
  const target=path.join(root,'restored');
  assert.equal(openClaudeNativeSession({record:sealed,privateKeyPem,
    expected:nativeMetadata,configDir:target}).session_id,metadata.session_id);
  assert.ok(fs.readFileSync(path.join(target,'projects',projectKey,
    metadata.session_id+'.jsonl'),'utf8').includes(nativeMarker));
  assert.throws(()=>openClaudeNativeSession({record:sealed,privateKeyPem,
    expected:{...nativeMetadata,harness_digest:'e'.repeat(64)},
    configDir:path.join(root,'changed-model')}),/incompatible/);
  assert.throws(()=>openClaudeNativeSession({record:sealed,privateKeyPem,
    expected:{...nativeMetadata,cli_version:'2.1.35'},
    configDir:path.join(root,'changed-cli')}),/incompatible/);
} finally {fs.rmSync(root,{recursive:true,force:true});}
console.log('Qwen Developer runtime binding: model/endpoint/CLI and cryptographic native Resume denials pass');
