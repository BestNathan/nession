#!/usr/bin/env node
// Deterministic negative fixtures. Live two-Run continuity requires the separate D1 workflows.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { runCursorSession } from './cursor.mjs';
import { sealCursorNativeStore, openCursorNativeStore } from './cursor-native-store.mjs';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nession-cursor-native-'));
const model={id:'composer-2.5',parameters:[]};
const store=path.join(dir,'native');
fs.mkdirSync(store);
let created=0,resumed=0,commands=[];
const agentId='agent-fixture-abc123';
const api={
  Cursor:{models:{async list(){return [model];}}},
  JsonlLocalAgentStore:class {constructor(folder){this.folder=folder;}},
  Agent:{
    async create(options){
      created++;
      assert.deepEqual(options.tools,[]);
      return fakeAgent();
    },
    async resume(id,options){
      assert.equal(id,agentId);
      assert.deepEqual(options.tools,[]);
      assert.equal(options.local.store.folder,store);
      assert.deepEqual(options.local.settingSources,[]);
      resumed++;
      return fakeAgent();
    }
  }
};
function fakeAgent(){
  return {agentId,
    async send(prompt) {
      commands.push(prompt);
      return {id:'fake-run',async *stream(){yield {type:'usage',usage:{inputTokens:2}};},
        async wait(){return {id:'fake-run',status:'finished',result:'ok',usage:{inputTokens:2}};}};
    },
    async getUsage(){return null;},
    async close(){},
  };
}
async function test(){
  const common={sdkLoader:async()=>api,apiKey:'fixture',name:'fixture',
    requestedModel:{id:'composer-2.5',fast:false},workspace:dir,
    storePath:store,tools:[],prompt:'hello'};
  const first=await runCursorSession(common);
  assert.equal(first.meta.agent_id,agentId);
  assert.equal(first.meta.resumed,false);
  const second=await runCursorSession({...common,resumeAgentId:agentId,prompt:'second turn'});
  assert.equal(second.meta.agent_id,agentId);
  assert.equal(second.meta.resumed,true);
  assert.equal(created,1);
  assert.equal(resumed,1);
  assert.deepEqual(commands,['hello','second turn']);
  await assert.rejects(runCursorSession({...common,resumeAgentId:'bc-foreign'}),
    /Invalid local Cursor native resume/);
  await assert.rejects(runCursorSession({...common,tools:null}),/explicit tool allowlist/);
  const noResume={...api,Agent:{create:api.Agent.create}};
  await assert.rejects(runCursorSession({...common,sdkLoader:async()=>noResume,resumeAgentId:agentId}),
    /no native resume API/);
  const badAgent={...api,Agent:{...api.Agent,async resume(){return {...fakeAgent(),agentId:'agent-other-12345'};}}};
  await assert.rejects(runCursorSession({...common,sdkLoader:async()=>badAgent,resumeAgentId:agentId}),
    /different native agent ID/);
  const metadata={agent_id:agentId,source_sha:'a'.repeat(40),harness_digest:'b'.repeat(64),
    run_id:123,attempt:1,sdk_version:'1.0.0'};
  for (const name of ['agents.ndjson','runs.ndjson','run_events.ndjson','checkpoints.ndjson']) {
    fs.writeFileSync(path.join(store,name),JSON.stringify({native:name})+'\n',{mode:0o600});
  }
  const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,
    publicKeyEncoding:{format:'pem',type:'spki'},privateKeyEncoding:{format:'pem',type:'pkcs8'}});
  const sealed=sealCursorNativeStore({directory:store,metadata,publicKeyPem:publicKey});
  const text=JSON.stringify(sealed);
  assert.ok(!text.includes('"native":"checkpoints.ndjson"'), 'native transcript leaked');
  const destination=path.join(dir,'restored');
  const opened=openCursorNativeStore({record:sealed,privateKeyPem:privateKey,expected:metadata,directory:destination});
  assert.equal(opened.agent_id,agentId);
  for(const name of ['agents.ndjson','runs.ndjson','run_events.ndjson','checkpoints.ndjson']) {
    assert.deepEqual(fs.readFileSync(path.join(store,name)),fs.readFileSync(path.join(destination,name)));
  }
  assert.throws(()=>openCursorNativeStore({record:sealed,privateKeyPem:privateKey,expected:metadata,directory:destination}),
    /destination must be new/);
  assert.throws(()=>openCursorNativeStore({record:sealed,privateKeyPem:privateKey,
    expected:{...metadata,harness_digest:'c'.repeat(64)},directory:path.join(dir,'bad-digest')}),
    /compatibility mismatch/);
  assert.throws(()=>openCursorNativeStore({record:{...sealed,metadata:{...metadata,source_sha:'d'.repeat(40)}},
    privateKeyPem:privateKey,expected:{...metadata,source_sha:'d'.repeat(40)},
    directory:path.join(dir,'forged-metadata')}),/authentication/);
  assert.throws(()=>openCursorNativeStore({record:{...sealed,ciphertext:'AAAA'},
    privateKeyPem:privateKey,expected:metadata,directory:path.join(dir,'forged-cipher')}),
    /ciphertext hash/);
  const other=generateKeyPairSync('rsa',{modulusLength:2048,
    publicKeyEncoding:{format:'pem',type:'spki'},privateKeyEncoding:{format:'pem',type:'pkcs8'}});
  assert.throws(()=>openCursorNativeStore({record:sealed,privateKeyPem:other.privateKey,
    expected:metadata,directory:path.join(dir,'wrong-key')}),/authentication/);
  fs.writeFileSync(path.join(store,'extra.ndjson'),'{}\n');
  assert.throws(()=>sealCursorNativeStore({directory:store,metadata,publicKeyPem:publicKey}),
    /inventory mismatch/);
  fs.unlinkSync(path.join(store,'extra.ndjson'));
  fs.unlinkSync(path.join(store,'checkpoints.ndjson'));
  fs.symlinkSync(path.join(store,'agents.ndjson'),path.join(store,'checkpoints.ndjson'));
  assert.throws(()=>sealCursorNativeStore({directory:store,metadata,publicKeyPem:publicKey}),
    /unsafe native store file/);
  console.log('Cursor native resume and encrypted JSONL fixture: positive and negative tests passed');
}
try {await test();} finally {fs.rmSync(dir,{recursive:true,force:true});}
