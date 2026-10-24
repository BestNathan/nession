#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateStagingDeveloperAdmission} from './staging-developer-admission.mjs';

const repo='BestNathan/nession';
const sha='a'.repeat(40),source='b'.repeat(40);
const context={
  repository:repo,ref:'refs/heads/main',
  event:'workflow_dispatch',workflow:'Acceptance / Staging Developer Admission',
  actor:'BestNathan',run_id:'401',run_attempt:'1',source_sha:source,
  target_sha:sha,ANTHROPIC_AUTH_TOKEN:'do-not-serialize',
};
const sourceRun={
  id:401,run_attempt:1,
  repository:{full_name:repo},head_repository:{full_name:repo},
  path:'.github/workflows/acceptance-staging-developer-admission.yml',
  name:'Acceptance / Staging Developer Admission',event:'workflow_dispatch',
  head_branch:'main',head_sha:source,actor:{login:'BestNathan'},
  status:'in_progress',
};
const stagingRef={ref:'refs/heads/staging',object:{type:'commit',sha}};
const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));

const verify=(c=context,r=sourceRun,ref=stagingRef,reg=registry)=>
  validateStagingDeveloperAdmission({context:c,sourceRun:r,stagingRef:ref,registry:reg});

const out=verify();
assert.equal(out.target_sha,sha);
assert.equal(out.source_sha,source);
assert.equal(out.source_run_id,401);
assert.equal(out.status,'provenance_validated_only');
assert.equal(out.signed_store_dispatch_verified,false);
assert.equal(out.can_execute_staging_source,false);
assert.equal(out.acceptance_result,'Pending');
assert.equal(out.selected_environment,'dev-claude-qwen-staging');
assert.ok(!JSON.stringify(out).includes(context.ANTHROPIC_AUTH_TOKEN));
assert.deepEqual(verify(),out);
for(const [change,error] of [
  [{ref:'refs/heads/staging'},/main-owner/],
  [{event:'pull_request_target'},/main-owner/],
  [{actor:'untrusted'},/main-owner/],
  [{repository:'attacker/fork'},/main-owner/],
  [{workflow:'Agent / Development'},/main-owner/],
  [{run_attempt:'2'},/main-owner/],
  [{run_id:'0'},/main-owner/],
  [{source_sha:'notsha'},/main-owner/],
  [{target_sha:'staging'},/main-owner/],
]){
  assert.throws(()=>verify({...context,...change}),error);
}
for(const change of [
  {head_sha:'c'.repeat(40)}, {id:402},
  {run_attempt:2},{path:'.github/workflows/agent-develop.yml'},
  {event:'pull_request'},{head_branch:'staging'},
  {actor:{login:'other'}},{name:'Other Workflow'},
  {head_repository:{full_name:'fork/other'}},
  {repository:{full_name:'fork/other'}},
  {status:'cancelled'},
]){
  assert.throws(()=>verify(context,{...sourceRun,...change}),/Run provenance/);
}
for(const changed of [
  {ref:'refs/heads/main'},{object:{type:'tag',sha}},
  {object:{type:'commit',sha:'c'.repeat(40)}},
]){
  assert.throws(()=>verify(context,sourceRun,{...stagingRef,...changed}),/staging branch tip/);
}
assert.throws(()=>verify(context,sourceRun,null),/staging branch tip/);
for(const altered of [
  {role:'reviewer'},
  {provider:'cursor'},
  {environment:'dev-claude-qwen-staging'},
]){
  assert.throws(()=>verify(context,sourceRun,stagingRef,{
    ...registry,instances:{...registry.instances,'dev-qwen-01':{
      ...registry.instances['dev-qwen-01'],...altered,
    }},
  }),/approved registered/);
}
console.log('Staging Developer admission: owner main Run, exact staging SHA, fail-closed privacy tests passed');
