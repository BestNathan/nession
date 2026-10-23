#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CONTROLLED_1997_POLICY as POLICY} from '../publisher/controlled-proposal.mjs';
import {planControlledPublisherIntent,
  CONTROLLED_PUBLISHER_BRANCH as BRANCH} from '../publisher/store-intent.mjs';
import {admitOriginalControlledReviewerTarget} from './pr-admission.mjs';

const blob=b=>createHash('sha1').update(Buffer.concat([
  Buffer.from('blob '+b.length+'\0'),b,
])).digest('hex');
const HEAD='3d8e3807cc01f6082734b8d0ba458217c28f60a4';
const publisherRun={
  id:39609600546,run_attempt:1,name:'Store / Controlled Publisher',
  path:'.github/workflows/store-controlled-publisher.yml',
  repository:{full_name:'BestNathan/nession'},
  head_repository:{full_name:'BestNathan/nession'},
  event:'issue_comment',actor:{login:'BestNathan'},
  head_branch:'main',head_sha:'c6894b59b8be9448cae3c68fd87593516f66b47a',
  status:'completed',conclusion:'success',
  created_at:'2026-10-21T13:37:20Z',
};
const ownerComment={
  id:6317468284,user:{login:'BestNathan'},
  issue_url:'https://api.github.com/repos/BestNathan/nession/issues/1997',
  body:'/nession publish issue=1997 worker_run=39448549052 checkpoint=3',
  created_at:'2026-10-21T13:37:18Z',
};
const pullRequest={
  number:2176,state:'open',draft:false,merged_at:null,
  user:{login:'nession-publisher[bot]'},
  head:{sha:HEAD,ref:BRANCH,repo:{full_name:'BestNathan/nession'}},
  base:{ref:'main',repo:{full_name:'BestNathan/nession'}},
  created_at:'2026-10-21T13:37:57Z',
};
const headCommit={
  sha:HEAD,tree:{sha:'34ba295f4b6d0becffd6bc1d3e178a54325c0410'},
  parents:[{sha:publisherRun.head_sha}],
};
const files=[{
  filename:POLICY.file,status:'added',
  sha:blob(Buffer.from(POLICY.content)),additions:2,deletions:0,changes:2,
  patch:'@@ -0,0 +1,2 @@\n+Durable Worker fixture: complete\n+Previous value: pending',
}];
const treeEntry={
  path:POLICY.file,mode:'100644',type:'blob',
  sha:blob(Buffer.from(POLICY.content)),size:Buffer.byteLength(POLICY.content),
};
const storeIntent=planControlledPublisherIntent({
  target_main_sha:publisherRun.head_sha,
  patch_sha256:'1f45a088966d41c1fcade13540498693d7d083ca238ca2b06c0525c654e314ee',
  issuer_run_id:publisherRun.id,
});
const input={publisherRun,ownerComment,pullRequest,headCommit,files,treeEntry,storeIntent};
const positive=admitOriginalControlledReviewerTarget(input);
assert.deepEqual(positive,admitOriginalControlledReviewerTarget(input));
assert.equal(positive.issue,1997);
assert.equal(positive.role,'reviewer');
assert.equal(positive.agent_id,'review-cursor-01');
assert.equal(positive.task,'review');
assert.equal(positive.pr_number,2176);
assert.equal(positive.target_sha,HEAD);
assert.equal(positive.expected_file_mode,'100644');
assert.equal(positive.status,'await_native_reviewer');
assert.equal(positive.kind,'authenticated_reviewer_admission_only');
assert.ok(!Object.hasOwn(positive,'next_role'));
assert.ok(!Object.hasOwn(positive,'review_outcome'));
// A second registered reviewer is a first-class identity with the same target.
const qwen=admitOriginalControlledReviewerTarget(input,'review-qwen-01');
assert.equal(qwen.agent_id,'review-qwen-01');
assert.equal(qwen.role,'reviewer');
assert.equal(qwen.status,'await_native_reviewer');
assert.equal(qwen.kind,'authenticated_reviewer_admission_only');
assert.equal(qwen.target_sha,HEAD);
for(const agentId of ['dev-cursor-01','unknown-agent','review-cursor-99'])
  assert.throws(()=>admitOriginalControlledReviewerTarget(input,agentId),
    /unregistered reviewer identity/);
