#!/usr/bin/env node
import assert from 'node:assert/strict';
import {qwenWorkerAuthority,qwenDeveloperPrompt}
  from './qwen-development-worker.mjs';

const admission={authorized:true,issue:2274,role:'developer',
  agent_id:'dev-qwen-01',provider:'claude-code',
  environment:'dev-claude-qwen',task:'implement',
  action_id:'a'.repeat(64),input_sha:'b'.repeat(40),run_id:55501};
const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'BestNathan/nession',
  GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',
  GITHUB_WORKFLOW:'Agent / Development',GITHUB_ACTOR:'github-actions[bot]',
  GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'55501',GITHUB_SHA:'c'.repeat(40),
  NESSION_DEVELOPER_ISOLATED:'docker-v1',GITHUB_WORKSPACE:'/workspace',
  RUNNER_TEMP:'/tmp'};
assert.equal(qwenWorkerAuthority(admission,env).agent_id,'dev-qwen-01');
const issue={number:2274,state:'open',title:'Fix tracked application source',
  body:'Accept a bounded patch after reading code'};
const prompt=qwenDeveloperPrompt(issue,admission);
assert.match(prompt,/Fix tracked application source/);
assert.match(prompt,/Read\/Edit\/Write/);
assert.match(prompt,/The trusted Publisher/);
for(const extra of [
  {GITHUB_TOKEN:'leaked'}, {STORE_APP_TOKEN:'unsafe'},
  {STORE_WRITER_PRIVATE_KEY:'private'}, {GH_TOKEN:'forbidden'},
  {CURSOR_RESUME_PRIVATE_KEY_B64:'forbidden'},
  {QWEN_RESUME_PRIVATE_KEY_B64:'forbidden'},
  {GITHUB_WORKSPACE:'/repo'}, {GITHUB_ACTOR:'untrusted'},
  {GITHUB_RUN_ATTEMPT:'2'}, {GITHUB_REF:'refs/heads/staging'},
  {GITHUB_WORKFLOW:'Another workflow'},
  {NSESSION_DEVELOPER_ISOLATED:'invalid',NESSION_DEVELOPER_ISOLATED:'host'},
]){
  assert.throws(()=>qwenWorkerAuthority(admission,{...env,...extra}),
    /isolated Qwen Developer|Qwen Developer evidence/);
}
for(const change of [
  {authorized:false},{issue:1997},{run_id:55502},
  {agent_id:'dev-cursor-01'},{provider:'cursor'},
  {environment:'deepseek'},{task:'review'},{input_sha:'invalid'},
])
  assert.throws(()=>qwenWorkerAuthority({...admission,...change},env),
    /isolated Qwen Developer/);
for(const invalid of [
  {...issue,number:1997},{...issue,state:'closed'},
  {...issue,title:'x'.repeat(400)},
  {...issue,body:'x'.repeat(100*1024)},
  {...issue,pull_request:{url:'https://github.com/x/y'}},
])
  assert.throws(()=>qwenDeveloperPrompt(invalid,admission),
    /Issue context/);
console.log('Qwen isolated Developer: signed Run admission, absent Store credentials, exact issue context and defensive prompt passed');
