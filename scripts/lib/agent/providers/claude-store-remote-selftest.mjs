#!/usr/bin/env node
// Real bare Git ref fixture: Claude RSA-native snapshot -> existing trusted
// AES checkpoint + remote CAS -> independent native restore from exact ref.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {sealClaudeNativeSession} from './claude-native-store.mjs';
import {publishClaudeNativeCheckpoint,restoreClaudeNativeCheckpoint}
  from './claude-store-bridge.mjs';

const SESSION='550e8400-e29b-41d4-a716-446655440000';
function git(folder,...args){
  return execFileSync('git',['-C',folder,...args],{
    encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000}).trim();
}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-store-cas-'));
const storeKey=Buffer.alloc(32,73);
try{
  const remote=path.join(root,'remote.git'),local=path.join(root,'bootstrap');
  fs.mkdirSync(local);
  git(root,'init','--bare','remote.git');
  git(local,'init');
  git(local,'config','user.name','Claude Store Contract');
  git(local,'config','user.email','fixture@example.invalid');
  git(local,'switch','--orphan','agent-store');
  git(local,'commit','--allow-empty','-m','agent-store bootstrap fixture');
  git(local,'remote','add','origin',remote);
  git(local,'push','origin','HEAD:refs/heads/agent-store');

  const configDir=path.join(root,'native-seed');
  const projectKey='-home-runner-work-nession-nession';
  const project=path.join(configDir,'projects',projectKey);
  fs.mkdirSync(project,{recursive:true});
  fs.writeFileSync(path.join(project,SESSION+'.jsonl'),JSON.stringify({
    type:'user',sessionId:SESSION,message:{content:'HIGHLY PRIVATE CLAUDE SESSION'},
  })+'\n');
  const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,
    publicKeyEncoding:{format:'pem',type:'spki'},
    privateKeyEncoding:{format:'pem',type:'pkcs8'}});
  const metadata={session_id:SESSION,source_sha:'a'.repeat(40),
    harness_digest:'b'.repeat(64),project_key:projectKey,
    cwd_sha256:'c'.repeat(64),run_id:9123,attempt:1,cli_version:'2.1.248'};
  const envelope=sealClaudeNativeSession({configDir,metadata,publicKeyPem:publicKey});
  const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
  const source={repository:'BestNathan/nession',run_id:9123,attempt:1,issue:1664,
    workflow_sha:'d'.repeat(40),target_sha:metadata.source_sha,head_branch:'main',
    path:'.github/workflows/agent-develop.yml',workflow_name:'Agent / Development',
    role:'developer',agent_id:'dev-qwen-01',task:'implement',
    environment:'dev-claude-qwen',provider:'claude-code',event:'workflow_dispatch'};
  const pub=publishClaudeNativeCheckpoint({remote,source,nativeEnvelope:envelope,
    registry,storeKey,expectedVersion:0});
  assert.equal(pub.version,1);
  assert.equal(pub.replayed,false);
  const identity={role:source.role,agent_id:source.agent_id,issue:source.issue};
  const recovered=restoreClaudeNativeCheckpoint({remote,identity,storeKey,
    privateKeyPem:privateKey,expectedMetadata:metadata,
    configDir:path.join(root,'native-resumed')});
  assert.equal(recovered.session_id,SESSION);
  assert.equal(recovered.head.version,1);
  assert.equal(recovered.commit_sha,pub.commit_sha);
  const text=fs.readFileSync(path.join(root,'native-resumed','projects',projectKey,
    SESSION+'.jsonl'),'utf8');
  assert.ok(text.includes('HIGHLY PRIVATE CLAUDE SESSION'));
  const gitObject=git(local,'ls-remote','origin','refs/heads/agent-store').split('\t')[0];
  assert.equal(gitObject,pub.commit_sha);
  git(local,'fetch','origin','agent-store');
  const records=git(local,'ls-tree','-r','--name-only','FETCH_HEAD');
  assert.ok(records.includes('roles/developer/dev-qwen-01/issues/1664/'));
  for(const filepath of records.split('\n').filter(Boolean)){
    const raw=git(local,'show','FETCH_HEAD:'+filepath);
    assert.ok(!raw.includes('HIGHLY PRIVATE CLAUDE SESSION'),
      'native plaintext must not enter a public Git blob');
  }
  assert.throws(()=>restoreClaudeNativeCheckpoint({remote,identity,storeKey,
    privateKeyPem:privateKey,expectedMetadata:{...metadata,harness_digest:'e'.repeat(64)},
    configDir:path.join(root,'stale-harness')}),/compatibility mismatch/);
  assert.throws(()=>publishClaudeNativeCheckpoint({remote,
    source:{...source,run_id:9124},nativeEnvelope:envelope,registry,
    storeKey,expectedVersion:0}),/stale Store CAS/);
  console.log('Claude native Store: real remote CAS, ciphertext-only blobs, bounded resume and stale denial passed');
} finally {storeKey.fill(0);fs.rmSync(root,{recursive:true,force:true});}
