#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {buildClaudeCliArgs,runClaudeCli} from './claude-code.mjs';
import {sealClaudeNativeSession,openClaudeNativeSession,discoverClaudeNativeProject}
  from './claude-native-store.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-resume-v1-'));
const session='550e8400-e29b-41d4-a716-446655440000';
const otherSession='a50e8400-e29b-41d4-a716-446655440000';
const key='-home-runner-work-nession-nession';
const source='a'.repeat(40),harness='b'.repeat(64);
const seed=path.join(root,'seed'),project=path.join(seed,'projects',key);
const nativeLine=JSON.stringify({type:'user',sessionId:session,message:{content:'SECRET-CONTEXT-MARKER'}})+'\n';
try{
  assert.throws(()=>buildClaudeCliArgs({prompt:'x',model:'sonnet',maxTurns:2,
    allowedTools:'',disallowedTools:'*',sessionId:session,resumeSessionId:session}),/seed and resume/);
  assert.throws(()=>buildClaudeCliArgs({prompt:'x',model:'sonnet',maxTurns:2,
    allowedTools:'',disallowedTools:'*',resumeSessionId:'not-a-uuid'}),/native session UUID/);
  const calls=[];
  const execute=(options={})=>runClaudeCli({
    prompt:'What was the earlier marker?',model:'test-model',maxTurns:2,
    allowedTools:'',disallowedTools:'Edit,Write,Bash',cwd:root,configDir:seed,
    restricted:true,tools:'',...options,
    spawn:options.spawn??((cmd,args,opts)=>{
      calls.push({cmd,args,opts});
      return {status:0,stdout:JSON.stringify({type:'result',is_error:false,
        session_id:options?.resumeSessionId??options?.sessionId??session,result:'ok'})};
    }),
  });
  const started=execute({sessionId:session});
  assert.equal(started.parsed.session_id,session);
  assert.ok(calls[0].args.includes('--session-id'));
  assert.ok(!calls[0].args.includes('--resume'));
  assert.deepEqual(calls[0].args.slice(-2),['--session-id',session]);
  assert.equal(calls[0].opts.env.CLAUDE_CONFIG_DIR,seed);
  assert.ok(calls[0].args.includes('--restricted'));
  assert.ok(calls[0].args.includes('--tools'));
  assert.ok(!calls[0].args.includes('--fork-session'));
  const resumed=execute({resumeSessionId:session});
  assert.equal(resumed.parsed.session_id,session);
  assert.deepEqual(calls[1].args.slice(-2),['--resume',session]);
  assert.throws(()=>execute({sessionId:session,env:{CLAUDE_CODE_SKIP_PROMPT_HISTORY:'1'}}),
    /persistence is disabled/);
  assert.throws(()=>execute({resumeSessionId:session,configDir:null}),/isolated/);
  assert.throws(()=>execute({resumeSessionId:session,spawn:()=>({status:0,stdout:
    JSON.stringify({session_id:otherSession,result:'wrong native ID'})})}),/different native/);

  fs.mkdirSync(project,{recursive:true});
  fs.writeFileSync(path.join(project,session+'.jsonl'),nativeLine,{mode:0o600});
  fs.writeFileSync(path.join(project,otherSession+'.jsonl'),
    JSON.stringify({sessionId:otherSession,type:'user',message:'foreign'})+'\n');
  fs.mkdirSync(path.join(project,session,'subagents'),{recursive:true});
  fs.writeFileSync(path.join(project,session,'subagents','agent-1.jsonl'),
    JSON.stringify({type:'assistant',message:'helper state'})+'\n');
  assert.equal(discoverClaudeNativeProject(seed,session),key);
  const metadata={session_id:session,source_sha:source,harness_digest:harness,
    project_key:key,cwd_sha256:'c'.repeat(64),run_id:101,attempt:1,cli_version:'2.1.248'};
  const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,
    publicKeyEncoding:{format:'pem',type:'spki'},privateKeyEncoding:{format:'pem',type:'pkcs8'}});
  const sealed=sealClaudeNativeSession({configDir:seed,metadata,publicKeyPem:publicKey});
  const body=JSON.stringify(sealed);
  assert.ok(!body.includes('SECRET-CONTEXT-MARKER'),'plaintext leaked in ciphertext artifact');
  assert.ok(!body.includes('foreign'),'other project sessions not exported');
  const restored=path.join(root,'restored');
  const value=openClaudeNativeSession({record:sealed,privateKeyPem:privateKey,
    expected:metadata,configDir:restored});
  assert.equal(value.session_id,session);
  assert.equal(fs.readFileSync(path.join(restored,'projects',key,session+'.jsonl'),'utf8'),nativeLine);
  assert.ok(fs.existsSync(path.join(restored,'projects',key,session,'subagents','agent-1.jsonl')));
  assert.ok(!fs.existsSync(path.join(restored,'projects',key,otherSession+'.jsonl')));
  assert.throws(()=>openClaudeNativeSession({record:sealed,privateKeyPem:privateKey,
    expected:metadata,configDir:restored}),/must be new/);
  assert.throws(()=>openClaudeNativeSession({record:sealed,privateKeyPem:privateKey,
    expected:{...metadata,harness_digest:'d'.repeat(64)},
    configDir:path.join(root,'bad-digest')}),/incompatible/);
  assert.throws(()=>openClaudeNativeSession({record:{...sealed,ciphertext:'AAAA'},
    privateKeyPem:privateKey,expected:metadata,configDir:path.join(root,'bad-cipher')}),
    /ciphertext integrity mismatch/);
  assert.throws(()=>openClaudeNativeSession({record:{...sealed,
    metadata:{...metadata,source_sha:'d'.repeat(40)}},
    privateKeyPem:privateKey,expected:{...metadata,source_sha:'d'.repeat(40)},
    configDir:path.join(root,'forged-aad')}),/authentication/);
  const otherKeys=generateKeyPairSync('rsa',{modulusLength:2048,
    publicKeyEncoding:{format:'pem',type:'spki'},privateKeyEncoding:{format:'pem',type:'pkcs8'}});
  assert.throws(()=>openClaudeNativeSession({record:sealed,privateKeyPem:otherKeys.privateKey,
    expected:metadata,configDir:path.join(root,'wrong-key')}),/authentication/);
  fs.symlinkSync(path.join(project,session+'.jsonl'),
    path.join(project,session,'subagents','injected.jsonl'));
  assert.throws(()=>sealClaudeNativeSession({configDir:seed,metadata,publicKeyPem:publicKey}),
    /symlinked session dependency/);
} catch(error){
  throw error;
} finally {
  fs.rmSync(root,{recursive:true,force:true});
}
console.log('Claude native Resume: pinned CLI, exact Session, encrypted archive and isolation fixtures passed');
