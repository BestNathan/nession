#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {prepareBoundedPublisherProposal} from './controlled-proposal.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const contents='Durable Worker fixture: complete\nPrevious value: pending\n';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nession-publisher-source-'));
const repo=path.join(root,'repo');
fs.mkdirSync(repo);
const git=(...args)=>execFileSync('git',['-C',repo,...args],{
  encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe'],
}).trim();
try{
  git('init','-q');
  git('config','user.name','Source Fixture');
  git('config','user.email','test@example.invalid');
  fs.writeFileSync(path.join(repo,'README.md'),'exact source\n');
  git('add','README.md');
  git('commit','-qm','controlled native source');
  const source=git('rev-parse','HEAD');
  const policy={
    issue:1997,action_id:'c'.repeat(64),run_id:39448549052,attempt:1,
    worker_sha:'b'.repeat(40),source_sha:source,
    file:'e2e/fixtures/agent-development/1997-canary.txt',content:contents,
    parent_checkpoint_commit_sha:'d'.repeat(40),
    checkpoint_version:3,checkpoint_commit_sha:'e'.repeat(40),
    checkpoint_ciphertext_sha256:'f'.repeat(64),
    ingester_run_id:39465467460,ingester_sha:'a'.repeat(40),
  };
  const result={
    schema_version:1,kind:'developer_proposal',
    issue:1997,action_id:policy.action_id,run_id:policy.run_id,attempt:1,
    source_sha:source,status:'proposed_not_published',
    native_read_edit_verified:true,native_resumed:true,prior_turn_word_observed:true,
    parent_checkpoint_commit_sha:policy.parent_checkpoint_commit_sha,
    file:policy.file,content_sha256:sha(contents),
    issue_sync:{body_sha256:'1'.repeat(64),comments_sha256:'2'.repeat(64),
      last_comment_id:21,updated_at:'2026-10-20T15:00:00Z'},
  };
  const receipt={
    schema_version:1,kind:'authenticated_development_checkpoint_receipt',
    status:'yielded',issue:1997,action_id:policy.action_id,
    run_id:policy.run_id,attempt:1,worker_sha:policy.worker_sha,source_sha:source,
    ingester_run_id:policy.ingester_run_id,ingester_sha:policy.ingester_sha,
    claim_artifact_id:11,claim_artifact_digest:'sha256:'+'3'.repeat(64),
    result_artifact_id:12,result_artifact_digest:'sha256:'+'4'.repeat(64),
    checkpoint_version:3,checkpoint_commit_sha:policy.checkpoint_commit_sha,
    ciphertext_sha256:policy.checkpoint_ciphertext_sha256,
    session_id:'agent-real-native-fixture',harness_digest:'5'.repeat(64),
  };
  const subject={checkout:repo,policy,result,receipt};
  const first=prepareBoundedPublisherProposal(subject);
  const second=prepareBoundedPublisherProposal(subject);
  assert.deepEqual(first,second,'identical source replay must not change preflight');
  assert.equal(first.status,'preflight_only');
  assert.equal(first.kind,'trusted_publisher_preflight_only');
  assert.equal(first.worker_run_id,policy.run_id);
  assert.equal(first.source_result_sha256,sha(contents));
  assert.equal(first.preflight.files.length,1);
  assert.equal(first.preflight.files[0].operation,'create');
  assert.equal(first.preflight.files[0].old_bytes,0);
  assert.equal(first.preflight.files[0].new_sha256,sha(contents));
  assert.equal(first.patch_sha256,sha(first.patch));
  assert.equal(git('status','--porcelain'),'');
  assert.equal(fs.existsSync(path.join(repo,policy.file)),false);
  const deny=(modified,pattern)=>assert.throws(()=>
    prepareBoundedPublisherProposal({...subject,...modified}),pattern);
  for(const patch of [
    {kind:'unexpected'}, {native_read_edit_verified:false},
    {native_resumed:false}, {prior_turn_word_observed:false},
    {action_id:'0'.repeat(64)}, {source_sha:'0'.repeat(40)},
    {run_id:9999}, {attempt:2}, {issue:1664},
    {status:'already_published'}, {file:'README.md'},
    {content_sha256:sha('forged')},
    {parent_checkpoint_commit_sha:'1'.repeat(40)},
    {issue_sync:{body_sha256:null,comments_sha256:'2'.repeat(64)}},
  ])deny({result:{...result,...patch}},/mismatched|no proven/);
  for(const patch of [
    {status:'in_progress'},{source_sha:'f'.repeat(40)},
    {worker_sha:'a'.repeat(40)},{action_id:'0'.repeat(64)},
    {run_id:6},{attempt:2},{ingester_run_id:0},{checkpoint_version:2},
    {checkpoint_commit_sha:'0'.repeat(40)},{ciphertext_sha256:'0'.repeat(64)},
    {claim_artifact_digest:'forged'},{result_artifact_digest:'forged'},
    {harness_digest:null},{session_id:'forged'},
  ])deny({receipt:{...receipt,...patch}},/mismatched|missing trusted/);
  deny({policy:{...policy,file:'.github/workflows/ci.yml'}},/MAIN-owned/);
  deny({policy:{...policy,content:'Forged new file\n'}},/MAIN-owned/);
  deny({policy:{...policy,source_sha:'f'.repeat(40)}},/mismatched/);
  deny({policy:{...policy,action_id:'0'.repeat(64)}},/mismatched/);
  deny({policy:{...policy,checkpoint_ciphertext_sha256:'0'.repeat(64)}},
    /mismatched/);
  deny({checkout:path.join(repo,'not-the-source')},/unreadable/);
  const target=path.join(repo,policy.file);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.symlinkSync('/absent-nession-native-proposal',target);
  deny({},/target already exists or is a symlink/);
  fs.unlinkSync(target);
  fs.rmSync(path.join(repo,'e2e'),{recursive:true,force:true});
  console.log('Bounded Publisher proposal: exact authenticated receipt, trusted bytes, replay, SHA/role/Issue/Artifact and symlink denies passed; no PR/write');
}finally{
  fs.rmSync(root,{recursive:true,force:true});
}
