#!/usr/bin/env node
// Real Git remote + signed Controller dispatch: checkpoint-bound resumability.
// No external API, Provider secret, or GitHub writer needed in this fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {startDevelopment,recordDispatch,recordSliceYield,reconcileOutbox} from './outbox.mjs';
import {issueDispatchTicket,verifyDispatchTicket,planGitHubDispatch,
  createGitHubDispatchClient,authorizeNativeContinuation,
  acceptAttestedSliceYield} from './github-dispatch.mjs';
import {sealCheckpoint} from '../store/checkpoint.mjs';
import {publishEncryptedAgentCheckpoint,verifyCommittedCheckpoint} from '../store/remote.mjs';

const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const issue=1664,sha='b'.repeat(40),main='a'.repeat(40);
const key=Buffer.alloc(32,0x5c),storeKey=Buffer.alloc(32,0x33);
const keyring={'control-v1':key};
const now=Date.parse('2026-10-19T08:00:00Z');
const issuer={key,key_id:'control-v1',issuer_run_id:124,now,ttl_ms:600000};
function git(folder,...args){
  return execFileSync('git',['-C',folder,...args],{
    encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000}).trim();
}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nession-continuation-dispatch-'));
try{
  const remote=path.join(root,'remote.git'),sourceFolder=path.join(root,'seed');
  fs.mkdirSync(sourceFolder);
  git(root,'init','--bare','remote.git');
  git(sourceFolder,'init');
  git(sourceFolder,'config','user.name','Nession checkpoint fixture');
  git(sourceFolder,'config','user.email','fixture@example.invalid');
  git(sourceFolder,'switch','--orphan','agent-store');
  git(sourceFolder,'commit','--allow-empty','-m','agent-store fixture');
  git(sourceFolder,'remote','add','origin',remote);
  git(sourceFolder,'push','origin','HEAD:refs/heads/agent-store');

  const request={issue,sha,developer:'dev-cursor-01',reviewer:'review-cursor-01',
    acceptor:'accept-cursor-01'};
  const authority={repository:'BestNathan/nession',event:'workflow_dispatch',
    permission:'write',ref:'refs/heads/main',run_id:124};
  let state=startDevelopment(registry,request,authority);
  const first=reconcileOutbox(state).pending[0];
  const v1=planGitHubDispatch(state,first.id,registry,issuer);
  assert.equal(verifyDispatchTicket(v1.inputs.dispatch_ticket,keyring,{now}).schema_version,1);
  assert.equal(Object.hasOwn(v1.inputs,'resume_from'),false);
  state=recordDispatch(state,state.version,first.id,
    {status:'verified',dispatch_id:first.id,source_run_id:501});

  const developer={repository:'BestNathan/nession',run_id:501,attempt:1,issue,
    workflow_sha:main,target_sha:sha,head_branch:'main',
    path:'.github/workflows/agent-develop.yml',workflow_name:'Agent / Development',
    role:'developer',agent_id:'dev-cursor-01',task:'implement',
    environment:'agent-dev-cursor-01',provider:'cursor',event:'workflow_dispatch'};
  const identity={role:'developer',agent_id:'dev-cursor-01',issue};
  const checkpoint=sealCheckpoint(identity,1,Buffer.from('synthetic native cursor checkpoint'),
    storeKey,{provider:'cursor',session_id:'native-session-501',
    source_sha:sha,harness_digest:'c'.repeat(64)});
  const published=publishEncryptedAgentCheckpoint({
    remote,source:developer,sealed:checkpoint,registry,key:storeKey,expectedVersion:0,
  });
  assert.equal(published.version,1);
  const proven=verifyCommittedCheckpoint({remote,identity,
    commit_sha:published.commit_sha,version:1,
    ciphertext_sha256:checkpoint.ciphertext_sha256});
  assert.equal(proven.current_store_sha,published.commit_sha);
  const controllerRun={id:124,path:'.github/workflows/acceptance-agent-controller.yml',
    name:'Acceptance / Agent Controller',event:'workflow_dispatch',head_branch:'main',
    head_sha:main,repository:{full_name:'BestNathan/nession'},
    head_repository:{full_name:'BestNathan/nession'}};
  const workerRun={id:501,run_attempt:1,path:developer.path,
    name:developer.workflow_name,event:'workflow_dispatch',head_branch:'main',
    head_sha:main,repository:{full_name:'BestNathan/nession'},
    head_repository:{full_name:'BestNathan/nession'},status:'completed',
    conclusion:'success',created_at:new Date(now+5000).toISOString()};
  const sources=new Map([[124,controllerRun],[501,workerRun]]);
  const reader={getRun:async id=>structuredClone(sources.get(id))};
  const attestedParams={state,dispatch_ticket:v1.inputs.dispatch_ticket,keyring,reader,
    remote,now,verified_main_sha:main,
    checkpoint:{version:1,commit_sha:published.commit_sha,
      ciphertext_sha256:checkpoint.ciphertext_sha256,run_id:501,attempt:1}};
  await assert.rejects(()=>acceptAttestedSliceYield({...attestedParams,
    checkpoint:{...attestedParams.checkpoint,run_id:777}}),/run-bound dispatch/);
  await assert.rejects(()=>acceptAttestedSliceYield({...attestedParams,
    checkpoint:{...attestedParams.checkpoint,commit_sha:'f'.repeat(40)}}),/git merge-base|failed/);
  sources.set(501,{...workerRun,head_repository:{full_name:'untrusted/fork'}});
  await assert.rejects(()=>acceptAttestedSliceYield(attestedParams),/Worker did not execute/);
  sources.set(501,workerRun);
  sources.set(124,{...controllerRun,path:'.github/workflows/evil.yml'});
  await assert.rejects(()=>acceptAttestedSliceYield(attestedParams),/not the trusted Controller/);
  sources.set(124,controllerRun);
  state=await acceptAttestedSliceYield(attestedParams);
  assert.equal(state.phase,'ready');
  assert.equal(reconcileOutbox(state).yielded.length,1);
  assert.equal(await acceptAttestedSliceYield({...attestedParams,state}),state,
    'identical authenticated Store/Run Yield is an idempotent acknowledgement');
  const next=reconcileOutbox(state).pending[0];
  const signed=issueDispatchTicket(state,next.id,registry,issuer);
  assert.equal(signed.body.schema_version,2);
  assert.deepEqual(signed.body.resume_from,next.task.continuation);
  const plan=planGitHubDispatch(state,next.id,registry,issuer);
  const parsed=JSON.parse(Buffer.from(plan.inputs.resume_from,'base64url').toString('utf8'));
  assert.deepEqual(parsed,next.task.continuation);
  const authenticated=authorizeNativeContinuation({
    state,dispatch_ticket:plan.inputs.dispatch_ticket,keyring,remote,now,
  });
  assert.equal(authenticated.checkpoint_commit_sha,published.commit_sha);
  assert.equal(authenticated.checkpoint_version,1);
  assert.equal(authenticated.action_id,next.id);
  assert.equal(authenticated.parent_action_id,first.id);
  assert.equal(authenticated.current_store_sha,published.commit_sha);

  const posted=[];
  const dispatch=createGitHubDispatchClient('credentialedControllerToken',{
    keyring,now,fetchFn:async(url,params)=>{
      posted.push({url,params});
      return {status:200,json:async()=>({workflow_run_id:777,
        run_url:'https://api.github.com/repos/BestNathan/nession/actions/runs/777'})};
    },
  });
  const receipt=await dispatch(plan);
  assert.equal(receipt.source_run_id,777);
  assert.equal(JSON.parse(posted[0].params.body).inputs.resume_from,plan.inputs.resume_from);
  await assert.rejects(()=>dispatch({...plan,inputs:{...plan.inputs,
    resume_from:Buffer.from('{}').toString('base64url')}}),/signed Outbox ticket/);
  await assert.rejects(()=>dispatch({...plan,inputs:{...plan.inputs,
    resume_from:undefined}}),/signed Outbox ticket/);
  await assert.rejects(()=>dispatch({...v1,inputs:{...v1.inputs,
    resume_from:plan.inputs.resume_from}}),/signed Outbox ticket/);

  assert.throws(()=>authorizeNativeContinuation({
    state,dispatch_ticket:v1.inputs.dispatch_ticket,keyring,remote,now,
  }),/signed v2/);
  assert.throws(()=>authorizeNativeContinuation({
    state,dispatch_ticket:plan.inputs.dispatch_ticket,
    keyring:{'control-v1':Buffer.alloc(32,13)},remote,now,
  }),/HMAC/);
  assert.throws(()=>authorizeNativeContinuation({
    state,dispatch_ticket:plan.inputs.dispatch_ticket,keyring,remote,
    now:now+700000,
  }),/validity window/);
  assert.throws(()=>authorizeNativeContinuation({
    state:{...state,assignments:{...state.assignments,developer:'dev-qwen-01'}},
    dispatch_ticket:plan.inputs.dispatch_ticket,keyring,remote,now,
  }),/another Issue\/Agent/);

  // Another Agent may advance the Store branch without invalidating this
  // Agent's signed checkpoint; the tree and ancestry remain independently true.
  const reviewer={...developer,role:'reviewer',agent_id:'review-cursor-01',
    path:'.github/workflows/agent-review.yml',workflow_name:'Agent / Review',
    environment:'agent-review-cursor-01',task:'review',run_id:502};
  const reviewerId={role:'reviewer',agent_id:'review-cursor-01',issue};
  const reviewed=sealCheckpoint(reviewerId,1,Buffer.from('reviewer opaque state'),
    storeKey,{provider:'cursor',session_id:'review-session',
      source_sha:sha,harness_digest:'c'.repeat(64)});
  const other=publishEncryptedAgentCheckpoint({remote,source:reviewer,
    sealed:reviewed,registry,key:storeKey,expectedVersion:0});
  assert.notEqual(other.commit_sha,published.commit_sha);
  assert.equal(authorizeNativeContinuation({
    state,dispatch_ticket:plan.inputs.dispatch_ticket,keyring,remote,now,
  }).current_store_sha,other.commit_sha);

  // Same Agent's newer checkpoint makes the signed old state stale.
  const advanced=sealCheckpoint(identity,2,Buffer.from('new cursor checkpoint'),storeKey,
    {provider:'cursor',session_id:'native-session-501',
      source_sha:sha,harness_digest:'c'.repeat(64)});
  publishEncryptedAgentCheckpoint({remote,source:{...developer,run_id:503},
    sealed:advanced,registry,key:storeKey,expectedVersion:1});
  assert.throws(()=>authorizeNativeContinuation({
    state,dispatch_ticket:plan.inputs.dispatch_ticket,keyring,remote,now,
  }),/checkpoint advanced/);
  assert.throws(()=>verifyCommittedCheckpoint({remote,identity,
    commit_sha:'f'.repeat(40),version:1,
    ciphertext_sha256:checkpoint.ciphertext_sha256}),/git merge-base|failed/);
  console.log('Durable Dispatch: v1 compatible, signed v2 checkpoint, real Git ancestry, rival writer and stale/fork denial passed');
}finally{
  key.fill(0);storeKey.fill(0);
  fs.rmSync(root,{recursive:true,force:true});
}
