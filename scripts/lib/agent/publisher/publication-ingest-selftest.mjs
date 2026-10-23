#!/usr/bin/env node
// #2252 follow-up: verified Publisher publication → Store Reviewer handoff.
// All GitHub sources are unprivileged shaped fixtures; the Store is a
// disposable local checkout seeded from the real #1997 v16 state.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTROLLED_1997_POLICY as SOURCE } from './controlled-proposal.mjs';
import { planControlledPublisherIntent, CONTROLLED_PUBLISHER_INTENT_PATH } from './store-intent.mjs';
import { CONTROLLED_ORIGINAL_PUBLICATION as P } from './publication-readback.mjs';
import { fetchControlledPublication, applyPublisherReviewHandoff,
  applyPublicationToRemote, assertTrustedMainWorkflow } from './publication-ingest.mjs';

const REPO='BestNathan/nession';
const sourceRun={
  id:P.publisher_run,run_attempt:1,name:'Store / Controlled Publisher',
  path:'.github/workflows/store-controlled-publisher.yml',
  event:'issue_comment',actor:{login:'BestNathan'},
  head_branch:'main',head_sha:P.publisher_main_sha,
  repository:{full_name:REPO},head_repository:{full_name:REPO},
  status:'completed',conclusion:'success',
  created_at:'2026-10-21T13:37:20Z',
};
const sourceJobs={total_count:1,jobs:[{id:50,run_id:P.publisher_run,name:'publish',
  status:'completed',conclusion:'success'}]};
const ownerComment={id:P.command_comment_id,user:{login:'BestNathan'},
  issue_url:'https://api.github.com/repos/'+REPO+'/issues/1997',
  body:'/nession publish issue=1997 worker_run=39448549052 checkpoint=3',
  created_at:'2026-10-21T13:37:18Z'};
const intent=planControlledPublisherIntent({target_main_sha:P.publisher_main_sha,
  patch_sha256:P.original_patch_sha256,issuer_run_id:P.publisher_run});
const pullRequest={number:P.original_pr,state:'open',
  html_url:'https://github.com/'+REPO+'/pull/'+P.original_pr,
  user:{login:'nession-publisher[bot]'},
  base:{ref:'main',repo:{full_name:REPO}},
  head:{ref:P.branch,repo:{full_name:REPO},sha:P.original_pr_sha}};
const branchRef={ref:'refs/heads/'+P.branch,object:{sha:P.original_pr_sha}};
const pullCommits=[{sha:P.original_pr_sha}];
const originalCommit={sha:P.original_pr_sha,parents:[{sha:P.publisher_main_sha}],
  files:[{filename:SOURCE.file,status:'added',sha:P.original_blob_sha}]};
const currentFiles=[{filename:SOURCE.file,status:'added'}];
const branchPulls=[{number:P.original_pr,head:{ref:P.branch,repo:{full_name:REPO}}}];
const intentPath='contents/'+CONTROLLED_PUBLISHER_INTENT_PATH+'?ref=agent-store';
const responses=new Map([
  ['actions/runs/'+P.publisher_run,sourceRun],
  ['actions/runs/'+P.publisher_run+'/jobs?per_page=100',sourceJobs],
  ['issues/comments/'+P.command_comment_id,ownerComment],
  ['pulls/'+P.original_pr,pullRequest],
  ['git/ref/heads/'+P.branch,branchRef],
  ['pulls/'+P.original_pr+'/commits?per_page=100',pullCommits],
  ['commits/'+P.original_pr_sha,originalCommit],
  ['pulls/'+P.original_pr+'/files?per_page=100',currentFiles],
  ['pulls?head='+encodeURIComponent(REPO+'/'+P.branch)+'&state=all',branchPulls],
  [intentPath,{encoding:'base64',
    content:Buffer.from(JSON.stringify(intent)).toString('base64')}],
]);
const fetcher=async endpoint=>{
  if(!responses.has(endpoint))throw Error('unexpected GitHub read: '+endpoint);
  return responses.get(endpoint);
};

