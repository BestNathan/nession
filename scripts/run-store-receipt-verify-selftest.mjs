#!/usr/bin/env node
// #1690: offline read-only receipt verification fixtures; no production refs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import {verifyRunStoreReceipt} from './run-store-receipt-verify.mjs';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'nession-receipt-audit-'));
const git=(...args)=>execFileSync('git',['-C',home,...args],{
  encoding:'utf8',stdio:['ignore','pipe','pipe'],
}).trim();
const sha256=value=>crypto.createHash('sha256').update(value).digest('hex');
const read=()=>JSON.parse(JSON.stringify(receipt));
const write=(filename,text)=>{
  const f=path.join(home,filename);
  fs.mkdirSync(path.dirname(f),{recursive:true});
  fs.writeFileSync(f,text);
  git('add','--',filename);
};
let receipt;
try{
  git('init','-q');
  git('config','user.name','nession-receipt-test');
  git('config','user.email','nession-receipt-test@example.invalid');
  write('README.md','# disposable audit fixture\n');
  git('commit','-qm','root');
  const root=git('rev-parse','HEAD');
  const one='{"test":true}\n';
  const index='{"source":"trusted"}\n';
  write('runs/2026-10-15/111-1/SC-04.json',one);
  write('indexes/by-sha/'+'a'.repeat(40)+'/test.json',index);
  git('commit','-qm','publish two records');
  const published=git('rev-parse','HEAD');
  receipt={
    schema_version:1,kind:'run_store_post_commit_receipt',
    trust_level:'trusted_workflow_artifact_not_independent_anchor',
    status:'published',ref:'refs/heads/acceptance-results',
    store:'acceptance-results',commit_sha:published,
    ingester:{repository:'BestNathan/nession',run_id:'777',attempt:'2',
      workflow_ref:'BestNathan/nession/.github/workflows/acceptance-case-ingest.yml@refs/heads/main',
      tool_sha:'b'.repeat(40)},
    source:{workflow_id:'123',workflow_path:'.github/workflows/acceptance-cases.yml',
      repository:'BestNathan/nession',run_id:'111',attempt:'1',
      target_sha:'a'.repeat(40),event:'push'},
    records:[
      {path:'runs/2026-10-15/111-1/SC-04.json',sha256:sha256(one)},
      {path:'indexes/by-sha/'+'a'.repeat(40)+'/test.json',sha256:sha256(index)},
    ],
  };
  const ok=verifyRunStoreReceipt(read(),home,{expectedStore:'acceptance-results'});
  assert.equal(ok.checked_records,2);
  assert.equal(ok.changed_records,2);
  assert.equal(ok.commit_sha,published);
  const duplicate=read();
  duplicate.records.push({...duplicate.records[0]});
  assert.throws(()=>verifyRunStoreReceipt(duplicate,home),/duplicate record hash key/);
  const tampered=read();tampered.records[0].sha256='c'.repeat(64);
  assert.throws(()=>verifyRunStoreReceipt(tampered,home),/record bytes differ/);
  const repointed=read();repointed.commit_sha=root;
  assert.throws(()=>verifyRunStoreReceipt(repointed,home),/record missing/);
  const foreign=read();foreign.ingester.repository='untrusted/fork';
  assert.throws(()=>verifyRunStoreReceipt(foreign,home),/unexpected ingester repository/);
  const arbitrary=read();arbitrary.ingester.workflow_ref='BestNathan/nession/.github/workflows/untrusted.yml@refs/heads/feature';
  assert.throws(()=>verifyRunStoreReceipt(arbitrary,home),/invalid ingester workflow ref/);
  const wrongRef=read();wrongRef.ref='refs/heads/task-results';
  assert.throws(()=>verifyRunStoreReceipt(wrongRef,home),/unexpected ref/);
  const wrongStore=read();
  assert.throws(()=>verifyRunStoreReceipt(wrongStore,home,{expectedStore:'metrics'}),/unexpected run store/);
  const unsafe=read();unsafe.records[0].path='../private-secret.txt';
  assert.throws(()=>verifyRunStoreReceipt(unsafe,home),/unsafe Git tree path/);
  const forgedSource=read();forgedSource.source.target_sha='not-a-sha';
  assert.throws(()=>verifyRunStoreReceipt(forgedSource,home),/invalid source target SHA/);
  const badEvent=read();badEvent.source.event='attacker';
  assert.throws(()=>verifyRunStoreReceipt(badEvent,home),/invalid source event/);
  const empty=read();empty.records=[];
  assert.throws(()=>verifyRunStoreReceipt(empty,home),/missing\/excessive record hashes/);
  // Receipt file exists but branch was reset/replaced; Git objects alone are
  // not sufficient if the observed authoritative ref has moved elsewhere.
  git('reset','--hard',root);
  assert.throws(()=>verifyRunStoreReceipt(read(),home),/not in observed store ancestry/);
  git('reset','--hard',published);
  const retry=read();retry.status='idempotent-replay';
  assert.equal(verifyRunStoreReceipt(retry,home).checked_records,2);
  // Binary/symlink modes must never masquerade as regular record blobs.
  const symlink='runs/2026-10-15/111-1/symlink.json';
  fs.symlinkSync('/etc/passwd',path.join(home,symlink));
  git('add','--',symlink);git('commit','-qm','unsafe symlink fixture');
  const symlinkReceipt=read();symlinkReceipt.commit_sha=git('rev-parse','HEAD');
  symlinkReceipt.records=[{path:symlink,sha256:sha256('/etc/passwd')}];
  assert.throws(()=>verifyRunStoreReceipt(symlinkReceipt,home),/non-regular or mismatched Git tree entry/);
  console.log('Run Store receipt readback: real Git blob SHA-256, ancestry, forged commit/source/ref, duplicate, symlink and cross-store negatives passed');
}finally{fs.rmSync(home,{recursive:true,force:true});}
