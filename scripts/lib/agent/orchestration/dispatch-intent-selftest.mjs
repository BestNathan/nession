#!/usr/bin/env node
// #1664: Git CAS write-ahead Outbox dispatch intent and crash recovery.
// A persisted prepared ticket is never a second pending action. Only a
// trusted, run-bound GitHub response may change it to dispatched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {startDevelopment,recordDispatch,recordDispatchIntent,
  reconcileOutbox,validateDevelopmentState} from './outbox.mjs';
import {prepareGitHubDispatch,verifyPersistedDispatchIntent,
  createGitHubDispatchClient,planGitHubDispatch} from './github-dispatch.mjs';
import {readIssueWorkflowState,writeIssueWorkflowState} from './state-store.mjs';
import {publish} from '../../../run-store-cas-push.mjs';
import {commitDispatchIntent,acknowledgeCommittedDispatch,executeDurableAgentDispatch} from './dispatch-store.mjs';

const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-writeahead-outbox-'));
const key=Buffer.alloc(32,68),keyring={'main-controller':key};
const now=Date.parse('2026-10-19T06:00:00Z');
const issue=1997,sha='a'.repeat(40);
const request={issue,sha,developer:'dev-cursor-01',
  reviewer:'review-cursor-01',acceptor:'accept-cursor-01'};
const authority={repository:'BestNathan/nession',event:'workflow_dispatch',
  permission:'write',ref:'refs/heads/main',run_id:39213661257};
const signer={key,key_id:'main-controller',issuer_run_id:authority.run_id,now,ttl_ms:600000};
const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{
  encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000}).trim();
