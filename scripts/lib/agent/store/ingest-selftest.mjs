import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sealCheckpoint } from './checkpoint.mjs';
import { ingestEncryptedCheckpoint, restoreEncryptedCheckpoint, validateCheckpointSource } from './ingest.mjs';

const registry = JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const identity = {role:'developer',agent_id:'dev-cursor-01',issue:1694};
const source = {
  repository:'BestNathan/nession',run_id:123,attempt:1,issue:1694,
  workflow_sha:'a'.repeat(40),target_sha:'b'.repeat(40),head_branch:'main',
  path:'.github/workflows/agent-develop.yml',workflow_name:'Agent / Development',
  role:'developer',agent_id:'dev-cursor-01',task:'implement',
  environment:'agent-dev-cursor-01',provider:'cursor',event:'workflow_dispatch',
};
const key = Buffer.alloc(32, 7);
const envelope = (version, message) => sealCheckpoint(identity, version, Buffer.from(message), key, {
  provider:'cursor',session_id:'cursor-session-' + version,
  source_sha:source.target_sha,harness_digest:'c'.repeat(64),
});
const first = envelope(1,'SECRET provider-native session data');
assert.deepEqual(validateCheckpointSource(source,first,registry),identity);
const root = fs.mkdtempSync(path.join(os.tmpdir(),'nession-agent-store-'));
try {
  const a = ingestEncryptedCheckpoint(root,source,first,registry,key,0);
  assert.equal(a.version,1);
  assert.equal(a.idempotent,false);
  assert.equal(ingestEncryptedCheckpoint(root,source,first,registry,key,0).idempotent,true);
  const restored = restoreEncryptedCheckpoint(root,identity,{
    provider:'cursor',source_sha:source.target_sha,harness_digest:'c'.repeat(64),
  },key);
  assert.equal(restored.native_bytes.toString(),'SECRET provider-native session data');
  restored.native_bytes.fill(0);
  assert.ok(!fs.readFileSync(path.join(root,first.path),'utf8').includes('SECRET'));
  assert.throws(() => ingestEncryptedCheckpoint(root,{...source,environment:'arbitrary'},first,registry,key,1),/environment/);
  assert.throws(() => ingestEncryptedCheckpoint(root,{...source,agent_id:'review-cursor-01'},first,registry,key,1),/task|role|identity/);
  assert.throws(() => ingestEncryptedCheckpoint(root,{...source,path:'.github/workflows/random.yml'},first,registry,key,1),/untrusted/);
  assert.throws(() => ingestEncryptedCheckpoint(root,{...source,run_id:125},first,registry,key,1),/sequence gap/);
  assert.throws(() => ingestEncryptedCheckpoint(root,source,first,registry,Buffer.alloc(32,9),0),/authentication/);
  assert.throws(() => ingestEncryptedCheckpoint(root,source,{...first,ciphertext:'U0VDUkVU'},registry,key,1),/integrity mismatch/);
  assert.throws(() => restoreEncryptedCheckpoint(root,identity,{
    provider:'cursor',source_sha:source.target_sha,harness_digest:'d'.repeat(64)},key),/compatibility/);
  const second = envelope(2,'SESSION AFTER REVIEW');
  assert.throws(() => ingestEncryptedCheckpoint(root,source,second,registry,key,0),/CAS/);
  assert.equal(ingestEncryptedCheckpoint(root,{...source,run_id:124},second,registry,key,1).version,2);
  assert.equal(restoreEncryptedCheckpoint(root,identity,{
    provider:'cursor',source_sha:source.target_sha,harness_digest:'c'.repeat(64)},key).head.version,2);
  assert.throws(() => ingestEncryptedCheckpoint(root,{...source,run_id:126},second,registry,key,2),/sequence gap/);
  const corrupt = path.join(root,'roles','developer','dev-cursor-01','issues','1694','head.json');
  fs.writeFileSync(corrupt,JSON.stringify({version:900,checkpoint_path:'../../etc/passwd',ciphertext_sha256:'a'.repeat(64)}));
  assert.throws(() => restoreEncryptedCheckpoint(root,identity,{
    provider:'cursor',source_sha:source.target_sha,harness_digest:'c'.repeat(64)},key),/invalid Store head/);
} finally { fs.rmSync(root,{recursive:true,force:true}); }

const symlinkRoot = fs.mkdtempSync(path.join(os.tmpdir(),'nession-agent-store-link-'));
try {
  fs.mkdirSync(path.join(symlinkRoot,'outside'));
  fs.mkdirSync(path.join(symlinkRoot,'roles'));
  fs.symlinkSync(path.join(symlinkRoot,'outside'),path.join(symlinkRoot,'roles','developer'));
  assert.throws(()=>ingestEncryptedCheckpoint(symlinkRoot,source,first,registry,key,0),/unsafe intermediate/);
} finally { fs.rmSync(symlinkRoot,{recursive:true,force:true}); }
console.log('agent Store ingestion, CAS, security and recovery self-test: passed');