const readback=await fetchControlledPublication({fetcher});
assert.equal(readback.kind,'publisher_original_publication_readback');
assert.equal(readback.status,'original_pr_verified_not_reviewed');
assert.equal(readback.issue,1997);
assert.equal(readback.original_pr,P.original_pr);
assert.equal(readback.original_pr_sha,P.original_pr_sha);
assert.equal(readback.current_pr_sha,P.original_pr_sha);
assert.deepEqual(await fetchControlledPublication({fetcher}),readback);
await assert.rejects(()=>fetchControlledPublication({fetcher:async()=>({})}),
  /Publisher original PR readback|Trusted Publisher intent|immutable Publisher intent/);
await assert.rejects(()=>fetchControlledPublication({fetcher:async endpoint=>{
  if(endpoint===intentPath)return{encoding:'utf8',content:'{}'};
  return responses.get(endpoint);
}}),/immutable Publisher intent/);
await assert.rejects(()=>fetchControlledPublication({fetcher:async endpoint=>{
  if(endpoint===intentPath)return responses.get(intentPath);
  return{...(responses.get(endpoint)??{}),conclusion:'failure'};
}}),/Publisher original PR readback/);

const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
// The writer guard accepts the automatic Publisher wake and the one-shot owner
// wake on trusted main only; every other event/ref/workflow fails closed.
const trustedEnv={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'BestNathan/nession',
  GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_run',
  GITHUB_WORKFLOW:'Store / Publisher Review Ingest'};
assert.doesNotThrow(()=>assertTrustedMainWorkflow(trustedEnv));
assert.doesNotThrow(()=>assertTrustedMainWorkflow(
  {...trustedEnv,GITHUB_EVENT_NAME:'workflow_dispatch'}));
for(const bad of [
  {...trustedEnv,GITHUB_ACTIONS:'false'},
  {...trustedEnv,GITHUB_REPOSITORY:'attacker/nession'},
  {...trustedEnv,GITHUB_REF:'refs/heads/feature'},
  {...trustedEnv,GITHUB_EVENT_NAME:'push'},
  {...trustedEnv,GITHUB_EVENT_NAME:'issue_comment'},
  {...trustedEnv,GITHUB_WORKFLOW:'Store / Controlled Publisher'},
]) assert.throws(()=>assertTrustedMainWorkflow(bad),/trusted main-only Store Ingest required/);
const fixture=JSON.parse(fs.readFileSync(
  'scripts/lib/agent/publisher/fixtures/1997-v16-state.json','utf8'));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'publisher-ingest-'));
try {
  const issueDir=path.join(temp,'workflows','issues','1997');
  fs.mkdirSync(path.join(issueDir,'states'),{recursive:true});
  const bytes=Buffer.from(JSON.stringify(fixture,null,2)+'\n');
  fs.writeFileSync(path.join(issueDir,'states','00000016.json'),bytes);
  fs.writeFileSync(path.join(issueDir,'head.json'),JSON.stringify({version:16,
    path:'workflows/issues/1997/states/00000016.json',
    sha256:createHash('sha256').update(bytes).digest('hex')},null,2)+'\n');
  const result=applyPublisherReviewHandoff({storeRoot:temp,readback,registry});
  assert.equal(result.changed,true);
  assert.equal(result.version,17);
  assert.equal(result.target_sha,P.original_pr_sha);
  assert.match(result.reviewer_action_id,/^[a-f0-9]{64}$/);
  assert.equal(result.reviewer_agent_id,fixture.assignments.reviewer);
  const stored=JSON.parse(fs.readFileSync(path.join(issueDir,'states','00000017.json'),'utf8'));
  assert.equal(stored.phase,'review');
  assert.equal(stored.target_sha,P.original_pr_sha);
  assert.equal(stored.outbox.some(x=>x.id.startsWith('fea8efa4')),false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(issueDir,'head.json'),'utf8')).version,17);
  const replay=applyPublisherReviewHandoff({storeRoot:temp,readback,registry});
  assert.equal(replay.changed,false);
  assert.equal(replay.version,17);
  assert.throws(()=>applyPublisherReviewHandoff({storeRoot:temp,
    readback:{...readback,kind:'unverified'},registry}),/verified publication readback/);
  assert.throws(()=>applyPublisherReviewHandoff({storeRoot:temp,
    readback:{...readback,current_pr_sha:'main'},registry}),/verified publication readback/);
  assert.throws(()=>applyPublisherReviewHandoff({storeRoot:path.join(temp,'missing'),
    readback,registry}),/invalid root|ENOENT/);
} finally { fs.rmSync(temp,{recursive:true,force:true}); }

