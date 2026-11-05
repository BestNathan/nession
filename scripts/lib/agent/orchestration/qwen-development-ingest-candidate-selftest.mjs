#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {prepareQwenDevelopmentSource,collectQwenDevelopmentPatch}
  from './qwen-development-source.mjs';
import {sealQwenDevelopmentProposal}
  from './qwen-development-evidence.mjs';
import {validateQwenDevelopmentCandidate,sealQwenCandidateForStore}
  from './qwen-development-ingest-candidate.mjs';
import {unsealCheckpoint} from '../store/checkpoint.mjs';
import {openClaudeNativeSession} from '../providers/claude-native-store.mjs';

const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-ingest-source-'));
const git=(...args)=>execFileSync('git',['-C',root,...args],{
  encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const runId=70011,actionId='a'.repeat(64);
try {
  git('init');
  git('config','user.name','Qwen Ingest Fixture');
  git('config','user.email','fixture@example.invalid');
  const file='hello.js';
  fs.writeFileSync(path.join(root,file),'module.exports = false;\n');
  git('add','.');
  git('commit','-m','fixed source');
  const sourceSha=git('rev-parse','HEAD');
  const admission={authorized:true,issue:2274,role:'developer',
    agent_id:'dev-qwen-01',provider:'claude-code',environment:'dev-claude-qwen',
    task:'implement',action_id:actionId,input_sha:sourceSha,run_id:runId};
  const env={ANTHROPIC_MODEL:'qwen3.7-plus',
    ANTHROPIC_BASE_URL:'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    ANTHROPIC_AUTH_TOKEN:'TEST_NEVER_PUBLISH'};
  const snapshot=prepareQwenDevelopmentSource({
    admission,registry,environment:env,cliVersion:'2.1.34',
    workspace:root,allowedFiles:[file]});
  fs.writeFileSync(path.join(root,file),'module.exports = true;\n');
  const events=['Read','Edit'].map((name,i)=>({
    type:'assistant',message:{content:[{type:'tool_use',id:'tool-'+i,name}]}}));
  const patch=collectQwenDevelopmentPatch(snapshot,{events});
  const ephemeral=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-ingest-native-'));
  const key=Buffer.alloc(32,79);
  try {
    const sessionId='550e8400-e29b-41d4-a716-446655440000';
    const dir=path.join(ephemeral,'seed');
    const project=path.join(dir,'projects','-workspace');
    fs.mkdirSync(project,{recursive:true});
    const privateMarker='PRIVATE_QWEN_SOURCE_CONTEXT_NEVER_IN_ARTIFACT';
    fs.writeFileSync(path.join(project,sessionId+'.jsonl'),
      JSON.stringify({sessionId,type:'user',message:privateMarker})+'\n');
    const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
    const publicKeyPem=rsa.publicKey.export({type:'spki',format:'pem'});
    const privateKeyPem=rsa.privateKey.export({type:'pkcs8',format:'pem'});
    const candidate=sealQwenDevelopmentProposal({
      admission,snapshot,patch,sessionId,configDir:dir,publicKeyPem});
    const run={id:runId,run_attempt:1,status:'completed',conclusion:'success',
      name:'Agent / Development',path:'.github/workflows/agent-develop.yml',
      event:'workflow_dispatch',head_branch:'main',head_sha:'b'.repeat(40)};
    const opts={admission,run,result:candidate.result,
      proof:candidate.proof,ciphertext:candidate.ciphertext};
    const accepted=validateQwenDevelopmentCandidate(opts);
    assert.equal(accepted.identity.agent_id,'dev-qwen-01');
    assert.equal(accepted.metadata.source_sha,sourceSha);
    assert.equal(accepted.proposal.patch_sha256,patch.patch_sha256);
    assert.deepEqual(accepted.proposal.changed_paths,[file]);
    assert.ok(!JSON.stringify(accepted).includes(privateMarker));
    const {sealed,identity,metadata,proposal}=sealQwenCandidateForStore({
      ...opts,privateKeyPem,storeKey:key,nextVersion:1});
    assert.equal(sealed.version,1);
    assert.equal(sealed.metadata.provider,'claude-code');
    assert.equal(identity.agent_id,'dev-qwen-01');
    assert.equal(metadata.session_id,sessionId);
    assert.equal(proposal.patch_sha256,patch.patch_sha256);
    assert.ok(!JSON.stringify(sealed).includes(privateMarker));
    const plain=unsealCheckpoint(identity,sealed,key);
    const bundle=JSON.parse(plain.toString('utf8'));
    assert.equal(bundle.kind,'qwen-claude-native-envelope');
    assert.equal(bundle.action_id,actionId);
    assert.equal(bundle.patch_sha256,patch.patch_sha256);
    assert.ok(!plain.toString('utf8').includes(privateMarker));
    const restored=path.join(ephemeral,'restored');
    assert.equal(openClaudeNativeSession({record:bundle.rsa_envelope,
      privateKeyPem,expected:bundle.metadata,configDir:restored}).session_id,
      sessionId);
    assert.ok(fs.readFileSync(path.join(restored,'projects','-workspace',
      sessionId+'.jsonl'),'utf8').includes(privateMarker));
    plain.fill(0);
    const denies=[
      {run:{...run,id:runId+1}},
      {run:{...run,run_attempt:2}},
      {run:{...run,head_branch:'staging'}},
      {run:{...run,path:'.github/workflows/another.yml'}},
      {run:{...run,conclusion:'failure'}},
      {admission:{...admission,agent_id:'dev-cursor-01'}},
      {admission:{...admission,authorized:false}},
      {result:{...candidate.result,action_id:'f'.repeat(64)}},
      {result:{...candidate.result,patch_sha256:'f'.repeat(64)}},
      {result:{...candidate.result,changed_paths:['.github/workflows/x.yml']}},
      {result:{...candidate.result,patch_base64:'!not-base64'}},
      {result:{...candidate.result,unexpected:'injection'}},
      {result:{...candidate.result,native_session_id:'another-id'}},
      {proof:{...candidate.proof,model:'claude-sonnet-5'}},
      {proof:{...candidate.proof,patch_bytes:7}},
      {proof:{...candidate.proof,metadata:{
        ...candidate.proof.metadata,source_sha:'f'.repeat(40)}}},
      {proof:{...candidate.proof,changed_paths:['hello.js','hello.js']}},
      {ciphertext:{...candidate.ciphertext,ciphertext_sha256:'f'.repeat(64)}},
      {ciphertext:{...candidate.ciphertext,unexpected:'injection'}},
    ];
    for(const change of denies)
      assert.throws(()=>validateQwenDevelopmentCandidate({...opts,...change}),
        /trusted Qwen Developer candidate/);
    assert.throws(()=>sealQwenCandidateForStore({
      ...opts,privateKeyPem:'invalid',storeKey:key,nextVersion:2}),
      /Claude native checkpoint/);
    assert.throws(()=>sealQwenCandidateForStore({
      ...opts,privateKeyPem,storeKey:Buffer.alloc(4),nextVersion:2}),
      /trusted Qwen Developer candidate/);
    assert.throws(()=>sealQwenCandidateForStore({
      ...opts,privateKeyPem,storeKey:key,nextVersion:0}),
      /trusted Qwen Developer candidate/);
    // A valid digest alone is NOT a claim that GitHub/Store ingestion ran.
    console.log('Qwen trusted candidate: real Git patch, RSA/AES native restore, Store AES rewrap and forged Run/Action/metadata negatives passed');
  }finally{key.fill(0);fs.rmSync(ephemeral,{recursive:true,force:true});}
}finally{fs.rmSync(root,{recursive:true,force:true});}
