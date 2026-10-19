#!/usr/bin/env node
// #1664: actual bare-Git CAS Controller initialization without model secrets.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {initializeIssueController} from './controller-start.mjs';
import {startDevelopment,recordDispatch} from './outbox.mjs';
import {writeIssueWorkflowState} from './state-store.mjs';
import {publish} from '../../../run-store-cas-push.mjs';

const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'controller-start-cas-'));
function git(root,...args){
  return execFileSync('git',['-C',root,...args],{
    encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000}).trim();
}
const authority={repository:'BestNathan/nession',event:'workflow_dispatch',
  permission:'write',ref:'refs/heads/main',run_id:245};
const request=issue=>({issue,sha:'a'.repeat(40),developer:'dev-cursor-01',
  reviewer:'review-cursor-01',acceptor:'accept-cursor-01'});
try{
  const remote=path.join(temp,'remote.git'),seed=path.join(temp,'seed');
  fs.mkdirSync(seed);
  git(temp,'init','--bare','remote.git');
  git(seed,'init');
  git(seed,'config','user.name','Controller Fixture');
  git(seed,'config','user.email','controller@example.invalid');
  git(seed,'switch','--orphan','agent-store');
  git(seed,'commit','--allow-empty','-m','agent-store root');
  git(seed,'remote','add','origin',remote);
  git(seed,'push','origin','HEAD:refs/heads/agent-store');
  const root=git(seed,'rev-parse','HEAD');

  assert.throws(()=>initializeIssueController({remote,registry,request:request(3001),
    authority:{...authority,permission:'read'}}),/unauthorized/);
  assert.throws(()=>initializeIssueController({remote,registry,request:{
    ...request(3001),developer:'review-cursor-01'},authority}),/role or ID/);
  assert.throws(()=>initializeIssueController({remote,registry,request:{
    ...request(3001),sha:'main'},authority}),/unauthorized/);
  assert.throws(()=>initializeIssueController({remote,registry,request:request(3001),
    authority:{...authority,ref:'refs/heads/feature'}}),/unauthorized/);
  assert.equal(git(seed,'ls-remote','origin','refs/heads/agent-store').split('\t')[0],root);

  const first=initializeIssueController({remote,registry,request:request(3001),authority});
  assert.equal(first.created,true);
  assert.equal(first.version,1);
  assert.match(first.first_action_id,/^[a-f0-9]{64}$/);
  const repeat=initializeIssueController({remote,registry,request:request(3001),
    authority:{...authority,run_id:246}});
  assert.equal(repeat.created,false);
  assert.equal(repeat.replayed,true);
  assert.equal(repeat.commit_sha,first.commit_sha);
  assert.equal(repeat.first_action_id,first.first_action_id);
  assert.throws(()=>initializeIssueController({remote,registry,request:{
    ...request(3001),sha:'b'.repeat(40)},authority}),/already initialized/);

  // Second Controller began on the same remote head; a distinct Issue may
  // commit before the first candidate is pushed. The single CAS publisher
  // rebases disjoint files and preserves both original immutable roots.
  process.env.NODE_ENV='test';
  let concurrent;
  const second=initializeIssueController({remote,registry,request:request(3002),
    authority:{...authority,run_id:247},onCandidate:()=>{
      concurrent=initializeIssueController({remote,registry,request:request(3003),
        authority:{...authority,run_id:248}});
    }});
  assert.equal(second.created,true);
  assert.equal(concurrent.created,true);
  assert.notEqual(concurrent.commit_sha,second.commit_sha);
  // A later CAS commit for a DIFFERENT Issue does not mutate the original
  // Writer identity returned by an exact idempotent replay.
  const replay3001=initializeIssueController({remote,registry,
    request:request(3001),authority:{...authority,run_id:249}});
  const replay3002=initializeIssueController({remote,registry,
    request:request(3002),authority:{...authority,run_id:250}});
  assert.equal(replay3001.commit_sha,first.commit_sha);
  assert.equal(replay3002.commit_sha,second.commit_sha);
  assert.notEqual(replay3001.commit_sha,second.commit_sha);
  assert.equal(replay3001.replayed,true);
  assert.equal(replay3002.replayed,true);

  git(seed,'fetch','origin','refs/heads/agent-store');
  const committed=git(seed,'rev-parse','FETCH_HEAD');
  assert.equal(committed,second.commit_sha);
  for(const issue of [3001,3002,3003]){
    const head=JSON.parse(git(seed,'show','FETCH_HEAD:workflows/issues/'+issue+'/head.json'));
    assert.equal(head.version,1);
    const saved=JSON.parse(git(seed,'show','FETCH_HEAD:'+head.path));
    assert.equal(saved.issue,issue);
    assert.equal(saved.version,1);
    assert.equal(saved.phase,'ready');
    assert.equal(saved.outbox.length,1);
    assert.equal(saved.outbox[0].status,'pending');
    assert.equal(saved.outbox[0].task.type,'dispatch');
  }
  const files=git(seed,'ls-tree','-r','--name-only','FETCH_HEAD').split('\n');
  assert.equal(files.filter(x=>x.startsWith('workflows/issues/')).length,6);
  assert.ok(files.every(x=>!/private|secret|session|token|\.env/.test(x)));

  // Once Controller progresses, a new manual start cannot reset that Issue.
  const updated=path.join(temp,'advanced');
  git(temp,'clone','--branch','agent-store',remote,updated);
  const original=startDevelopment(registry,request(3001),authority);
  const next=recordDispatch(original,1,original.outbox[0].id,{
    status:'verified',dispatch_id:original.outbox[0].id,source_run_id:5001,
  });
  writeIssueWorkflowState(updated,next,1);
  git(updated,'add','-A');
  git(updated,'-c','user.name=Controller Fixture',
    '-c','user.email=controller@example.invalid',
    'commit','-m','advance Issue 3001 Controller state');
  publish('agent-store',updated,4);
  assert.throws(()=>initializeIssueController({remote,registry,request:request(3001),
    authority}),/already initialized or advanced/);
  const finalSha=git(seed,'ls-remote','origin','refs/heads/agent-store').split('\t')[0];
  assert.notEqual(finalSha,second.commit_sha);
  const replayAfterAdvance=initializeIssueController({remote,registry,
    request:request(3002),authority});
  assert.equal(replayAfterAdvance.replayed,true);
  assert.equal(replayAfterAdvance.commit_sha,second.commit_sha);
  assert.notEqual(replayAfterAdvance.commit_sha,finalSha);
  // The reported origin really introduced THIS Issue's immutable v1 state,
  // and still exists in the linear Store ancestry after unrelated updates.
  assert.equal(git(seed,'show',second.commit_sha+':workflows/issues/3002/head.json')
    .includes('"version": 1'),true);
  assert.equal(git(seed,'merge-base','--is-ancestor',second.commit_sha,finalSha),'');
  console.log('Agent Controller initialization: real orphan CAS, original-commit replay across unrelated writes, disjoint race, scope/role and advanced-state denial passed');
}finally{
  fs.rmSync(temp,{recursive:true,force:true});
}
