#!/usr/bin/env node
// Real local bare Git remote: checkpoint payload + pointer must be one linear,
// no-force remote commit, with deterministic replay and competing writer denial.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {sealCheckpoint} from './checkpoint.mjs';
import {publishEncryptedAgentCheckpoint,fetchEncryptedAgentCheckpoint} from './remote.mjs';
import {startDevelopment} from '../orchestration/outbox.mjs';

const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const identity={role:'developer',agent_id:'dev-cursor-01',issue:1664};
const key=Buffer.alloc(32,42);
const source={
  repository:'BestNathan/nession',run_id:43221,attempt:1,issue:1664,
  workflow_sha:'a'.repeat(40),target_sha:'b'.repeat(40),head_branch:'main',
  path:'.github/workflows/agent-develop.yml',workflow_name:'Agent / Development',
  role:'developer',agent_id:'dev-cursor-01',task:'implement',
  environment:'agent-dev-cursor-01',provider:'cursor',event:'workflow_dispatch',
};
function envelope(version,message){
  return sealCheckpoint(identity,version,Buffer.from(message),key,{
    provider:'cursor',session_id:'cursor-native-'+version,
    source_sha:source.target_sha,harness_digest:'c'.repeat(64),
  });
}
function git(root,...args){
  return execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],
    maxBuffer:1024*1024,timeout:30000}).trim();
}
function test() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-store-live-'));
  try{
    const remote=path.join(root,'remote.git'),seed=path.join(root,'seed');
    fs.mkdirSync(seed);
    git(root,'init','--bare','remote.git');
    git(seed,'init');
    git(seed,'config','user.email','fixture@example.invalid');
    git(seed,'config','user.name','Store Fixture');
    git(seed,'switch','--orphan','agent-store');
    git(seed,'commit','--allow-empty','-m','agent-store bootstrap');
    git(seed,'remote','add','origin',remote);
    git(seed,'push','origin','HEAD:refs/heads/agent-store');
    const baseline=git(seed,'rev-parse','HEAD');
    const first=envelope(1,'secret native session v1');
    const initialState=startDevelopment(registry,{
      issue:1664,sha:source.target_sha,developer:'dev-cursor-01',
      reviewer:'review-cursor-01',acceptor:'accept-cursor-01',
    },{repository:'BestNathan/nession',event:'workflow_dispatch',
      permission:'write',ref:'refs/heads/main',run_id:source.run_id});
    const published=publishEncryptedAgentCheckpoint({
      remote,source,sealed:first,registry,key,expectedVersion:0,
      workflowState:initialState,expectedWorkflowVersion:0,
    });
    assert.equal(published.version,1);
    assert.equal(published.workflow_version,1);
    git(seed,'fetch','origin','refs/heads/agent-store');
    const stateHead=JSON.parse(git(seed,'show',
      'FETCH_HEAD:workflows/issues/1664/head.json'));
    assert.equal(stateHead.version,1,'Workflow head and checkpoint were committed together');
    assert.equal(JSON.parse(git(seed,'show','FETCH_HEAD:'+stateHead.path)).issue,1664);
    assert.equal(published.replayed,false);
    assert.notEqual(published.commit_sha,baseline);
    const restored=fetchEncryptedAgentCheckpoint({remote,identity,key,
      expected:{provider:'cursor',source_sha:source.target_sha,harness_digest:'c'.repeat(64)}});
    assert.equal(restored.head.version,1);
    assert.equal(restored.commit_sha,published.commit_sha);
    assert.equal(restored.native_bytes.toString(),'secret native session v1');
    restored.native_bytes.fill(0);
    assert.deepEqual(publishEncryptedAgentCheckpoint({
      remote,source,sealed:first,registry,key,expectedVersion:0,
      workflowState:initialState,expectedWorkflowVersion:0,
    }).replayed,true);
    assert.throws(()=>publishEncryptedAgentCheckpoint({
      remote,source:{...source,run_id:43222},sealed:envelope(2,'bad workflow'),
      registry,key,expectedVersion:1,workflowState:{...initialState,version:99},
      expectedWorkflowVersion:1,
    }),/noncontiguous workflow state/);
    assert.throws(()=>publishEncryptedAgentCheckpoint({
      remote,source:{...source,run_id:43222},sealed:envelope(2,'cross issue'),
      registry,key,expectedVersion:1,workflowState:{...initialState,issue:999},
      expectedWorkflowVersion:1,
    }),/different Issue/);
    assert.equal(git(seed,'ls-remote','origin','refs/heads/agent-store').split('\t')[0],
      published.commit_sha,'failed atomic staging must not mutate remote ref');
    assert.throws(()=>publishEncryptedAgentCheckpoint({
      remote,source:{...source,run_id:999},sealed:first,registry,key,expectedVersion:0,
    }),/stale Store CAS/);
    assert.throws(()=>publishEncryptedAgentCheckpoint({
      remote,source:{...source,repository:'untrusted/fork'},sealed:first,registry,key,expectedVersion:1,
    }),/invalid trusted source/);
    const second=envelope(2,'secret native session v2');
    const competing=envelope(2,'competing native session v2');
    let competitor;
    process.env.NODE_ENV='test';
    assert.throws(()=>publishEncryptedAgentCheckpoint({
      remote,source:{...source,run_id:43222},sealed:second,registry,key,expectedVersion:1,
      onCandidate:()=>{
        competitor=publishEncryptedAgentCheckpoint({remote,
          source:{...source,run_id:43223},sealed:competing,registry,key,expectedVersion:1});
      },
    }),/divergent record|collision|CAS/);
    assert.equal(competitor.version,2);
    assert.equal(competitor.replayed,false);
    const after=fetchEncryptedAgentCheckpoint({remote,identity,key,
      expected:{provider:'cursor',source_sha:source.target_sha,harness_digest:'c'.repeat(64)}});
    assert.equal(after.head.version,2);
    assert.equal(after.native_bytes.toString(),'competing native session v2');
    after.native_bytes.fill(0);
    const history=git(seed,'--no-pager','ls-remote','origin','refs/heads/agent-store');
    assert.match(history,/^[a-f0-9]{40}\trefs\/heads\/agent-store$/);
    const current=history.split('\t')[0];
    assert.equal(current,competitor.commit_sha);
    assert.notEqual(current,baseline);
    assert.throws(()=>fetchEncryptedAgentCheckpoint({remote,identity,key:Buffer.alloc(32,7),
      expected:{provider:'cursor',source_sha:source.target_sha,harness_digest:'c'.repeat(64)}}),
      /authentication/);
    console.log('Agent Store remote CAS: real bare ref commit, replay, restore and competing writer denied');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
try{test();}finally{key.fill(0);}