// The same handoff through the canonical Store writer: a disposable bare Git
// remote stands in for agent-store, and the CAS push must create exactly one
// immutable version commit and replay idempotently.
const remoteTemp=fs.mkdtempSync(path.join(os.tmpdir(),'publisher-store-remote-'));
try {
  const bare=path.join(remoteTemp,'agent-store.git');
  execFileSync('git',['init','--bare','-q',bare]);
  const seed=path.join(remoteTemp,'seed');
  execFileSync('git',['init','-q',seed]);
  const gitAt=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],
    {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  gitAt(seed,'checkout','-q','-b','agent-store');
  const seedIssue=path.join(seed,'workflows','issues','1997');
  fs.mkdirSync(path.join(seedIssue,'states'),{recursive:true});
  const seedBytes=Buffer.from(JSON.stringify(fixture,null,2)+'\n');
  fs.writeFileSync(path.join(seedIssue,'states','00000016.json'),seedBytes);
  fs.writeFileSync(path.join(seedIssue,'head.json'),JSON.stringify({version:16,
    path:'workflows/issues/1997/states/00000016.json',
    sha256:createHash('sha256').update(seedBytes).digest('hex')},null,2)+'\n');
  gitAt(seed,'add','-A');
  gitAt(seed,'-c','user.name=fixture','-c','user.email=fixture@example.invalid',
    'commit','-q','-m','seed v16');
  gitAt(seed,'remote','add','origin',bare);
  gitAt(seed,'push','-q','origin','agent-store');
  const remoteResult=applyPublicationToRemote({remote:bare,readback,registry});
  assert.equal(remoteResult.changed,true);
  assert.equal(remoteResult.version,17);
  assert.match(remoteResult.commit_sha,/^[a-f0-9]{40}$/);
  assert.equal(remoteResult.replayed,false);
  const verifyDir=path.join(remoteTemp,'verify');
  execFileSync('git',['clone','-q','--branch','agent-store','--single-branch',bare,verifyDir]);
  const remoteState=JSON.parse(fs.readFileSync(
    path.join(verifyDir,'workflows','issues','1997','states','00000017.json'),'utf8'));
  assert.equal(remoteState.phase,'review');
  assert.equal(remoteState.target_sha,P.original_pr_sha);
  assert.equal(remoteState.outbox.filter(x=>x.status==='pending').length,1);
  const remoteReplay=applyPublicationToRemote({remote:bare,readback,registry});
  assert.equal(remoteReplay.changed,false);
  assert.equal(remoteReplay.replayed,true);
  assert.throws(()=>applyPublicationToRemote({remote:path.join(remoteTemp,'missing.git'),
    readback,registry}),/agent-store remote unavailable/);
  assert.throws(()=>applyPublicationToRemote({remote:'not a trusted url with spaces',
    readback,registry}),/invalid trusted Store remote/);
} finally { fs.rmSync(remoteTemp,{recursive:true,force:true}); }
console.log('Publisher review ingest: verified readback, CAS handoff, remote CAS write, idempotent replay and unverified-state negatives passed');
