#!/usr/bin/env node
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { dispatchAuthenticatedBug } from './controller-bug-dispatch.mjs';
const REPO='BestNathan/nession',sourceSha='a'.repeat(40),actionId='b'.repeat(64);
const source={schema_version:1,kind:'agent_controller_start_request',
  request:{issue:3433,sha:sourceSha,developer:'dev-qwen-01',
    reviewer:'review-qwen-01',acceptor:'accept-qwen-01'},
  run:{repository:REPO,event:'workflow_dispatch',actor:'github-actions[bot]',
    workflow:'Acceptance / Agent Controller',
    workflow_path:'.github/workflows/acceptance-agent-controller.yml',
    ref:'refs/heads/main',head_sha:sourceSha,run_id:101,
    attempt:1,source_comment_id:202}};
const root={issue:3433,created:true,replayed:false,version:1,
  commit_sha:'c'.repeat(40),first_action_id:actionId};
const event={workflow_run:{id:101,run_attempt:1,head_sha:sourceSha,
  head_branch:'main',conclusion:'success',actor:{login:'github-actions[bot]'}}};
const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey
  .export({format:'pem',type:'pkcs8'}).toString();
const args={source,root,event,remote:'https://x-access-token:fake@github.com/'+REPO+'.git',
  token:'fake-token-for-test',privateKey:key,registry:{instances:{}},
  issuerRunId:9001};
let calls=0;
const send=async x=>{
  calls++;
  assert.equal(x.issue,3433);assert.equal(x.actionId,actionId);
  assert.equal(x.signer.issuer_run_id,9001);
  assert.equal(x.signer.key_id,'main-controller');
  assert.equal(x.signer.key.length,32);
  assert.equal(typeof x.sourceVerifier,'function');
  return {status:'dispatched',source_run_id:102};
};
const ok=await dispatchAuthenticatedBug({...args,dispatch:send});
assert.deepEqual(ok,{issue:3433,action_id:actionId,status:'dispatched',run_id:102});
assert.equal(calls,1);
for(const change of [
  {root:{...root,created:false}}, {root:{...root,version:2}},
  {root:{...root,first_action_id:'bad'}},
  {source:{...source,run:{...source.run,actor:'attacker'}}},
  {source:{...source,run:{...source.run,source_comment_id:0}}},
  {source:{...source,request:{...source.request,issue:99}}},
  {source:{...source,request:{...source.request,developer:'dev-cursor-01'}}},
  {event:{...event,workflow_run:{...event.workflow_run,conclusion:'failure'}}},
  {event:{...event,workflow_run:{...event.workflow_run,run_attempt:2}}},
]) await assert.rejects(
  dispatchAuthenticatedBug({...args,...change,dispatch:send}),
  /mismatched/);
assert.equal(calls,1,'rejected requests did not create dispatch tickets');
const uncertain=await dispatchAuthenticatedBug({...args,dispatch:async()=>({status:'ambiguous'})});
assert.equal(uncertain.status,'ambiguous');
await assert.rejects(dispatchAuthenticatedBug({...args,dispatch:async()=>({status:'green'})}),
  /unexpected trusted dispatch outcome/);
console.log('controller-bug-dispatch: signed root, producer provenance, one POST, ambiguous and negative boundaries passed');
