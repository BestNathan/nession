#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {planControlledPublisherIntent} from '../publisher/store-intent.mjs';
import {CONTROLLED_1997_POLICY as POLICY} from '../publisher/controlled-proposal.mjs';
import {admitOriginal1997Reviewer} from './controlled-review-admission.mjs';

const prHead='3d8e3807cc01f6082734b8d0ba458217c28f60a4';
const mainHead='c6894b59b8be9448cae3c68fd87593516f66b47a';
const root='BestNathan/nession';
const content=Buffer.from(POLICY.content);
const blob=createHash('sha1').update(Buffer.concat([
  Buffer.from('blob '+content.length+'\0'),content,
])).digest('hex');
const original={
  pull:{
    number:2176,state:'open',draft:false,merged_at:null,
    html_url:'https://github.com/BestNathan/nession/pull/2176',
    user:{login:'nession-publisher[bot]'},
    head:{ref:'agent/1997/developer-checkpoint-v3',sha:prHead,repo:{full_name:root}},
    base:{ref:'main',repo:{full_name:root}},
  },
  files:[{filename:POLICY.file,status:'added',additions:2,deletions:0,
    changes:2,sha:blob,patch:'@@ -0,0 +1,2 @@\n+Durable Worker fixture: complete\n+Previous value: pending'}],
  headCommit:{sha:prHead,parents:[{sha:mainHead}]},
  publisherRun:{
    id:39609600546,run_attempt:1,
    path:'.github/workflows/store-controlled-publisher.yml',
    name:'Store / Controlled Publisher',event:'issue_comment',
    actor:{login:'BestNathan'},repository:{full_name:root},
    head_repository:{full_name:root},head_branch:'main',
    head_sha:mainHead,status:'completed',conclusion:'success',
  },
  publisherIntent:planControlledPublisherIntent({
    target_main_sha:mainHead,
    patch_sha256:'1f45a088966d41c1fcade13540498693d7d083ca238ca2b06c0525c654e314ee',
    issuer_run_id:39609600546,
  }),
  registry:JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8')),
  reviews:[],
};
const first=admitOriginal1997Reviewer(original);
assert.deepEqual(first,admitOriginal1997Reviewer(original));
assert.equal(first.kind,'authenticated_read_only_reviewer_admission');
assert.equal(first.status,'admitted_only');
assert.equal(first.next_action,'separate_native_reviewer_workflow_required');
assert.equal(first.review_head_sha,prHead);
assert.equal(first.publisher_run_id,39609600546);
assert.equal(first.file.blob_sha,blob);
assert.equal(first.reviewer.agent_id,'review-cursor-01');
assert.equal(first.reviewer.role,'reviewer');
assert.equal(first.reviewer.task,'review');
assert.equal(first.reviewer.provider,'cursor');
assert.ok(!Object.hasOwn(first,'outcome'));
assert.ok(!Object.hasOwn(first,'review_id'));
assert.ok(!Object.hasOwn(first,'token'));
const bad=(modified,reason)=>assert.throws(()=>
  admitOriginal1997Reviewer({...original,...modified}),reason);
for(const changes of [
  {number:1997},{state:'closed'},{draft:true},
  {merged_at:'2026-10-21T13:38:01Z'},
  {html_url:'https://attacker.example/pr/2176'},
  {user:{login:'BestNathan'}},
  {user:{login:'github-actions[bot]'}},
  {head:{...original.pull.head,sha:'0'.repeat(40)}},
  {head:{...original.pull.head,ref:'agent/1997/other'}},
  {head:{...original.pull.head,repo:{full_name:'attacker/fork'}}},
  {base:{...original.pull.base,ref:'develop'}},
  {base:{...original.pull.base,repo:{full_name:'fork/nession'}}},
])bad({pull:{...original.pull,...changes}},/Verified Reviewer admission:/);
for(const changes of [
  {id:400},{run_attempt:2},{head_sha:'a'.repeat(40)},
  {head_branch:'feature'},{event:'pull_request_target'},
  {name:'Agent / Development'},{path:'.github/workflows/agent-develop.yml'},
  {actor:{login:'attacker'}},{conclusion:'failure'},
  {status:'in_progress'},{repository:{full_name:'attacker/fork'}},
  {head_repository:{full_name:'attacker/fork'}},
])bad({publisherRun:{...original.publisherRun,...changes}},
  /Verified Reviewer admission:/);
for(const changes of [
  {sha:'0'.repeat(40)},{parents:[]},
  {parents:[{sha:'f'.repeat(40)}]},
  {parents:[{sha:mainHead},{sha:'e'.repeat(40)}]},
])bad({headCommit:{...original.headCommit,...changes}},
  /Verified Reviewer admission:/);
for(const changes of [
  {filename:'.github/workflows/ci.yml'},{status:'modified'},
  {additions:3},{deletions:1},{changes:3},{sha:'1'.repeat(40)},
  {patch:'@@ -0,0 +1 @@\n+Forged PR review'},
])bad({files:[{...original.files[0],...changes}]},
  /Verified Reviewer admission:/);
bad({files:[]},/unexpected file count/);
bad({files:[...original.files,original.files[0]]},/unexpected file count/);
bad({reviews:[{id:123,state:'CHANGES_REQUESTED'}]},/must not be replayed/);
for(const changes of [
  {publisher_issuer_run_id:123},{target_main_sha:'a'.repeat(40)},
  {patch_sha256:'0'.repeat(64)},{branch:'attacker'},
  {worker_run_attempt:2},{checkpoint_version:2},
  {source_result_artifact_id:1},{source_sha:'f'.repeat(40)},
]){
  bad({publisherIntent:{...original.publisherIntent,...changes}},
    /Verified Reviewer admission:|Trusted Publisher intent:/);
}
for(const changes of [
  {role:'developer',provider:'cursor',environment:'agent-review-cursor-01'},
  {role:'reviewer',provider:'claude-code',environment:'agent-review-cursor-01'},
  {role:'reviewer',provider:'cursor',environment:'untrusted-other'},
]){
  const registry=structuredClone(original.registry);
  registry.instances['review-cursor-01']={...registry.instances['review-cursor-01'],
    ...changes};
  bad({registry},/Verified Reviewer admission:|agent harness:/);
}
console.log('Reviewer admission: verified fixed genuine PR HEAD and source Publisher/Store, one exact Git blob, registered read-only role, >40 negative source/identity/tamper paths. No Review, Provider call or Store mutation.');
