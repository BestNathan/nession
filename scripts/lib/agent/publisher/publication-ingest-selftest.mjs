#!/usr/bin/env node
// #2252 follow-up: verified Publisher publication → Store Reviewer handoff.
// All GitHub sources are unprivileged shaped fixtures; the Store is a
// disposable local checkout seeded from the real #1997 v16 state.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTROLLED_1997_POLICY as SOURCE } from './controlled-proposal.mjs';
import { planControlledPublisherIntent, CONTROLLED_PUBLISHER_INTENT_PATH } from './store-intent.mjs';
import { CONTROLLED_ORIGINAL_PUBLICATION as P } from './publication-readback.mjs';
import { fetchControlledPublication, applyPublisherReviewHandoff } from './publication-ingest.mjs';

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
console.log('Publisher review ingest: verified readback, CAS handoff, idempotent replay and unverified-state negatives passed');
