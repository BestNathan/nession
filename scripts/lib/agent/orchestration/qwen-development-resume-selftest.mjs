#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {bindQwenDeveloper} from './qwen-developer-policy.mjs';
import {validateQwenNativeTransfer,validateQwenStoredNativeBundle}
  from './qwen-development-resume.mjs';

const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const admission={authorized:true,issue:2274,role:'developer',
  agent_id:'dev-qwen-01',provider:'claude-code',
  environment:'dev-claude-qwen',task:'implement',
  action_id:'b'.repeat(64),input_sha:'a'.repeat(40),run_id:99002,
  resume_from:{parent_action_id:'c'.repeat(64),ordinal:1,
    checkpoint_version:1,checkpoint_commit_sha:'d'.repeat(40),
    ciphertext_sha256:'e'.repeat(64)}};
const env={ANTHROPIC_MODEL:'qwen3.7-plus',
  ANTHROPIC_BASE_URL:'https://coding.dashscope.aliyuncs.com/apps/anthropic',
  ANTHROPIC_AUTH_TOKEN:'fixture-not-a-real-key'};
const plan=bindQwenDeveloper(admission,registry,env,{cliVersion:'2.1.34'});
const metadata={session_id:'550e8400-e29b-41d4-a716-446655440000',
  source_sha:admission.input_sha,harness_digest:plan.harness_digest,
  project_key:'-workspace',
  cwd_sha256:createHash('sha256').update('/workspace').digest('hex'),
  run_id:88001,attempt:1,cli_version:'2.1.34'};
const record={schema_version:1,kind:'claude-native-encrypted-snapshot',
  metadata,ciphertext_sha256:'f'.repeat(64)};
const bundle={schema_version:1,kind:'qwen-claude-native-envelope',
  rsa_envelope:record,metadata,patch_sha256:'0'.repeat(64),
  action_id:'1'.repeat(64),run_id:metadata.run_id,attempt:metadata.attempt};
const transfer={schema_version:1,kind:'trusted-qwen-native-transfer',
  recipient_run_id:admission.run_id,action_id:admission.action_id,
  continuation:admission.resume_from,metadata,
  ciphertext_sha256:record.ciphertext_sha256};
assert.equal(validateQwenStoredNativeBundle(admission,plan,bundle).session_id,
  metadata.session_id);
assert.equal(validateQwenNativeTransfer(admission,plan,transfer,record).session_id,
  metadata.session_id);
for(const bad of [
  {transfer:{...transfer,action_id:'f'.repeat(64)}},
  {transfer:{...transfer,recipient_run_id:8888}},
  {transfer:{...transfer,metadata:{...metadata,source_sha:'f'.repeat(40)}}},
  {transfer:{...transfer,ciphertext_sha256:'0'.repeat(64)}},
  {record:{...record,metadata:{...metadata,cli_version:'2.1.35'}}},
  {record:{...record,ciphertext_sha256:'0'.repeat(64)}},
  {admission:{...admission,resume_from:{...admission.resume_from,
    checkpoint_version:3}}},
]){
  assert.throws(()=>validateQwenNativeTransfer(bad.admission??admission,
    plan,bad.transfer??transfer,bad.record??record),
    /trusted Qwen native restore|Qwen Developer policy/);
}
for(const bad of [
  {bundle:{...bundle,kind:'forged'}},
  {bundle:{...bundle,metadata:{...metadata,run_id:88002}}},
  {bundle:{...bundle,rsa_envelope:{...record,metadata:{
    ...metadata,source_sha:'0'.repeat(40)}}}},
  {bundle:{...bundle,patch_sha256:'invalid'}},
]){
  assert.throws(()=>validateQwenStoredNativeBundle(admission,plan,bad.bundle),
    /trusted Qwen native restore|Qwen Developer policy/);
}
// Repair changes its target SHA while retaining the original native UUID.
// The model compatibility digest does not change, but the signed parent Run
// and original source SHA must be preserved, never impersonated by the PR head.
const repair={...admission,task:'repair',input_sha:'e'.repeat(40),
  resume_from:{checkpoint_version:1,checkpoint_commit_sha:'d'.repeat(40),
    ciphertext_sha256:'e'.repeat(64),source_sha:admission.input_sha,
    source_run_id:metadata.run_id}};
const repairPlan=bindQwenDeveloper(repair,registry,env,{cliVersion:'2.1.34'});
assert.equal(repairPlan.harness_digest,plan.harness_digest);
assert.equal(validateQwenStoredNativeBundle(repair,repairPlan,bundle).session_id,
  metadata.session_id);
assert.throws(()=>validateQwenStoredNativeBundle({...repair,
  resume_from:{...repair.resume_from,source_run_id:88002}},
  repairPlan,bundle),/Qwen Developer policy/);
console.log('Qwen cross-Run native transfer: pinned immutable UUID, old SHA, Run, model, CLI and repair compatibility verified');
