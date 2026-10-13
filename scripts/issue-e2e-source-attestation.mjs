// Authenticated GitHub workflow_run boundary for Issue E2E evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectIssueE2E } from './issue-e2e-project.mjs';

const SHA=/^[a-f0-9]{40}$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;
export function verifySource(event,run,pr,plan,results,artifact) {
  const repo='BestNathan/nession';
  assert.equal(event?.repository?.full_name,repo);
  assert.equal(event?.workflow_run?.id,run.id);
  assert.equal(event?.workflow_run?.run_attempt,run.run_attempt);
  assert.equal(run.repository?.full_name,repo);
  assert.equal(run.head_repository?.full_name,repo);
  assert.equal(run.path,'.github/workflows/e2e-tests.yml');
  assert.equal(run.event,'pull_request');
  assert.equal(run.status,'completed');
  assert.ok(['success','failure'].includes(run.conclusion));
  assert.ok(positive(run.id)&&positive(run.run_attempt)&&positive(run.workflow_id));
  assert.match(run.head_sha,SHA);
  assert.equal(pr.base.repo.full_name,repo);
  assert.equal(pr.head.repo.full_name,repo);
  assert.equal(pr.head.sha,run.head_sha,'stale PR head');
  assert.equal(pr.number,plan.pr_number);
  assert.equal(plan.target_sha,run.head_sha);
  assert.equal(plan.base_sha,pr.base.sha);
  assert.equal(results.target_sha,run.head_sha);
  assert.equal(results.plan_digest,plan.plan_digest);
  assert.equal(results.run_id,run.id);
  assert.equal(results.run_attempt,run.run_attempt);
  assert.ok(Array.isArray(results.results));
  assert.equal(artifact.name,'issue-e2e-verification');
  assert.ok(positive(artifact.id)&&artifact.expired===false);
  assert.match(artifact.digest,/^sha256:[0-9a-f]{64}$/);
  return {run_id:run.id,run_attempt:run.run_attempt,target_sha:run.head_sha,
    workflow_verified:true,artifact_digest:artifact.digest};
}

export function projectAuthenticated(issues,plan,results,authenticated) {
  if(plan.mode!=='selected')throw Error('Only selected plans have per-ID Issue reports');
  const projected=[];
  for(const info of plan.issues){
    const issue=issues.find(i=>i.number===info.issue);
    if(!issue)throw Error('Issue contract missing from trusted source');
    const next=projectIssueE2E(issue,plan,results,authenticated);
    projected.push({issue:issue.number,body:next.body,all_pass:next.all_pass});
  }
  return projected;
}

function selfTest(){
  const sha='a'.repeat(40),base='b'.repeat(40);
  const run={id:77,run_attempt:1,workflow_id:9,head_sha:sha,
    repository:{full_name:'BestNathan/nession'},head_repository:{full_name:'BestNathan/nession'},
    event:'pull_request',status:'completed',conclusion:'failure',
    path:'.github/workflows/e2e-tests.yml'};
  const event={repository:{full_name:'BestNathan/nession'},workflow_run:{id:77,run_attempt:1}};
  const pr={number:3,base:{sha:base,repo:{full_name:'BestNathan/nession'}},
    head:{sha,repo:{full_name:'BestNathan/nession'}}};
  const plan={pr_number:3,target_sha:sha,base_sha:base,plan_digest:'c'.repeat(64)};
  const results={target_sha:sha,plan_digest:plan.plan_digest,run_id:77,run_attempt:1,results:[]};
  const artifact={id:1,name:'issue-e2e-verification',expired:false,digest:'sha256:'+'d'.repeat(64)};
  assert.equal(verifySource(event,run,pr,plan,results,artifact).workflow_verified,true);
  assert.throws(()=>verifySource(event,run,{...pr,head:{...pr.head,sha:base}},plan,results,artifact),/stale/);
  assert.throws(()=>verifySource(event,{...run,path:'bad.yml'},pr,plan,results,artifact));
  assert.throws(()=>verifySource(event,run,pr,plan,{...results,run_attempt:2},artifact));
  console.log('Issue E2E source attestation: exact workflow, SHA, PR and artifact negative fixtures passed');
}
if(process.argv[2]==='self-test')selfTest();
