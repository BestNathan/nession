#!/usr/bin/env node
// #3885: independently observed partial Qwen Publisher failure. The single
// Owner command grants GET-only readback of the already-created PR, not another
// GitHub mutation or Publisher Intent. Negative trust/identity/Run fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {ORIGINAL,COMMAND,assertOwnerQwenPublisherRecovery,
  getOnlyQwenPrApi,recoverOriginalQwenPublisher}
  from './qwen-publisher-reconcile.mjs';
import {readCommittedQwenPublisherIntent}
  from './store-intent.mjs';
const s=ORIGINAL,repo='BestNathan/nession';
const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:repo,
  GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'issue_comment',
  GITHUB_WORKFLOW:'Store / Qwen Publisher',GITHUB_RUN_ATTEMPT:'1',
  GITHUB_ACTOR:'BestNathan',GITHUB_SHA:'f'.repeat(40),
  GITHUB_RUN_ID:'9990001'};
const event={action:'created',repository:{full_name:repo},
  issue:{number:s.issue,state:'open'},
  comment:{id:69770001,user:{login:'BestNathan'},body:COMMAND}};
const sourceRun={id:s.publisher_run_id,run_attempt:1,
  name:'Store / Qwen Publisher',
  path:'.github/workflows/store-qwen-publisher.yml',
  event:'workflow_run',head_sha:s.target_sha,head_branch:'main',
  actor:{login:'BestNathan'},repository:{full_name:repo},
  head_repository:{full_name:repo},created_at:'2026-11-18T10:00:13Z',
  status:'completed',conclusion:'failure'};
const jobs={total_count:3,jobs:[
  {name:'detect',conclusion:'success'},
  {name:'publish',conclusion:'failure',steps:[
    {name:'Authenticate original Qwen and publish/reconcile one real PR',
      conclusion:'failure'},
    {name:'Publish bounded Developer v2 producer and Store writer receipt',
      conclusion:'skipped'},
  ]},
  {name:'wake-reviewer',conclusion:'skipped'},
]};
const ingester={id:s.ingester_run_id,run_attempt:1,
  name:'Store / Agent Development Ingest',
  path:'.github/workflows/store-agent-development-ingest.yml',
  status:'completed',conclusion:'success',event:'issue_comment',
  head_branch:'main',head_sha:s.target_sha,actor:{login:'BestNathan'},
  repository:{full_name:repo},head_repository:{full_name:repo}};
const receipt={schema_version:1,
  kind:'authenticated_qwen_development_checkpoint_receipt',
  status:'committed',issue:s.issue,
  ingester_run_id:s.ingester_run_id,ingester_sha:s.target_sha,
  action_id:s.action_id,run_id:s.worker_run_id,attempt:1,
  worker_sha:'d112a26c69a3e7e694b32152d61883c957c3f17b',
  checkpoint_version:1,checkpoint_commit_sha:s.checkpoint_sha,
  ciphertext_sha256:'2c7faf10c4648ad21698cb4e4d34caa9acda11c7e62e504a51768891abc1b052'};
const valid={env,event,run:sourceRun,jobs,receipt,ingester};
assert.deepEqual(assertOwnerQwenPublisherRecovery(valid),
  {issue:s.issue,run_id:s.publisher_run_id,pr:s.pr});