function deny(patch,pattern=/Trusted Reviewer source:/){
  assert.throws(()=>admitOriginalControlledReviewerTarget({...input,...patch}),pattern);
}
for(const patch of [
  {id:0},{run_attempt:2},{conclusion:'failure'},
  {name:'Agent / Review'},{path:'.github/workflows/agent-review.yml'},
  {event:'pull_request'},{head_branch:'untrusted'},
  {head_sha:'a'.repeat(40)},{actor:{login:'attacker'}},
  {repository:{full_name:'evil/nession'}},
  {head_repository:{full_name:'fork/nession'}},
  {created_at:'2026-10-21T13:37:17Z'},
])deny({publisherRun:{...publisherRun,...patch}});
for(const patch of [
  {id:123},{body:'/nession publish issue=1997 checkpoint=2'},
  {user:{login:'attacker'}},
  {issue_url:'https://api.github.com/repos/BestNathan/nession/issues/1664'},
  {created_at:'2026-10-21T13:38:00Z'},
])deny({ownerComment:{...ownerComment,...patch}});
for(const patch of [
  {number:2175},{state:'closed'},{draft:true},{merged_at:'2026-10-21T13:38:00Z'},
  {user:{login:'BestNathan'}},
  {head:{...pullRequest.head,sha:'0'.repeat(40)}},
  {head:{...pullRequest.head,ref:'danger/other'}},
  {head:{...pullRequest.head,repo:{full_name:'fork/nession'}}},
  {base:{...pullRequest.base,ref:'release'}},
  {base:{...pullRequest.base,repo:{full_name:'other/nession'}}},
  {created_at:'2026-10-21T13:37:19Z'},
])deny({pullRequest:{...pullRequest,...patch}});
for(const patch of [
  {sha:'0'.repeat(40)},{tree:{sha:'invalid'}},
  {tree:{sha:'e'.repeat(40)}},
  {tree:{sha:'34ba295f4b6d0becffd6bc1d3e178a54325c0410'.replace('34ba','34bb')}},
  {parents:[]},{parents:[{sha:'0'.repeat(40)}]},
  {parents:[{sha:publisherRun.head_sha},{sha:publisherRun.head_sha}]},
])deny({headCommit:{...headCommit,...patch}});
for(const patch of [
  {mode:'100755'},{mode:'120000'},{path:'.github/workflows/evil.yml'},
  {type:'tree'},{sha:'0'.repeat(40)},
  {size:Buffer.byteLength(POLICY.content)+1},
])deny({treeEntry:{...treeEntry,...patch}});
deny({treeEntry:undefined});deny({treeEntry:null});
for(const patch of [
  {filename:'.github/workflows/evil.yml'},{status:'modified'},
  {sha:'0'.repeat(40)},{additions:3},{deletions:1},
  {changes:3},{patch:'@@ -0,0 +1 @@\n+Forged'},
])deny({files:[{...files[0],...patch}]});
deny({files:[]});deny({files:[...files,...files]});
for(const patch of [
  {publisher_issuer_run_id:99},{target_main_sha:'0'.repeat(40)},
  {patch_sha256:'0'.repeat(64)},{worker_run_id:123},
  {worker_run_attempt:2},{action_id:'0'.repeat(64)},
  {checkpoint_commit_sha:'0'.repeat(40)},
  {branch:'agent/unbounded'},{publication:'published'},
])deny({storeIntent:{...storeIntent,...patch}});
deny({...input,next_role:'developer'},/unexpected source fields/);
deny({...input,model_approval:'approved'},/unexpected source fields/);
deny({...input,issue_comment:'changes_requested'},/unexpected source fields/);
deny({...input,review_event:{state:'APPROVED'}},/unexpected source fields/);
console.log('Reviewer admission: real #2176 App Publisher Run/Owner/CAS/HEAD/parent/tree/100644-mode/one-file proof and forged source, stale SHA, path, mode, tree, role and model-outcome negatives passed; no Reviewer was run');
