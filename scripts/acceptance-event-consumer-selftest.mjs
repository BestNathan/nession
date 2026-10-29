#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {authorizeEventConsumer,attestDispatchSource,canonicalTaskId} from './acceptance-event-consumer.mjs';
const repo='BestNathan/nession',sha='a'.repeat(40);
const live={id:55,run_attempt:2,event:'push',
  name:'E2E / Tests',path:'.github/workflows/e2e-tests.yml',
  head_branch:'main',head_sha:sha,status:'completed',conclusion:'success',
  repository:{full_name:repo},head_repository:{full_name:repo}};
const source=attestDispatchSource(live,{runId:55,attempt:2,sha});
assert.equal(source.target_sha,sha);
for(const bad of [
  {id:56},{run_attempt:3},{event:'pull_request'},
  {name:'untrusted'}, {path:'.github/workflows/evil.yml'},
  {head_branch:'staging'},{head_sha:'b'.repeat(40)},
  {status:'in_progress'},{conclusion:'failure'},
  {repository:{full_name:'other/repo'}},
  {head_repository:{full_name:'other/repo'}},
])assert.equal(attestDispatchSource({...live,...bad},{runId:55,attempt:2,sha}),null);
const codeFence=String.fromCharCode(96).repeat(3);
const issueBody=['## Success Criteria','- [ ] SC-01 Validate run',
  '## Acceptance Plan',codeFence+'yaml','acceptance:',
  '  SC-01:','    when: merged','    branch: main','    method: agent',
  codeFence,'## Acceptance Report','| Criterion | Result | Evidence |',
  '|---|---|---|','| SC-01 | Pending | missing proof |'].join('\n');
const issue={number:87,title:'Requirement: fixture',body:issueBody,
  labels:[{name:'requirement'}],state:'open'};
const pr={number:99,title:'feat: proof',body:'Implements #87',
  merged_at:'2026-10-29T12:01:00Z',merge_commit_sha:sha,
  base:{ref:'main'},head:{repo:{full_name:repo}}};
const get=async path=>{
  if(path.endsWith('/actions/runs/55'))return live;
  if(path.endsWith('/commits/'+sha+'/pulls?per_page=30'))return [pr];
  if(path.endsWith('/issues/87'))return issue;
  throw Error('unexpected GitHub API read '+path);
};
const digest=(await import('./acceptance-event-relay.mjs'))
  .pendingMergedAgentContext(issue,source).contract_digest;
const inputs={source_run_id:'55',source_attempt:'2',target_sha:sha,
  issue_number:'87',contract_digest:digest,
  task_id:canonicalTaskId(source,87,digest)};
assert.deepEqual(await authorizeEventConsumer(inputs,get),
  {authorized:true,issue_number:87,target_sha:sha,task_id:inputs.task_id});
assert.equal((await authorizeEventConsumer({...inputs,task_id:'0'.repeat(64)},get)).authorized,false);
assert.equal((await authorizeEventConsumer({...inputs,contract_digest:'0'.repeat(64)},get)).authorized,false);
assert.equal((await authorizeEventConsumer({...inputs,source_attempt:'3'},get)).authorized,false);
assert.equal((await authorizeEventConsumer({...inputs,target_sha:'b'.repeat(40)},get)).authorized,false);
assert.equal((await authorizeEventConsumer({...inputs},async path=>{
  if(path.endsWith('/actions/runs/55'))return {...live,conclusion:'failure'};
  throw Error('must reject source before querying any Issue');
})).authorized,false);
assert.equal((await authorizeEventConsumer(inputs,async path=>{
  if(path.endsWith('/issues/87'))return {...issue,state:'closed'};
  return get(path);
})).authorized,false);
assert.equal((await authorizeEventConsumer(inputs,async path=>{
  if(path.endsWith('/issues/87'))return {...issue,body:issueBody.replace(
    'when: merged\n    branch: main','when: pr')};
  return get(path);
})).authorized,false);
await assert.rejects(()=>authorizeEventConsumer({...inputs,issue_number:'87; rm -rf /'},get),/invalid/);
await assert.rejects(()=>authorizeEventConsumer({...inputs,task_id:'invalid'},get),/invalid/);
const wf=fs.readFileSync('.github/workflows/acceptance-event-consumer.yml','utf8');
assert.match(wf,/workflow_dispatch:/);
assert.match(wf,/git merge-base --is-ancestor "\$TARGET_SHA" HEAD/);
assert.match(wf,/node scripts\/acceptance-event-consumer.mjs/);
assert.match(wf,/uses: BestNathan\/nession\/.github\/workflows\/agent-sc-acceptance.yml@main/);
assert.match(wf,/if: needs.authorize.outputs.authorized == 'true'/);
assert.doesNotMatch(wf,/pull_request_target:|schedule:|workflow_run:/);
assert.doesNotMatch(wf,/issues: write|curl .*PATCH|gh issue edit/);
console.log('Acceptance event consumer: exact source, main ancestry, Issue plan/method, task digest, replay-safe rejection and trusted evaluator reuse passed');