for(const bad of [
  {env:{...env,GITHUB_ACTOR:'github-actions[bot]'}},
  {env:{...env,GITHUB_EVENT_NAME:'workflow_dispatch'}},
  {env:{...env,GITHUB_RUN_ATTEMPT:'2'}},
  {env:{...env,GITHUB_REF:'refs/heads/staging'}},
  {env:{...env,GITHUB_WORKFLOW:'Agent / Development'}},
  {event:{...event,action:'edited'}},
  {event:{...event,issue:{number:s.issue,state:'closed'}}},
  {event:{...event,issue:{number:s.issue+1,state:'open'}}},
  {event:{...event,issue:{number:s.issue,state:'open',pull_request:{}}}},
  {event:{...event,comment:{...event.comment,id:0}}},
  {event:{...event,comment:{...event.comment,body:COMMAND+' '}}},
  {event:{...event,comment:{...event.comment,
    body:COMMAND.replace(String(s.publisher_run_id),'0')}}},
  {event:{...event,comment:{...event.comment,user:{login:'attacker'}}}},
  {run:{...sourceRun,id:s.publisher_run_id+1}},
  {run:{...sourceRun,head_sha:'0'.repeat(40)}},
  {run:{...sourceRun,conclusion:'success'}},
  {run:{...sourceRun,run_attempt:2}},
  {run:{...sourceRun,event:'workflow_dispatch'}},
  {jobs:{...jobs,total_count:4}},
  {jobs:{...jobs,jobs:jobs.jobs.map(x=>x.name==='publish'?
    {...x,steps:[]} : x)}},
  {jobs:{...jobs,jobs:jobs.jobs.map(x=>x.name==='wake-reviewer'?
    {...x,conclusion:'success'}:x)}},
  {ingester:{...ingester,id:s.ingester_run_id+1}},
  {ingester:{...ingester,head_sha:'0'.repeat(40)}},
  {receipt:{...receipt,action_id:'a'.repeat(64)}},
  {receipt:{...receipt,checkpoint_commit_sha:'0'.repeat(40)}},
]){
  assert.throws(()=>assertOwnerQwenPublisherRecovery({...valid,...bad}),
    /Qwen original Publisher GET-only recovery|trusted Qwen Publisher Runner/);
}
// A recovery Get-only API client must categorically reject PR creation,
// branch edits, unrelated PR identities, or extra parameters, even when a
// caller obtains a bearer token. These calls do not perform any HTTP request.
const api=getOnlyQwenPrApi('fake-test-token-no-network');
for(const [method,url,payload] of [
  ['POST','pulls',{}],
  ['PATCH','git/refs/heads/agent/3784/qwen-bad',{}],
  ['GET','pulls/3918'],
  ['GET','git/ref/heads/main'],
  ['GET','pulls/3919',{}],
  ['POST','git/commits',{message:'unsafe'}],
])await assert.rejects(api(method,url,payload),
  /GitHub write or unrelated PR read forbidden/);
assert.throws(()=>getOnlyQwenPrApi('bad token with spaces'),
  /read-only GitHub token/);
// No immutable original Intent must NEVER produce a replacement Intent,
// PR write, or Store mutation. Test against a real local orphan git remote.
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-pr-get-only-'));
try{
  const bare=path.join(tmp,'bare.git'),work=path.join(tmp,'work');
  execFileSync('git',['init','--bare',bare],{stdio:'ignore'});
  execFileSync('git',['clone',bare,work],{stdio:'ignore'});
  const git=(...args)=>execFileSync('git',['-C',work,...args],{
    encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000,
  }).trim();
  git('config','user.name','Qwen GET-only Fixture');
  git('config','user.email','qwen-fixture@example.invalid');
  git('checkout','--orphan','agent-store');
  git('commit','--allow-empty','-m','Empty original Store');
  git('push','-u','origin','agent-store');
  const old=git('rev-parse','HEAD');
  const args={remote:'file://'+bare,issue:s.issue,action_id:s.action_id,
    worker_run_id:s.worker_run_id,publisher_run_id:s.publisher_run_id};
  assert.throws(()=>readCommittedQwenPublisherIntent(args),
    /no original Qwen Publisher Intent/);
  assert.throws(()=>readCommittedQwenPublisherIntent({...args,
    publisher_run_id:0}),/invalid read-only Qwen Publisher recovery identity/);
  git('fetch','origin','agent-store');
  assert.equal(git('rev-parse','FETCH_HEAD'),old);
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
// An invalid Worker cannot trigger either Store readback or Publisher handoff.
let readCalls=0,writeCalls=0;
await assert.rejects(recoverOriginalQwenPublisher({
  ...valid,originalRun:sourceRun,originalJobs:jobs,
  worker:{id:s.worker_run_id+1,run_attempt:1,conclusion:'success',
    status:'completed',head_branch:'main',actor:{login:'github-actions[bot]'}},
  artifacts:{artifacts:[]},claimZip:Buffer.from('fake'),
  resultZip:Buffer.from('fake'),sourceCheckout:'/no-execution',
  reader:{},registry:{},api:()=>{},remote:'file:///invalid',
  readIntent:()=>{readCalls++;return null;},
  storeHandoff:()=>{writeCalls++;return null;},
}),/original successful Worker identity/);
assert.equal(readCalls,0);
assert.equal(writeCalls,0);
console.log('Qwen Publisher GET-only recovery: exact original Owner/Run/Intent authority, write denial, empty Store nonmutation, failed source negatives pass');
