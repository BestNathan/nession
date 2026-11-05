// Exact historical Reviewer recovery: a REAL disposable bare Git Store and
// one authenticated successful POST. Post must never happen before Store CAS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {writeIssueWorkflowState,readIssueWorkflowState} from './state-store.mjs';
import {executeControlledReviewerRecovery} from './dispatch-store.mjs';
import {verifyDispatchTicket} from './github-dispatch.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'controlled-reviewer-recovery-'));
const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{
  encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000}).trim();
const id='555b3351ddb8c7ddbc23ba789f8a8a9560a01cc3112834f15492382e13af4434';
const reviewSha='3d8e3807cc01f6082734b8d0ba458217c28f60a4';
const source={verified:true,run_id:39943178597,attempt:1,conclusion:'skipped'};
const now=Date.parse('2026-10-23T13:00:00Z');
const key=Buffer.alloc(32,0x57);
const signer={key,key_id:'main-controller',issuer_run_id:222,now,ttl_ms:600000};
const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const seedState={schema_version:1,issue:1997,version:19,phase:'review',
  target_sha:reviewSha,repair_attempts:0,transitions:[{
    kind:'publisher',run_id:39609600546,attempt:1,
    target_sha:reviewSha,outcome:'published'}],
  assignments:{developer:'dev-cursor-01',reviewer:'review-qwen-01',
    acceptor:'accept-cursor-01'},
  outbox:[{id,task:{type:'dispatch',role:'reviewer',task:'review',
    sha:reviewSha,agent_id:'review-qwen-01'},status:'dispatched',
    attempts:1,receipt:{status:'verified',dispatch_id:id,
      source_run_id:39943178597}}],
};
let remote;
const clone=(name)=>{
  const target=path.join(root,name);
  git(root,'clone','--quiet','--single-branch','--branch','agent-store',remote,target);
  return target;
};
try{
  remote=path.join(root,'remote.git');
  const seed=path.join(root,'seed');
  fs.mkdirSync(seed);
  git(root,'init','--quiet','--bare','remote.git');
  git(seed,'init','--quiet');
  git(seed,'config','user.name','Recovery Fixture');
  git(seed,'config','user.email','recovery@example.invalid');
  git(seed,'switch','--orphan','agent-store');
  for(let version=1;version<=19;version++){
    writeIssueWorkflowState(seed,{...seedState,version},version-1);
  }
  git(seed,'add','-A');
  git(seed,'commit','-qm','historical immutable Reviewer action');
  git(seed,'remote','add','origin',remote);
  git(seed,'push','--quiet','origin','HEAD:refs/heads/agent-store');
  assert.equal(readIssueWorkflowState(clone('before'),1997).version,19);
  const oldEnv=process.env.NODE_ENV;
  process.env.NODE_ENV='test';
  try{
    let posts=0;
    const opts={remote,registry,signer,actionsToken:'trustedActionsWriter',
      source,fetchFn:async(url,params)=>{
        posts++;
        assert.ok(url.endsWith('/actions/workflows/agent-review.yml/dispatches'));
        assert.equal(params.method,'POST');
        const body=JSON.parse(params.body);
        const bound=verifyDispatchTicket(body.inputs.dispatch_ticket,
          {'main-controller':key},{now});
        assert.equal(bound.action_id,id);
        assert.equal(bound.issue,1997);
        assert.equal(bound.state_version,19);
        assert.equal(bound.input_sha,reviewSha);
        const stored=readIssueWorkflowState(clone('after-post-'+posts),1997);
        assert.equal(stored.version,20,'CAS intent must exist BEFORE external POST');
        assert.equal(stored.state.outbox[0].receipt.source_run_id,39943178597);
        assert.equal(stored.state.outbox[0].receipt.reviewer_recovery.issuer_run_id,222);
        return {status:200,json:async()=>({
          workflow_run_id:400001,
          run_url:'https://api.github.com/repos/BestNathan/nession/actions/runs/400001'})};
      }};
    const recovered=await executeControlledReviewerRecovery(opts);
    assert.equal(recovered.status,'dispatched');
    assert.equal(recovered.source_run_id,400001);
    assert.equal(recovered.state_version,20);
    assert.equal(posts,1);
    const twice=await executeControlledReviewerRecovery({...opts,
      fetchFn:async()=>{throw Error('no second workflow_dispatch permitted');}});
    assert.equal(twice.status,'reconcile');
    assert.equal(posts,1);
    assert.equal(readIssueWorkflowState(clone('after-replay'),1997).version,20);
    await assert.rejects(()=>executeControlledReviewerRecovery({...opts,
      source:{...source,verified:false}}),/authenticated old Run/);
  }finally{process.env.NODE_ENV=oldEnv;}
}finally{
  key.fill(0);
  fs.rmSync(root,{recursive:true,force:true});
}
console.log('Controlled Reviewer one-time Git CAS fence and signed POST/replay passed');