let remote,local;
function commit(next,expectedVersion,message) {
  writeIssueWorkflowState(local,next,expectedVersion);
  git(local,'add','-A');
  git(local,'-c','user.name=Trusted Controller Fixture',
    '-c','user.email=controller@example.invalid',
    'commit','-m',message);
  return publish('agent-store',local,4);
}
function clone(name) {
  const dir=path.join(root,name);
  git(root,'clone','--branch','agent-store',remote,dir);
  return dir;
}
try {
  remote=path.join(root,'remote.git');
  const seed=path.join(root,'seed');
  fs.mkdirSync(seed);
  git(root,'init','--bare','remote.git');
  git(seed,'init');
  git(seed,'config','user.name','Test');
  git(seed,'config','user.email','test@example.invalid');
  git(seed,'switch','--orphan','agent-store');
  git(seed,'commit','--allow-empty','-m','bootstrap orphan Store');
  git(seed,'remote','add','origin',remote);
  git(seed,'push','origin','HEAD:refs/heads/agent-store');
  local=clone('controller');
  const initial=startDevelopment(registry,request,authority);
  assert.equal(commit(initial,0,'initial Controller state').replayed,false);
  const next=reconcileOutbox(initial).pending[0];
  const {plan,prepared,intent}=prepareGitHubDispatch(initial,next.id,registry,signer);
  assert.equal(prepared.version,2);
  assert.equal(prepared.outbox[0].status,'dispatching');
  assert.equal(prepared.outbox[0].attempts,1);
  assert.equal(reconcileOutbox(prepared).pending.length,0);
  assert.equal(reconcileOutbox(prepared).awaiting_dispatch_receipt.length,1);
  assert.equal(reconcileOutbox(prepared).awaiting_evidence.length,0);
  assert.equal(recordDispatchIntent(prepared,prepared.version,next.id,intent),prepared);
  assert.throws(()=>recordDispatchIntent(prepared,prepared.version,next.id,
    {...intent,ticket_sha256:'f'.repeat(64)}),/conflicting/);
  assert.throws(()=>recordDispatchIntent(initial,initial.version+1,next.id,intent),/stale/);
  assert.throws(()=>validateDevelopmentState({...prepared,
    outbox:[{...prepared.outbox[0],receipt:{...intent,issuer_run_id:0}}]}),
    /invalid persisted/);
  assert.throws(()=>verifyPersistedDispatchIntent({
    state:initial,plan,keyring,now}),/not persisted/);
  assert.throws(()=>verifyPersistedDispatchIntent({
    state:prepared,plan,keyring:{'main-controller':Buffer.alloc(32,23)},now}),/HMAC/);
  assert.throws(()=>verifyPersistedDispatchIntent({
    state:prepared,plan:{...plan,inputs:{...plan.inputs,issue_number:'9999'}},keyring,now}),
    /diverges/);
  assert.throws(()=>planGitHubDispatch(prepared,next.id,registry,signer),
    /not pending/);

  // A real Git push must happen before any external GitHub POST.
  const written=commitDispatchIntent({remote,issue,actionId:next.id,registry,signer});
  assert.equal(written.status,'committed');
  assert.deepEqual(written.plan,plan);
  assert.match(written.store_commit_sha,/^[a-f0-9]{40}$/);
  const blocked=commitDispatchIntent({remote,issue,actionId:next.id,registry,signer});
  assert.equal(blocked.status,'reconcile');
  assert.equal(blocked.action_status,'dispatching');
  assert.equal(blocked.store_commit_sha,written.store_commit_sha);
  assert.equal(Object.hasOwn(blocked,'plan'),false,
    'a restarted trusted Controller must never get a second POST plan');
  const resumed=clone('recover-from-new-controller-run');
  const loaded=readIssueWorkflowState(resumed,issue);
  assert.equal(loaded.version,2);
  assert.deepEqual(reconcileOutbox(loaded.state).pending,[],
    'crash after HTTP acceptance cannot automatically redispatch');
  assert.equal(reconcileOutbox(loaded.state).awaiting_dispatch_receipt.length,1);
  const auth=verifyPersistedDispatchIntent({state:loaded.state,plan,keyring,now});
  assert.equal(auth.ticket_sha256,intent.ticket_sha256);
  assert.equal(auth.issuer_run_id,authority.run_id);
  assert.equal(auth.state_version,2);
  assert.throws(()=>recordDispatchIntent(loaded.state,loaded.version,
    next.id,{...intent,issuer_run_id:124}),/conflicting/);

  // A real authenticated HTTP 200 response resolves the ambiguous intent;
  // a HTTP 204 must remain accepted/ambiguous and cannot attest model results.
  let posts=0;
  const client=createGitHubDispatchClient('trustedActionsWriter',{keyring,now,
    fetchFn:async()=>{posts++;
      return {status:200,json:async()=>({workflow_run_id:5001,
        run_url:'https://api.github.com/repos/BestNathan/nession/actions/runs/5001'})};
    }});
  const answer=await client(plan);
  assert.equal(posts,1);
  const acknowledged=recordDispatch(loaded.state,loaded.version,next.id,answer);
  assert.equal(acknowledged.version,3);
  assert.equal(acknowledged.outbox[0].attempts,1,
    'write-ahead intent consumes an attempt exactly once');
  assert.equal(acknowledged.outbox[0].receipt.source_run_id,5001);
  assert.equal(reconcileOutbox(acknowledged).awaiting_dispatch_receipt.length,0);
  assert.equal(reconcileOutbox(acknowledged).awaiting_evidence.length,1);
  assert.equal(recordDispatch(acknowledged,acknowledged.version,next.id,answer),acknowledged);
  assert.throws(()=>recordDispatch(acknowledged,acknowledged.version,next.id,
    {...answer,source_run_id:5002}),/conflicting/);

  const ack=acknowledgeCommittedDispatch({remote,issue,actionId:next.id,
    ticketSha256:intent.ticket_sha256,receipt:answer});
  assert.equal(ack.status,'acknowledged');
  assert.equal(ack.state_version,3);
  const ackReplay=acknowledgeCommittedDispatch({remote,issue,actionId:next.id,
    ticketSha256:intent.ticket_sha256,receipt:answer});
  assert.equal(ackReplay.status,'replayed');
  assert.equal(ackReplay.store_commit_sha,ack.store_commit_sha);
  assert.throws(()=>acknowledgeCommittedDispatch({remote,issue,actionId:next.id,
    ticketSha256:'f'.repeat(64),receipt:answer}),/unmatched immutable/);
  assert.throws(()=>acknowledgeCommittedDispatch({remote,issue,actionId:next.id,
    ticketSha256:intent.ticket_sha256,receipt:{...answer,source_run_id:5002}}),
    /conflicting/);
  assert.throws(()=>acknowledgeCommittedDispatch({remote,issue,actionId:next.id,
    ticketSha256:'0'.repeat(64),receipt:{status:'accepted',dispatch_id:next.id}}),
    /missing authenticated/);
  const final=readIssueWorkflowState(clone('third-reader'),issue);
  assert.equal(final.version,3);
  assert.equal(final.state.outbox[0].receipt.source_run_id,5001);
  assert.equal(final.state.outbox[0].attempts,1);
  // No-op retry does not create a second Git commit or API call.
  assert.equal(posts,1);
  // Complete one-shot Driver flow on the SAME real bare remote. The HTTP fake
  // is allowed only in fixture test mode and checks independent Store readback.
  const previousLocal=local;
  const beforeNodeEnv=process.env.NODE_ENV;
  process.env.NODE_ENV='test';
  const seedIndependent=(fixtureIssue)=>{
    local=clone('init-'+fixtureIssue);
    const req={...request,issue:fixtureIssue};
    const fresh=startDevelopment(registry,req,authority);
    commit(fresh,0,'initialize independently controlled Issue '+fixtureIssue);
    return fresh.outbox[0].id;
  };
  try{
    const runIssue=3002,runAction=seedIndependent(runIssue);
    let driverPosts=0;
    const success=await executeDurableAgentDispatch({
      remote,issue:runIssue,actionId:runAction,registry,signer,now,
      actionsToken:'trustedActionsWriter',
      fetchFn:async(url,options)=>{
        driverPosts++;
        assert.ok(url.endsWith('/actions/workflows/agent-develop.yml/dispatches'));
        const checkpoint=readIssueWorkflowState(clone('driver-post-check-'+driverPosts),runIssue);
        assert.equal(checkpoint.version,2,
          'the remote CAS intent must exist BEFORE the first GitHub API POST');
        assert.equal(checkpoint.state.outbox[0].status,'dispatching');
        assert.equal(options.method,'POST');
        return {status:200,json:async()=>({workflow_run_id:7002,
          run_url:'https://api.github.com/repos/BestNathan/nession/actions/runs/7002'})};
      },
    });
    assert.equal(success.status,'dispatched');
    assert.equal(success.source_run_id,7002);
    assert.equal(driverPosts,1);
    const replay=await executeDurableAgentDispatch({
      remote,issue:runIssue,actionId:runAction,registry,signer,now,
      actionsToken:'trustedActionsWriter',
      fetchFn:async()=>{throw Error('must not dispatch again');},
    });
    assert.equal(replay.status,'reconcile');
    assert.equal(replay.action_status,'dispatched');
    assert.equal(replay.store_commit_sha,success.store_commit_sha);
    assert.equal(driverPosts,1);
    assert.equal(readIssueWorkflowState(clone('driver-success-readback'),runIssue)
      .state.outbox[0].receipt.source_run_id,7002);

    const ambiguousIssue=3003,ambiguousAction=seedIndependent(ambiguousIssue);
    let ambiguousPosts=0;
    const ambiguous=await executeDurableAgentDispatch({
      remote,issue:ambiguousIssue,actionId:ambiguousAction,registry,signer,now,
      actionsToken:'trustedActionsWriter',
      fetchFn:async()=>{ambiguousPosts++;return {status:204};},
    });
    assert.equal(ambiguous.status,'ambiguous');
    assert.equal(ambiguousPosts,1);
    const uncertain=await executeDurableAgentDispatch({
      remote,issue:ambiguousIssue,actionId:ambiguousAction,registry,signer,now,
      actionsToken:'trustedActionsWriter',
      fetchFn:async()=>{ambiguousPosts++;throw Error('unexpected repeated POST');},
    });
    assert.equal(uncertain.status,'reconcile');
    assert.equal(uncertain.action_status,'dispatching');
    assert.equal(ambiguousPosts,1);
    assert.equal(readIssueWorkflowState(clone('driver-204-readback'),ambiguousIssue)
      .state.outbox[0].status,'dispatching');

    const offlineIssue=3004,offlineAction=seedIndependent(offlineIssue);
    let offlinePosts=0;
    await assert.rejects(()=>executeDurableAgentDispatch({
      remote,issue:offlineIssue,actionId:offlineAction,registry,signer,now,
      actionsToken:'trustedActionsWriter',
      fetchFn:async()=>{offlinePosts++;throw Error('timeout-after-GitHub-POST');},
    }),/timeout-after-GitHub-POST/);
    assert.equal(offlinePosts,1);
    const offline=await executeDurableAgentDispatch({
      remote,issue:offlineIssue,actionId:offlineAction,registry,signer,now,
      actionsToken:'trustedActionsWriter',
      fetchFn:async()=>{offlinePosts++;throw Error('forbidden redelivery');},
    });
    assert.equal(offline.status,'reconcile');
    assert.equal(offlinePosts,1);
    assert.equal(readIssueWorkflowState(clone('driver-offline-readback'),offlineIssue)
      .state.outbox[0].status,'dispatching');

    // Mock endpoints must never be injectable by a production Controller.
    delete process.env.NODE_ENV;
    await assert.rejects(()=>executeDurableAgentDispatch({
      remote,issue:3005,actionId:runAction,registry,signer,now,
      actionsToken:'trustedActionsWriter',fetchFn:async()=>({status:200}),
    }),/mock Actions client unavailable outside fixture/);
  }finally{
    local=previousLocal;
    if(beforeNodeEnv===undefined)delete process.env.NODE_ENV;
    else process.env.NODE_ENV=beforeNodeEnv;
  }

  console.log('Write-ahead dispatch: real Git CAS, pending->prepared->acknowledged, crash/no-redelivery, exact HMAC ticket and replay denial passed');
}finally{
  key.fill(0);
  fs.rmSync(root,{recursive:true,force:true});
}
