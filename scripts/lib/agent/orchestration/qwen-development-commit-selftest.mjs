#!/usr/bin/env node
// #2274: real Git Store v1->v3 signed dispatch, Qwen-native ciphertext
// candidate, canonical checkpoint CAS -> Outbox Slice Yield -> exact replay.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {startDevelopment,recordDispatchIntent,recordDispatch}
  from './outbox.mjs';
import {planGitHubDispatch} from './github-dispatch.mjs';
import {writeIssueWorkflowState,readIssueWorkflowState}
  from './state-store.mjs';
import {publish} from '../../../run-store-cas-push.mjs';
import {prepareQwenDevelopmentSource,collectQwenDevelopmentPatch}
  from './qwen-development-source.mjs';
import {sealQwenDevelopmentProposal}
  from './qwen-development-evidence.mjs';
import {ingestQwenVerifiedCandidate,qwenCheckpointNextVersion}
  from './qwen-development-commit.mjs';
import {preflightTrustedQwenPublisher}
  from '../publisher/qwen-source-preflight.mjs';

const priorNodeEnv=process.env.NODE_ENV;
process.env.NODE_ENV='test';
const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const home=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-real-store-'));
const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{
  encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:20000}).trim();
const sha256=x=>createHash('sha256').update(x).digest('hex');
const key=Buffer.alloc(32,33),aesKey=Buffer.alloc(32,59);
try {
  const writer=path.join(home,'writer'),source=path.join(home,'source');
  const remote=path.join(home,'agent-store.git');
  fs.mkdirSync(writer);fs.mkdirSync(source);
  git(home,'init','--bare','agent-store.git');
  git(writer,'init');git(writer,'config','user.name','Qwen Store Case');
  git(writer,'config','user.email','qwen@example.invalid');
  git(writer,'switch','--orphan','agent-store');
  git(writer,'commit','--allow-empty','-m','bootstrap Store');
  git(writer,'remote','add','origin',remote);
  git(writer,'push','origin','HEAD:refs/heads/agent-store');
  git(source,'init');git(source,'config','user.name','Qwen Edit Case');
  git(source,'config','user.email','edit@example.invalid');
  fs.writeFileSync(path.join(source,'calc.js'),
    'module.exports = (a, b) => a - b;\n');
  git(source,'add','calc.js');git(source,'commit','-m','trusted input');
  const inputSha=git(source,'rev-parse','HEAD');
  const issue=2274,workerId=550011,issuerId=902;
  const signer={key,key_id:'main-controller',issuer_run_id:issuerId,
    now:Date.parse('2026-11-05T12:00:00Z'),ttl_ms:600000};
  const ctx={repository:'BestNathan/nession',event:'workflow_dispatch',
    permission:'write',ref:'refs/heads/main',run_id:issuerId};
  const request={issue,sha:inputSha,developer:'dev-qwen-01',
    reviewer:'review-qwen-01',acceptor:'accept-qwen-01'};
  const initial=startDevelopment(registry,request,ctx);
  const action=initial.outbox[0];
  const signed=planGitHubDispatch(initial,action.id,registry,signer);
  const prepared=recordDispatchIntent(initial,1,action.id,{
    status:'prepared',dispatch_id:action.id,issuer_run_id:issuerId,
    ticket_sha256:sha256(signed.inputs.dispatch_ticket)});
  const acknowledged=recordDispatch(prepared,2,action.id,{
    status:'verified',dispatch_id:action.id,source_run_id:workerId});
  const save=(state,old)=>{
    writeIssueWorkflowState(writer,state,old);
    git(writer,'add','-A');
    git(writer,'commit','-m','stored signed Dispatch v'+state.version);
    publish('agent-store',writer,4);
  };
  save(initial,0);save(prepared,1);save(acknowledged,2);
  assert.equal(qwenCheckpointNextVersion({
    authorized:true,role:'developer',agent_id:'dev-qwen-01',
    provider:'claude-code',task:'implement'}, {version:0}),1);
  assert.throws(()=>qwenCheckpointNextVersion({
    authorized:true,role:'developer',agent_id:'dev-qwen-01',
    provider:'claude-code',task:'implement'}, {version:1}),
    /head advanced/);
  const runHeadSha='a'.repeat(40),repo={full_name:'BestNathan/nession'};
  const run={id:workerId,run_attempt:1,name:'Agent / Development',
    path:'.github/workflows/agent-develop.yml',
    event:'workflow_dispatch',head_branch:'main',head_sha:runHeadSha,
    repository:repo,head_repository:repo,actor:{login:'github-actions[bot]'},
    status:'completed',conclusion:'success',
    created_at:'2026-11-05T12:01:00Z'};
  const issuer={id:issuerId,
    name:'Agent / Controller Dispatch',
    path:'.github/workflows/agent-controller-dispatch.yml',
    event:'workflow_dispatch',head_branch:'main',head_sha:runHeadSha,
    repository:repo,head_repository:repo,actor:{login:'BestNathan'},
    run_attempt:1};
  const reader={getRun:async id=>{
    if(id===issuerId)return issuer;
    if(id===workerId)return run;
    throw Error('unexpected source Run');
  }};
  const admission={authorized:true,role:'developer',task:'implement',
    issue,action_id:action.id,input_sha:inputSha,run_id:workerId,
    agent_id:'dev-qwen-01',provider:'claude-code',
    environment:'dev-claude-qwen'};
  const selected={ANTHROPIC_MODEL:'qwen3.7-plus',
    ANTHROPIC_BASE_URL:'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    ANTHROPIC_AUTH_TOKEN:'test-only-not-a-real-credential'};
  const snapshot=prepareQwenDevelopmentSource({admission,registry,
    environment:selected,cliVersion:'2.1.34',workspace:source,
    allowedFiles:['calc.js']});
  fs.writeFileSync(path.join(source,'calc.js'),
    'module.exports = (a, b) => a + b;\n');
  const events=['Read','Edit'].map((name,i)=>({type:'assistant',
    message:{content:[{type:'tool_use',id:'qwen-'+i,name}]}}));
  const patch=collectQwenDevelopmentPatch(snapshot,{events});
  const nativeDir=path.join(home,'native');
  const project=path.join(nativeDir,'projects','-workspace');
  fs.mkdirSync(project,{recursive:true});
  const sessionId='550e8400-e29b-41d4-a716-446655440000';
  fs.writeFileSync(path.join(project,sessionId+'.jsonl'),
    JSON.stringify({sessionId,type:'user',message:'PRIVATE_QWEN_MARKER'})+'\n');
  const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
  const publicKeyPem=rsa.publicKey.export({type:'spki',format:'pem'});
  const privateKeyPem=rsa.privateKey.export({type:'pkcs8',format:'pem'});
  const candidate=sealQwenDevelopmentProposal({
    admission,snapshot,patch,sessionId,configDir:nativeDir,publicKeyPem});
  const claim={inputs:signed.inputs};
  const args={remote,registry,run,claim,reader,rootKey:key,
    aesKey,privateKeyPem,
    result:candidate.result,proof:candidate.proof,
    ciphertext:candidate.ciphertext};
  const accepted=await ingestQwenVerifiedCandidate(args);
  assert.equal(accepted.status,'committed');
  assert.equal(accepted.checkpoint.version,1);
  assert.match(accepted.checkpoint.commit_sha,/^[a-f0-9]{40}$/);
  assert.equal(accepted.action_id,action.id);
  assert.ok(!JSON.stringify(accepted).includes('PRIVATE_QWEN_MARKER'));
  const cloned=path.join(home,'readback');
  git(home,'clone','--branch','agent-store',remote,cloned);
  const record=readIssueWorkflowState(cloned,issue);
  assert.equal(record.version,3);
  const original=record.state.outbox.find(a=>a.id===action.id);
  assert.equal(original.status,'dispatched');
  assert.equal(original.receipt.source_run_id,workerId);
  assert.equal(record.state.outbox.filter(a=>a.task.role==='developer').length,1);
  const replay=await ingestQwenVerifiedCandidate(args);
  assert.equal(replay.status,'replayed');
  assert.equal(replay.checkpoint.commit_sha,accepted.checkpoint.commit_sha);
  assert.equal(replay.checkpoint.ciphertext_sha256,
    accepted.checkpoint.ciphertext_sha256);
  assert.equal(readIssueWorkflowState(cloned,issue).version,record.version);
  // The Publisher independently reads the exact signed source Run, immutable
  // native checkpoint, and applies the Worker patch to a CLEAN isolated Git
  // checkout, even though the model's disposable source is now modified.
  const pubCheckout=path.join(home,'publisher-source');
  git(home,'clone','--no-hardlinks',source,pubCheckout);
  const published=await preflightTrustedQwenPublisher({
    remote,registry,run,claim,reader,rootKey:key,
    result:candidate.result,proof:candidate.proof,
    ciphertext:candidate.ciphertext,sourceCheckout:pubCheckout});
  assert.equal(published.evidence.issue,issue);
  assert.equal(published.evidence.action_id,action.id);
  assert.equal(published.evidence.worker_run_id,workerId);
  assert.equal(published.evidence.checkpoint_commit_sha,
    accepted.checkpoint.commit_sha);
  assert.equal(published.evidence.patch_sha256,patch.patch_sha256);
  assert.equal(published.evidence.file_manifest.length,1);
  assert.equal(published.evidence.file_manifest[0].path,'calc.js');
  assert.match(published.patch,/module.exports/);
  assert.ok(!JSON.stringify(published).includes('PRIVATE_QWEN_MARKER'));
  assert.equal(published.evidence.status,'preflight_only');
  for(const bad of [
    {run:{...run,id:workerId+1}},
    {run:{...run,actor:{login:'attacker'}}},
    {claim:{inputs:{...signed.inputs,agent_id:'dev-cursor-01'}}},
    {result:{...candidate.result,patch_sha256:'a'.repeat(64)}},
    {proof:{...candidate.proof,changed_paths:['scripts/lib/agent/evil.js']}},
  ]){
    await assert.rejects(()=>preflightTrustedQwenPublisher({
      remote,registry,run,claim,reader,rootKey:key,
      result:candidate.result,proof:candidate.proof,
      ciphertext:candidate.ciphertext,sourceCheckout:pubCheckout,
      ...bad}),/Qwen|claim|dispatch|candidate|Publisher|Developer/i);
  }
  const wrongSource=path.join(home,'publisher-wrong-sha');
  git(home,'clone','--no-hardlinks',source,wrongSource);
  fs.writeFileSync(path.join(wrongSource,'other.js'),'const bad=true;\n');
  git(wrongSource,'add','other.js');
  git(wrongSource,'config','user.name','Wrong Source');
  git(wrongSource,'config','user.email','wrong@example.invalid');
  git(wrongSource,'commit','-m','different source');
  await assert.rejects(()=>preflightTrustedQwenPublisher({
    remote,registry,run,claim,reader,rootKey:key,
    result:candidate.result,proof:candidate.proof,
    ciphertext:candidate.ciphertext,sourceCheckout:wrongSource,
  }),/Agent patch preflight/);

  const badCandidates=[
    {result:{...candidate.result,patch_sha256:'f'.repeat(64)}},
    {proof:{...candidate.proof,patch_sha256:'f'.repeat(64)}},
    {ciphertext:{...candidate.ciphertext,ciphertext_sha256:'f'.repeat(64)}},
    {claim:{inputs:{...signed.inputs,agent_id:'dev-cursor-01'}}},
    {run:{...run,actor:{login:'attacker'}}},
    {run:{...run,run_attempt:2}},
  ];
  for(const bad of badCandidates){
    await assert.rejects(()=>ingestQwenVerifiedCandidate({...args,...bad}),
      /Qwen|claim|dispatch|trusted|candidate|Store/i);
  }
  console.log('Qwen signed Outbox -> AES Store CAS -> immutable receipt -> trusted Publisher patch reapply/replay verified');
}finally{
  key.fill(0);aesKey.fill(0);
  fs.rmSync(home,{recursive:true,force:true});
  if(priorNodeEnv===undefined)delete process.env.NODE_ENV;
  else process.env.NODE_ENV=priorNodeEnv;
}
