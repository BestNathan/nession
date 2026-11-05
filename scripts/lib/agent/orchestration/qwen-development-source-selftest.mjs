#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {openClaudeNativeSession} from '../providers/claude-native-store.mjs';
import {sealQwenDevelopmentProposal,assertQwenModelHasNoStoreAuthority}
  from './qwen-development-evidence.mjs';
import {prepareQwenDevelopmentSource,collectQwenDevelopmentPatch}
  from './qwen-development-source.mjs';

const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-development-source-'));
const git=(...a)=>execFileSync('git',['-C',root,...a],{
  encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}).trim();
const write=(rel,txt)=>fs.writeFileSync(path.join(root,rel),txt);
try{
  git('init');
  git('config','user.name','Qwen Bounded Fixture');
  git('config','user.email','fixture@example.invalid');
  fs.mkdirSync(path.join(root,'src'));
  write('src/calc.js','module.exports = (a, b) => a - b;\n');
  write('src/other.js','const other = true;\n');
  write('.gitignore','.tmp/\n');
  git('add','.');
  git('commit','-m','source fixture');
  const sha=git('rev-parse','HEAD');
  const admission={authorized:true,role:'developer',task:'implement',
    issue:2274,action_id:'a'.repeat(64),input_sha:sha,run_id:401,
    agent_id:'dev-qwen-01',provider:'claude-code',
    environment:'dev-claude-qwen'};
  const env={ANTHROPIC_MODEL:'qwen3.7-plus',
    ANTHROPIC_BASE_URL:'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    ANTHROPIC_AUTH_TOKEN:'TEST_CREDENTIAL_DO_NOT_LEAK'};
  const request={admission,registry,environment:env,cliVersion:'2.1.34',
    workspace:root,allowedFiles:['src/calc.js']};
  const snapshot=prepareQwenDevelopmentSource(request);
  assert.equal(snapshot.plan.source_sha,sha);
  assert.equal(snapshot.plan.agent_id,'dev-qwen-01');
  assert.equal(snapshot.allowed_files.join(','),'src/calc.js');
  assert.throws(()=>collectQwenDevelopmentPatch(snapshot,{
    toolNames:['Read','Edit']}),/missing or unbounded/);
  write('src/calc.js','module.exports = (a, b) => a + b;\n');
  const proposed=collectQwenDevelopmentPatch(snapshot,{toolNames:['Read','Edit']});
  assert.equal(proposed.kind,'qwen_developer_bounded_patch');
  assert.equal(proposed.source_sha,sha);
  assert.deepEqual(proposed.paths,['src/calc.js']);
  assert.match(proposed.patch,/\+module\.exports = \(a, b\) => a \+ b/);
  assert.match(proposed.patch_sha256,/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(proposed).includes(env.ANTHROPIC_AUTH_TOKEN));
  // Same Run/Action must bind the proposed Git patch to a real ciphertext-
  // only native Claude Session. Nothing in the public proof may reveal JSONL.
  const tempNative=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-evidence-native-'));
  try{
    const configDir=path.join(tempNative,'config');
    const projectKey='-workspace';
    const project=path.join(configDir,'projects',projectKey);
    fs.mkdirSync(project,{recursive:true});
    const sessionId='550e8400-e29b-41d4-a716-446655440000';
    const marker='PRIVATE_NATIVE_QWEN_CONTEXT_MARKER';
    fs.writeFileSync(path.join(project,sessionId+'.jsonl'),
      JSON.stringify({sessionId,type:'user',message:marker})+'\n');
    const keys=generateKeyPairSync('rsa',{modulusLength:2048});
    const publicKeyPem=keys.publicKey.export({type:'spki',format:'pem'});
    const privateKeyPem=keys.privateKey.export({type:'pkcs8',format:'pem'});
    const evidence=sealQwenDevelopmentProposal({
      admission,snapshot,patch:proposed,sessionId,configDir,publicKeyPem});
    assert.equal(evidence.proof.action_id,admission.action_id);
    assert.equal(evidence.proof.run_id,admission.run_id);
    assert.equal(evidence.proof.patch_sha256,proposed.patch_sha256);
    assert.equal(evidence.result.native_session_id,sessionId);
    assert.equal(evidence.result.native_resumed,false);
    assert.equal(Buffer.from(evidence.result.patch_base64,'base64').toString('utf8'),
      proposed.patch);
    assert.equal(evidence.result.ciphertext_sha256,
      evidence.ciphertext.ciphertext_sha256);
    assert.ok(!JSON.stringify(evidence).includes(marker));
    const restored=path.join(tempNative,'restored');
    const actual=openClaudeNativeSession({record:evidence.ciphertext,
      privateKeyPem,expected:evidence.proof.metadata,configDir:restored});
    assert.equal(actual.session_id,sessionId);
    assert.ok(fs.readFileSync(path.join(restored,'projects',projectKey,
      sessionId+'.jsonl'),'utf8').includes(marker));
    for(const invalid of [
      {admission:{...admission,run_id:777}},
      {admission:{...admission,agent_id:'dev-cursor-01'}},
      {patch:{...proposed,patch_sha256:'0'.repeat(64)}},
      {patch:{...proposed,patch_bytes:1}},
      {patch:{...proposed,source_sha:'f'.repeat(40)}},
      {sessionId:'not-a-uuid'},
    ]){
      assert.throws(()=>sealQwenDevelopmentProposal({
        admission,snapshot,patch:proposed,sessionId,configDir,publicKeyPem,
        ...invalid}),/unbound native Session/);
    }
    assertQwenModelHasNoStoreAuthority(env);
    for(const k of ['GITHUB_TOKEN','STORE_APP_TOKEN','STAGING_STORE_AES_KEY_B64',
      'QWEN_RESUME_PRIVATE_KEY_B64'])
      assert.throws(()=>assertQwenModelHasNoStoreAuthority({
        ...env,[k]:'forbidden'}),/privileged credential/);
  }finally{fs.rmSync(tempNative,{recursive:true,force:true});}
  for(const tools of [[],['Edit'],['Read'],['Read','Bash','Edit']])
    assert.throws(()=>collectQwenDevelopmentPatch(snapshot,{toolNames:tools}),
      /restricted native Read\/Edit/);
  assert.throws(()=>prepareQwenDevelopmentSource(request),
    /not the clean signed/);
  git('reset','--hard','HEAD');
  assert.throws(()=>prepareQwenDevelopmentSource({
    ...request,admission:{...admission,input_sha:'f'.repeat(40)}}),
  /not the clean signed/);
  for(const allowedFiles of [['../src/calc.js'],['.git/config'],
    ['src/../src/calc.js'],['src/calc.js','src/calc.js'],
    ['src/does-not-exist.js'],[]])
    assert.throws(()=>prepareQwenDevelopmentSource({...request,allowedFiles}),
      /unsafe trusted edit allowlist|missing allowlisted source path|exact Git/);
  assert.throws(()=>prepareQwenDevelopmentSource({
    ...request,environment:{...env,ANTHROPIC_MODEL:'claude-sonnet-5'}}),/Qwen/);
  assert.throws(()=>prepareQwenDevelopmentSource({...request,
    admission:{...admission,agent_id:'dev-cursor-01',provider:'cursor',
      environment:'agent-dev-cursor-01'}}),/mismatch/);
  const checkInvalid=(mutate,pattern)=>{
    git('reset','--hard','HEAD');
    git('clean','-fdx');
    const a=prepareQwenDevelopmentSource(request);
    mutate();
    assert.throws(()=>collectQwenDevelopmentPatch(a,{
      toolNames:['Read','Edit']}),pattern);
  };
  checkInvalid(()=>write('src/other.js','const other = false;\n'),/missing or unbounded|outside approved/);
  checkInvalid(()=>write('src/new.js','untracked\n'),/untracked/);
  checkInvalid(()=>{
    fs.mkdirSync(path.join(root,'.tmp'),{recursive:true});
    write('src/calc.js','module.exports = (a, b) => a + b;\n');
    write('.tmp/secret','must never escape the model workspace');
  },/ignored workspace artifacts/);
  checkInvalid(()=>{
    write('src/calc.js','module.exports = (a, b) => a + b;\n');
    git('add','src/calc.js');
  },/index/);
  checkInvalid(()=>{
    fs.unlinkSync(path.join(root,'src/calc.js'));
    fs.symlinkSync('other.js',path.join(root,'src/calc.js'));
  },/symlink|untracked/);
  checkInvalid(()=>fs.unlinkSync(path.join(root,'src/calc.js')),
    /delete|untracked/);
  checkInvalid(()=>{
    write('src/calc.js','module.exports = (a, b) => a + b;\n');
    write('src/other.js','const other = false;\n');
  },/unbounded|outside approved/);
  git('reset','--hard','HEAD');
  git('clean','-fdx');
  // The fixture is itself a real Git commit and the result is a real diff;
  // no model text or self-reported "success" can replace those checks.
  console.log('Qwen bounded Developer source: exact Git SHA, real patch, native tool evidence, drift/extra edits/symlink/index/credential/model negatives passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}
