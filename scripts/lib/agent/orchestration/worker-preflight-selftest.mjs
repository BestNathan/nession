#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {startDevelopment,recordDispatchIntent,recordDispatch} from './outbox.mjs';
import {planGitHubDispatch} from './github-dispatch.mjs';
import {readIssueWorkflowState,writeIssueWorkflowState} from './state-store.mjs';
import {authorizeWorkerFromStore} from './worker-preflight.mjs';
import {publish} from '../../../run-store-cas-push.mjs';

const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nession-worker-auth-'));
const issue=1997,sha='a'.repeat(40),runId=33012;
const signer={key:Buffer.alloc(32,55),key_id:'controller-v1',issuer_run_id:902,
  now:Date.parse('2026-10-19T08:00:00Z'),ttl_ms:600000};
const identity={repository:'BestNathan/nession',event:'workflow_dispatch',
  permission:'write',ref:'refs/heads/main',run_id:902};
const request={issue,sha,developer:'dev-cursor-01',
  reviewer:'review-cursor-01',acceptor:'accept-cursor-01'};
const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{
  encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000}).trim();
try{
  const remote=path.join(root,'remote.git'),writer=path.join(root,'writer');
  fs.mkdirSync(writer);
  git(root,'init','--bare','remote.git');
  git(writer,'init');
  git(writer,'config','user.name','Worker Fixture');
  git(writer,'config','user.email','fixture@example.invalid');
  git(writer,'switch','--orphan','agent-store');
  git(writer,'commit','--allow-empty','-m','bootstrap agent-store');
  git(writer,'remote','add','origin',remote);
  git(writer,'push','origin','HEAD:refs/heads/agent-store');

  const state=startDevelopment(registry,request,identity);
  const action=state.outbox[0];
  const plan=planGitHubDispatch(state,action.id,registry,signer);
  const ticketSha256=createHash('sha256').update(plan.inputs.dispatch_ticket).digest('hex');
  const intent={status:'prepared',dispatch_id:action.id,issuer_run_id:902,
    ticket_sha256:ticketSha256};
  const prepared=recordDispatchIntent(state,1,action.id,intent);
  const acknowledged=recordDispatch(prepared,2,action.id,{
    status:'verified',dispatch_id:action.id,source_run_id:runId});
  const save=(version,record,prior)=>{
    writeIssueWorkflowState(writer,record,prior);
    git(writer,'add','-A');
    git(writer,'commit','-m','trusted Worker state '+version);
    publish('agent-store',writer,4);
  };
  save(1,state,0);
  const opts={remote,registry,role:'developer',runId,input:plan.inputs};
  assert.throws(()=>authorizeWorkerFromStore(opts),/no exact authenticated/);
  save(2,prepared,1);
  assert.throws(()=>authorizeWorkerFromStore(opts),/no exact authenticated/);
  save(3,acknowledged,2);
  const allowed=authorizeWorkerFromStore(opts);
  assert.equal(allowed.authorized,true);
  assert.equal(allowed.action_id,action.id);
  assert.equal(allowed.run_id,runId);
  assert.equal(allowed.agent_id,'dev-cursor-01');
  assert.equal(allowed.input_sha,sha);
  assert.equal(allowed.state_version,3);
  assert.equal(allowed.provider,'cursor');
  assert.equal(allowed.environment,'agent-dev-cursor-01');
  assert.equal(Object.hasOwn(allowed,'resume_from'),false);
  assert.equal(Object.hasOwn(allowed,'store_writer_token'),false);
  assert.throws(()=>authorizeWorkerFromStore({...opts,runId:runId+1}),
    /no exact authenticated/);
  assert.throws(()=>authorizeWorkerFromStore({...opts,role:'reviewer'}),
    /invalid or extra Worker input|differ from canonical/);
  assert.throws(()=>authorizeWorkerFromStore({...opts,input:{
    ...plan.inputs,agent_id:'dev-qwen-01'}}),/differ from canonical/);
  assert.throws(()=>authorizeWorkerFromStore({...opts,input:{
    ...plan.inputs,input_sha:'b'.repeat(40)}}),/differ from canonical/);
  assert.throws(()=>authorizeWorkerFromStore({...opts,input:{
    ...plan.inputs,issue_number:'1998'}}),/differ from canonical/);
  assert.throws(()=>authorizeWorkerFromStore({...opts,input:{
    ...plan.inputs,task:'repair'}}),/differ from canonical/);
  assert.throws(()=>authorizeWorkerFromStore({...opts,input:{
    ...plan.inputs,pr_write_token:'stolen'}}),/invalid or extra/);
  assert.throws(()=>authorizeWorkerFromStore({...opts,input:{
    ...plan.inputs,dispatch_ticket:plan.inputs.dispatch_ticket.slice(0,-2)+'AA'}}),
    /no immutable committed write-ahead|conflicting historic Ticket|invalid native Dispatch Ticket/);
  assert.throws(()=>authorizeWorkerFromStore({...opts,
    registry:{...registry,instances:{...registry.instances,
      'dev-cursor-01':{...registry.instances['dev-cursor-01'],role:'reviewer'}}}}),
    /unregistered Worker identity/);
  assert.throws(()=>authorizeWorkerFromStore({...opts,input:{
    ...plan.inputs,resume_from:'bad'}}),/differ from canonical/);
  console.log('Worker read-only preflight: real Git Store Run/ACK, committed Ticket SHA, registered role and forged/early execution negatives passed');
}finally{
  signer.key.fill(0);
  fs.rmSync(root,{recursive:true,force:true});
}
