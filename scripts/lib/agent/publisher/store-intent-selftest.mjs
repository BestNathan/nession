#!/usr/bin/env node
// Disposable real bare Git remote: immutable write-ahead intent must commit
// before a Publisher has any permission to create a GitHub branch or PR.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {classifyRunStorePath} from '../../../run-store-integrity.mjs';
import {planControlledPublisherIntent,validateControlledPublisherIntent,
  commitControlledPublisherIntent,CONTROLLED_PUBLISHER_INTENT_PATH,
  CONTROLLED_PUBLISHER_BRANCH} from './store-intent.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'nession-publisher-store-test-'));
const bare=path.join(root,'bare.git'),work=path.join(root,'local');
function git(...args){
  return execFileSync('git',args,{encoding:'utf8',cwd:root,timeout:45000,
    stdio:['ignore','pipe','pipe']}).trim();
}
const args={
  target_main_sha:'a'.repeat(40),patch_sha256:'b'.repeat(64),
  issuer_run_id:50001,
};
try{
  const intent=planControlledPublisherIntent(args);
  assert.equal(validateControlledPublisherIntent(intent),intent);
  assert.equal(Object.keys(intent).length,20);
  assert.equal(intent.kind,'trusted_publisher_write_ahead_intent');
  assert.equal(intent.publication,'not_yet_attested');
  assert.equal(intent.branch,CONTROLLED_PUBLISHER_BRANCH);
  assert.equal(classifyRunStorePath('agent-store',
    CONTROLLED_PUBLISHER_INTENT_PATH),'immutable');
  assert.deepEqual(planControlledPublisherIntent(args),intent);
  for(const patch of [
    {kind:'forged'},{issue:1664},{action_id:'f'.repeat(64)},
    {worker_run_id:4},{worker_run_attempt:2},
    {checkpoint_version:4},{checkpoint_commit_sha:'f'.repeat(40)},
    {checkpoint_ciphertext_sha256:'f'.repeat(64)},
    {source_claim_artifact_id:0},{source_result_artifact_id:7},
    {source_ingest_run_id:123},{branch:'agent/untrusted'},
    {publication:'published'},{publisher_issuer_run_id:0},
    {unexpected:'writer'}, {schema_version:2},
  ])assert.throws(()=>validateControlledPublisherIntent({...intent,...patch}),
    /untrusted/);
  for(const patch of [
    {target_main_sha:'main'},{patch_sha256:'bad'},
    {issuer_run_id:0},{issuer_run_id:-1},
  ])assert.throws(()=>planControlledPublisherIntent({...args,...patch}),
    /invalid authenticated publisher request/);
  git('init','--bare','-q',bare);
  git('clone','-q',bare,work);
  git('-C',work,'config','user.name','Trusted Publisher Test');
  git('-C',work,'config','user.email','publisher@example.invalid');
  git('-C',work,'checkout','-qb','agent-store');
  const fixtures=path.join('scripts','lib','agent','publisher','fixtures');
  const prefix=path.join(work,'workflows','issues','1997');
  fs.mkdirSync(path.join(prefix,'states'),{recursive:true});
  fs.copyFileSync(path.join(fixtures,'1997-v16-state.json'),
    path.join(prefix,'states','00000016.json'));
  fs.copyFileSync(path.join(fixtures,'1997-v16-head.json'),
    path.join(prefix,'head.json'));
  git('-C',work,'add','-A');
  git('-C',work,'commit','-qm','original authenticated #1997 v16 metadata');
  git('-C',work,'push','-q','origin','agent-store');
  const before=git('--git-dir',bare,'rev-parse','refs/heads/agent-store');
  const result=commitControlledPublisherIntent({remote:bare,...args});
  assert.equal(result.status,'committed');
  assert.equal(result.may_publish,true);
  assert.equal(result.path,CONTROLLED_PUBLISHER_INTENT_PATH);
  assert.deepEqual(result.record,intent);
  assert.match(result.store_commit_sha,/^[a-f0-9]{40}$/);
  assert.notEqual(result.store_commit_sha,before);
  assert.equal(git('--git-dir',bare,'rev-parse','refs/heads/agent-store'),
    result.store_commit_sha);
  const after=path.join(root,'checked');
  git('clone','-q','--single-branch','--branch','agent-store',bare,after);
  const actual=JSON.parse(fs.readFileSync(
    path.join(after,CONTROLLED_PUBLISHER_INTENT_PATH),'utf8'));
  assert.deepEqual(actual,intent);
  assert.equal(git('-C',after,'show',result.store_commit_sha+':'+
    CONTROLLED_PUBLISHER_INTENT_PATH).length>0,true);
  const replay=commitControlledPublisherIntent({remote:bare,...args});
  assert.equal(replay.status,'reconcile');
  assert.equal(replay.may_publish,false);
  assert.equal(replay.store_commit_sha,result.store_commit_sha);
  assert.deepEqual(replay.record,intent);
  for(const patch of [
    {target_main_sha:'c'.repeat(40)},
    {patch_sha256:'d'.repeat(64)},
    {issuer_run_id:50002},
  ])assert.throws(()=>commitControlledPublisherIntent({
    remote:bare,...args,...patch,
  }),/conflicting immutable publish replay/);
  assert.equal(git('--git-dir',bare,'rev-parse','refs/heads/agent-store'),
    result.store_commit_sha,'conflicting replays must never mutate Store');
  assert.throws(()=>commitControlledPublisherIntent({
    remote:'not-a-valid store repo',...args,
  }),/invalid scoped authenticated Store remote/);
  console.log('Trusted Publisher CAS: real immutable orphan Git write-ahead, one allowed publication, readback, at-most-once reconcile, wrong SHA/Run/issuer replay denial passed; no GitHub PR or model invocation');
}finally{fs.rmSync(root,{recursive:true,force:true});}
