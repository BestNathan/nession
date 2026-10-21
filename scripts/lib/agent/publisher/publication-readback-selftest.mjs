#!/usr/bin/env node
// Source-shaped positive+negative Publisher proof. All bytes are unprivileged
// mock GitHub/Store API responses; no PR POST, Store credential or model call.
import assert from 'node:assert/strict';
import {CONTROLLED_1997_POLICY as SOURCE} from './controlled-proposal.mjs';
import {planControlledPublisherIntent} from './store-intent.mjs';
import {CONTROLLED_ORIGINAL_PUBLICATION as P,
  verifyControlledOriginalPublication as verify} from './publication-readback.mjs';

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
const sourceJobs={total_count:1,jobs:[{
  id:50,run_id:P.publisher_run,name:'publish',
  status:'completed',conclusion:'success',
}]};
const ownerComment={
  id:P.command_comment_id,user:{login:'BestNathan'},
  issue_url:'https://api.github.com/repos/'+REPO+'/issues/1997',
  body:'/nession publish issue=1997 worker_run=39448549052 checkpoint=3',
  created_at:'2026-10-21T13:37:18Z',
};
const intent=planControlledPublisherIntent({
  target_main_sha:P.publisher_main_sha,
  patch_sha256:P.original_patch_sha256,
  issuer_run_id:P.publisher_run,
});
const originalCommit={sha:P.original_pr_sha,
  parents:[{sha:P.publisher_main_sha}]};
const originalFiles=[{filename:SOURCE.file,status:'added',
  sha:P.original_blob_sha}];
const currentFiles=[{...originalFiles[0]}];
const pullRequest={
  number:P.original_pr,state:'open',html_url:'https://github.com/'+REPO+
    '/pull/'+P.original_pr,user:{login:'nession-publisher[bot]'},
  base:{ref:'main',repo:{full_name:REPO}},
  head:{ref:P.branch,repo:{full_name:REPO},sha:P.original_pr_sha},
};
const branchRef={ref:'refs/heads/'+P.branch,
  object:{sha:P.original_pr_sha}};
const pullCommits=[{sha:P.original_pr_sha}];
const branchPulls=[{number:P.original_pr,head:{ref:P.branch,repo:{full_name:REPO}}}];
const good={sourceRun,sourceJobs,ownerComment,intent,pullRequest,
  branchRef,pullCommits,originalCommit,originalFiles,currentFiles,branchPulls};
const result=verify(good);
assert.equal(result.status,'original_pr_verified_not_reviewed');
assert.equal(result.original_pr,2176);
assert.equal(result.original_pr_sha,P.original_pr_sha);
assert.equal(result.source_worker_run_id,SOURCE.run_id);
assert.deepEqual(verify(good),result,'read-only verification must be repeatable');

function denied(key,change,matcher=/Publisher original PR readback|Trusted Publisher intent/){
  assert.throws(()=>verify({...good,[key]:change}),matcher);
}
for(const part of [
  {id:1},{run_attempt:2},{name:'Agent / Development'},
  {path:'.github/workflows/agent-develop.yml'},
  {event:'pull_request'},{actor:{login:'attacker'}},
  {head_branch:'untrusted'},{head_sha:'f'.repeat(40)},
  {repository:{full_name:'another/repo'}},
  {head_repository:{full_name:'fork/nession'}},
  {status:'in_progress'},{conclusion:'failure'},
])denied('sourceRun',{...sourceRun,...part});
for(const part of [
  {total_count:2},{jobs:[]},{jobs:[{...sourceJobs.jobs[0],conclusion:'failure'}]},
  {jobs:[{...sourceJobs.jobs[0],run_id:1}]},
  {jobs:[sourceJobs.jobs[0],sourceJobs.jobs[0]]},
])denied('sourceJobs',{...sourceJobs,...part});
for(const part of [
  {id:2},{user:{login:'attacker'}},
  {issue_url:'https://api.github.com/repos/'+REPO+'/issues/1664'},
  {body:'/nession publish issue=1997 checkpoint=2'},
  {created_at:'2026-10-21T13:37:21Z'},
  {created_at:'2026-10-21T13:35:17Z'},
  {created_at:'bad'},
  {created_at:null},
])denied('ownerComment',{...ownerComment,...part});
// An older identical owner command cannot be used as evidence of the newer
// Publisher Run, even if the Issue URL, actor and command text are identical.
denied('ownerComment',{...ownerComment,id:6308823032,
  created_at:'2026-10-21T05:30:10Z'});
// A claim that the original Run predates the triggering comment is false.
denied('sourceRun',{...sourceRun,created_at:'2026-10-21T13:37:17Z'});
denied('sourceRun',{...sourceRun,created_at:'2026-10-21T13:39:19Z'});
denied('sourceRun',{...sourceRun,created_at:'not-a-date'});
for(const part of [
  {action_id:'f'.repeat(64)},
  {worker_run_id:2},{checkpoint_version:4},
  {source_claim_artifact_id:1},
  {target_main_sha:'f'.repeat(40)},
  {patch_sha256:'f'.repeat(64)},
  {publisher_issuer_run_id:9999},
  {branch:'main'}, {publication:'published'},
])denied('intent',{...intent,...part});
for(const part of [
  {number:3},{state:'draft'},{html_url:'https://example.invalid/2176'},
  {user:{login:'github-actions[bot]'}},
  {base:{ref:'other',repo:{full_name:REPO}}},
  {base:{ref:'main',repo:{full_name:'attacker/repo'}}},
  {head:{ref:'main',repo:{full_name:REPO},sha:P.original_pr_sha}},
  {head:{ref:P.branch,repo:{full_name:'fork/nession'},sha:P.original_pr_sha}},
])denied('pullRequest',{...pullRequest,...part});
denied('branchRef',{...branchRef,object:{sha:'0'.repeat(40)}});
denied('branchPulls',[]);
denied('branchPulls',[branchPulls[0],{number:2177}]);
denied('branchPulls',[{...branchPulls[0],head:{ref:'main',repo:{full_name:REPO}}}]);
denied('branchPulls',[{...branchPulls[0],head:{ref:P.branch,repo:{full_name:'fork/nession'}}}]);
denied('pullCommits',[]);
denied('pullCommits',[{sha:'f'.repeat(40)}]);
denied('originalCommit',{...originalCommit,parents:[]});
denied('originalCommit',{...originalCommit,parents:[{sha:'f'.repeat(40)}]});
denied('originalFiles',[{filename:'.github/workflows/ci.yml',status:'added',sha:P.original_blob_sha}]);
denied('originalFiles',[{...originalFiles[0],sha:'f'.repeat(40)}]);
denied('currentFiles',[...currentFiles,{filename:'src/evil',status:'modified'}]);
// An authenticated subsequent repair may move only the current PR commit:
// the ORIGINAL SHA/target/tree remain forever pinned and independently proven.
const repaired='5'.repeat(40);
const repairPr={...pullRequest,head:{...pullRequest.head,sha:repaired}};
const repairedResult=verify({...good,pullRequest:repairPr,
  branchRef:{ref:'refs/heads/'+P.branch,object:{sha:repaired}},
  pullCommits:[{sha:P.original_pr_sha},{sha:repaired}],
});
assert.equal(repairedResult.original_pr_sha,P.original_pr_sha);
assert.equal(repairedResult.current_pr_sha,repaired);
assert.equal(repairedResult.status,'original_pr_verified_not_reviewed');
console.log('Original real Publisher readback contract: exact triggering owner comment/Run time bound, old same-text owner command denied, Store intent, App PR, original commit, unique branch and SHA A/B replay negatives pass (no Reviewer asserted, no writes)');
