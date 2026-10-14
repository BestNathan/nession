// Authenticated GitHub workflow_run boundary for Issue E2E evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildGitPlan } from './issue-e2e-plan.mjs';
import { summarize } from '../e2e/runner/selected-report.mjs';
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

export function verifyPlanFromSource(sourceRoot, issues, pr, claimed) {
  const rebuilt = buildGitPlan(sourceRoot,issues,pr.base.sha,pr.head.sha);
  assert.equal(claimed.mode,rebuilt.mode);
  assert.equal(claimed.plan_digest,rebuilt.plan_digest,'plan changed from current Issue/source');
  assert.deepEqual(claimed.issues,rebuilt.issues,'Issue contract differs from captured plan');
  assert.deepEqual(claimed.selected,rebuilt.selected,'test selection differs from trusted source');
  return rebuilt;
}

export function verifyReporterEvidence(plan,results,report,receipt) {
  let expected;
  try { expected = summarize(plan,report,receipt); }
  catch {
    expected={status:'Unproven',results:plan.selected.map(x=>({
      id:x.id,result:'Error',discovered:0,passed:0,failed:0,
      skipped:0,flaky:0,assertions:0
    }))};
  }
  assert.equal(results.status,expected.status,'reported verdict differs from Playwright evidence');
  assert.deepEqual(results.results,expected.results,'per-ID evidence differs from Playwright JSON');
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
else if(process.argv[2]==='project') {
  const [eventFile,runFile,prFile,planFile,resultFile,artifactFile,issueFile,sourceRoot,outputDir,playwrightFile,assertionsFile] = process.argv.slice(3);
  if(!outputDir)throw Error('project EVENT RUN PR PLAN RESULTS ARTIFACT ISSUES SOURCE_ROOT OUTPUT_DIR');
  const read = file => JSON.parse(fs.readFileSync(file,'utf8'));
  const event=read(eventFile),run=read(runFile),pr=read(prFile);
  const plan=read(planFile),results=read(resultFile),artifact=read(artifactFile);
  const issues=read(issueFile);
  const attested=verifySource(event,run,pr,plan,results,artifact);
  verifyPlanFromSource(sourceRoot,issues,pr,plan);
  let playwright=null;
  if(playwrightFile && fs.existsSync(playwrightFile))
    playwright=JSON.parse(fs.readFileSync(playwrightFile,'utf8'));
  let assertions=null;
  if(assertionsFile && fs.existsSync(assertionsFile))
    assertions=JSON.parse(fs.readFileSync(assertionsFile,'utf8'));
  verifyReporterEvidence(plan,results,playwright,assertions);
  const projections=projectAuthenticated(issues,plan,results,attested);
  fs.mkdirSync(outputDir,{recursive:true});
  for(const item of projections)
    fs.writeFileSync(path.join(outputDir,String(item.issue)+'.json'),
      JSON.stringify({body:item.body})+'\n',{flag:'wx'});
  fs.writeFileSync(path.join(outputDir,'record.json'),
    JSON.stringify({schema_version:1,kind:'issue_e2e_run',
      target_sha:attested.target_sha,run_id:attested.run_id,
      run_attempt:attested.run_attempt,plan_digest:plan.plan_digest,
      artifact_digest:attested.artifact_digest,results:results.results},null,2)+'\n',{flag:'wx'});
}

