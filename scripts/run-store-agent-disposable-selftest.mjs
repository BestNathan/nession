#!/usr/bin/env node
// #1690 SC-10: entirely disposable agent-store Git/CAS fixture.
// Demonstrates ONLY a sealed-reference Git payload. The real agent-store
// format, key custody, Ruleset, and publisher identity remain owned by #1664.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {auditAnchoredRunStore, auditStagedRunStore} from './run-store-integrity.mjs';
import {publish} from './run-store-cas-push.mjs';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'nession-agent-store-disposable-'));
const store='agent-store';
const basePath='roles/developer/test-agent-01/issues/1664/';
const checkpoint=v=>basePath+'checkpoints/'+String(v).padStart(8,'0')+'.json';
const head=basePath+'head.json';
const key=crypto.randomBytes(32); // never serialized, logged or committed
const secret=crypto.randomBytes(48).toString('hex');
const plaintext=Buffer.from(JSON.stringify({private_session:secret,confidential_prompt:secret}));
function git(cwd,...args){
  return execFileSync('git',['-C',cwd,...args],{
    encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:4*1024*1024,
  }).trim();
}
function sealedRecord(version){
  const nonce=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  const env={schema_version:1,kind:'sealed_agent_checkpoint_fixture',
    version,algorithm:'aes-256-gcm',
    nonce_b64:nonce.toString('base64'),
    tag_b64:cipher.getAuthTag().toString('base64'),
    ciphertext_b64:ciphertext.toString('base64')};
  assert.ok(!JSON.stringify(env).includes(secret));
  const decrypt=crypto.createDecipheriv('aes-256-gcm',key,
    Buffer.from(env.nonce_b64,'base64'));
  decrypt.setAuthTag(Buffer.from(env.tag_b64,'base64'));
  assert.deepEqual(Buffer.concat([
    decrypt.update(Buffer.from(env.ciphertext_b64,'base64')),decrypt.final()]),plaintext);
  return JSON.stringify(env)+'\n';
}
function write(repo,file,bytes){
  const to=path.join(repo,file);
  fs.mkdirSync(path.dirname(to),{recursive:true});
  fs.writeFileSync(to,bytes);
}
function commit(repo,msg){
  git(repo,'add','-A');
  assert.ok(auditStagedRunStore(repo,store).checked_changes>0);
  git(repo,'commit','-qm',msg);
  return git(repo,'rev-parse','HEAD');
}
function clone(remote,label){
  const cwd=path.join(home,label);
  execFileSync('git',['clone','-q','-b',store,remote,cwd],{stdio:'pipe'});
  git(cwd,'config','user.name','nession-disposable-fixture');
  git(cwd,'config','user.email','fixture@example.invalid');
  return cwd;
}
function pointer(version){
  return JSON.stringify({schema_version:1,kind:'agent_store_cas_pointer_fixture',
    checkpoint:checkpoint(version),version})+'\n';
}
function noPlaintext(repo){
  const tracked=git(repo,'ls-tree','-r','--name-only','HEAD').split('\n').filter(Boolean);
  assert.ok(tracked.length>0);
  for(const file of tracked){
    const bytes=execFileSync('git',['-C',repo,'show','HEAD:'+file]);
    assert.ok(!bytes.includes(secret),'agent-store public Git leaked private session bytes');
    assert.ok(!bytes.includes(Buffer.from(secret)),
      'agent-store Git contains unencrypted private session data');
  }
  const gitConfig=git(repo,'config','--get','remote.origin.url');
  assert.ok(!gitConfig.includes(secret));
}
function protectAgainstOverwrites(remote){
  const edit=clone(remote,'illegal-edit');
  write(edit,checkpoint(1),sealedRecord(17));
  git(edit,'add','-A');
  assert.throws(()=>auditStagedRunStore(edit,store),/forbidden agent-store M/);
  git(edit,'commit','-qm','malicious immutable edit');
  assert.throws(()=>publish(store,edit),/forbidden agent-store M/);
  const remove=clone(remote,'illegal-remove');
  fs.unlinkSync(path.join(remove,checkpoint(1)));
  git(remove,'add','-A');
  assert.throws(()=>auditStagedRunStore(remove,store),/forbidden agent-store D/);
  git(remove,'commit','-qm','malicious immutable delete');
  assert.throws(()=>publish(store,remove),/forbidden agent-store D/);
}
try{
  const remote=path.join(home,'disposable-agent.git');
  fs.mkdirSync(remote);
  git(remote,'init','--bare','-q');
  const seed=path.join(home,'seed');
  fs.mkdirSync(seed);
  git(seed,'init','-q');
  git(seed,'config','user.name','nession-disposable-fixture');
  git(seed,'config','user.email','fixture@example.invalid');
  git(seed,'remote','add','origin',remote);
  write(seed,checkpoint(1),sealedRecord(1));
  write(seed,head,pointer(1));
  const baseline=commit(seed,'disposable encrypted bootstrap (not a production anchor)');
  git(seed,'push','-q','origin','HEAD:refs/heads/'+store);
  const a=clone(remote,'publisher-a'),b=clone(remote,'publisher-b');
  write(a,checkpoint(2),sealedRecord(2));
  write(a,head,pointer(2));
  commit(a,'authorized CAS append version 2');
  write(b,checkpoint(3),sealedRecord(3));
  write(b,head,pointer(3));
  commit(b,'stale CAS append version 3');
  const first=publish(store,a);
  assert.equal(first.replayed,false);
  noPlaintext(a);
  assert.throws(()=>publish(store,b),/divergent record, index or projection collision/);
  assert.equal(git(remote,'rev-parse','refs/heads/'+store),first.commit_sha);
  const updated=clone(remote,'publisher-updated');
  write(updated,checkpoint(3),sealedRecord(3));
  write(updated,head,pointer(3));
  commit(updated,'authorized CAS retry after refreshing expected head');
  const second=publish(store,updated);
  assert.equal(second.replayed,false);
  assert.equal(git(updated,'show','HEAD:'+head).trim(),
    JSON.stringify({schema_version:1,kind:'agent_store_cas_pointer_fixture',
      checkpoint:checkpoint(3),version:3}));
  noPlaintext(updated);
  const audited=auditAnchoredRunStore(updated,store,baseline,second.commit_sha);
  assert.equal(audited.checked_commits,2);
  assert.equal(audited.checked_changes,4);
  protectAgainstOverwrites(remote);
  // Ref deletion / init bypass must also fail safely without re-rooting.
  const missing=clone(remote,'deleted-ref-publisher');
  write(missing,checkpoint(4),sealedRecord(4));
  write(missing,head,pointer(4));
  commit(missing,'must not recreate a deleted public ref');
  git(remote,'update-ref','-d','refs/heads/'+store);
  assert.throws(()=>publish(store,missing),/remote ref missing/);
  console.log('agent-store disposable CAS: AES-GCM sealed refs, authorized pointer v1->v2->v3, stale CAS rejection, immutable update/deletion refusal, Git plaintext absence and deleted ref fail-closed passed');
}finally{
  key.fill(0);
  plaintext.fill(0);
  fs.rmSync(home,{recursive:true,force:true});
}
