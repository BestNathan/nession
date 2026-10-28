#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {stagingSeedMetadata} from './claude-resume-fixture.mjs';
import {sealCheckpoint} from '../store/checkpoint.mjs';
import {validateCheckpointSource} from '../store/ingest.mjs';
import {readCheckpointHeadVersion} from '../store/remote.mjs';

const base={sourceSha:'a'.repeat(40),runId:7001,attempt:1,
  sessionId:'11111111-1111-4111-8111-111111111111',
  projectKey:'-Users-runner-work-nession',cliVersion:'2.1.312',
  model:'qwen3.7-plus',dispatchId:'d'.repeat(64),cwdSha:'c'.repeat(64)};
const value=stagingSeedMetadata(base);
assert.equal(value.source_sha,base.sourceSha);
assert.equal(value.model,'qwen3.7-plus');
assert.equal(value.issue,2319);
assert.equal(value.agent_id,'dev-qwen-01');
assert.equal(value.dispatch_id,base.dispatchId);
assert.match(value.harness_digest,/^[a-f0-9]{64}$/);
// The harness digest binds the model: a later default switch cannot reuse it.
assert.notEqual(stagingSeedMetadata({...base,model:'qwen3.7-max'}).harness_digest,
  value.harness_digest);
assert.notEqual(stagingSeedMetadata({...base,cliVersion:'2.1.313'}).harness_digest,
  value.harness_digest);
for(const [change,error] of [
  [{sourceSha:'short'},/invalid staging seed metadata/],
  [{runId:0},/invalid staging seed metadata/],
  [{attempt:2},/invalid staging seed metadata/],
  [{sessionId:'not-a-uuid'},/invalid staging seed metadata/],
  [{projectKey:'../escape'},/invalid staging seed metadata/],
  [{cliVersion:'latest'},/invalid staging seed metadata/],
  [{model:'claude-sonnet-5'},/invalid staging seed metadata/],
  [{model:''},/invalid staging seed metadata/],
  [{dispatchId:'0'.repeat(63)},/invalid staging seed metadata/],
  [{cwdSha:'x'.repeat(64)},/invalid staging seed metadata/],
]) assert.throws(()=>stagingSeedMetadata({...base,...change}),error);

// The trusted Store ingester must accept exactly this staging source shape and
// reject a missing role or a non-workflow_run event. The publish path failed
// live because the source object omitted `role`.
const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const identity={role:'developer',agent_id:'dev-qwen-01',issue:2319};
const sealed=sealCheckpoint(identity,1,Buffer.from('{"files":[]}'),Buffer.alloc(32,7),{
  provider:'claude-code',session_id:base.sessionId,
  source_sha:base.sourceSha,harness_digest:value.harness_digest});
const source={repository:'BestNathan/nession',run_id:7001,attempt:1,issue:2319,
  workflow_sha:'e'.repeat(40),target_sha:base.sourceSha,head_branch:'main',
  role:'developer',path:'.github/workflows/agent-staging-developer-canary.yml',
  workflow_name:'Agent / Staging Developer Canary',event:'workflow_run',
  agent_id:'dev-qwen-01',task:'implement',environment:'dev-claude-qwen',
  provider:'claude-code'};
assert.deepEqual(validateCheckpointSource(source,sealed,registry),identity);
assert.throws(()=>validateCheckpointSource({...source,role:undefined},sealed,registry),
  /untrusted source workflow/);
assert.throws(()=>validateCheckpointSource({...source,event:'pull_request'},sealed,registry),
  /untrusted source workflow/);
// A second staging seed must advance the committed head. The publisher reads
// the exact head version and lets the Store CAS reject a racing writer.
const storeRoot=fs.mkdtempSync(path.join(os.tmpdir(),'staging-head-'));
const store=path.join(storeRoot,'store');
const git=(args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const writeHead=(head)=>{
  const file=path.join(store,'roles','developer','dev-qwen-01','issues','2319','head.json');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify(head));
  git(['-C',store,'add','-A']);
  git(['-C',store,'-c','user.name=t','-c','user.email=t@t','commit','-qm','head']);
};
try {
  git(['init','-q','-b','agent-store',store]);
  writeHead({version:3,checkpoint_path:'roles/developer/dev-qwen-01/issues/2319/checkpoints/00000003.json',
    ciphertext_sha256:'a'.repeat(64)});
  assert.deepEqual(readCheckpointHeadVersion({remote:store,identity}),{version:3});
  fs.rmSync(path.join(store,'roles'),{recursive:true,force:true});
  git(['-C',store,'add','-A']);
  git(['-C',store,'-c','user.name=t','-c','user.email=t@t','commit','-qm','clear']);
  assert.deepEqual(readCheckpointHeadVersion({remote:store,identity}),{version:0});
  writeHead({version:0});
  assert.throws(()=>readCheckpointHeadVersion({remote:store,identity}),
    /invalid committed Store head version/);
  assert.throws(()=>readCheckpointHeadVersion({remote:store,
    identity:{...identity,issue:0}}),/invalid checkpoint identity/);
} finally {fs.rmSync(storeRoot,{recursive:true,force:true});}

console.log('Staging checkpoint metadata: pinned model/CLI, harness binding, Store source, head advance and negative fixtures passed');
