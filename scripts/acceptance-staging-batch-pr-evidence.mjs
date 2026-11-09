#!/usr/bin/env node
// Source-bound retrospective PR verification for #2984.
// The original audited PR is already merged. Ordinary pre-merge SCs never
// perform expensive GitHub readbacks. This explicit remediation proves the
// *original* integration PR, not a later repair PR that happens to cite #2984.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseIssueE2E } from './issue-e2e-contract.mjs';
import { auditIssue } from './issue-contract.mjs';

const REPO='BestNathan/nession';
const ISSUE=2984, PR=2985;
const HEAD='91af0907d508224d55e469adfa6442f440b70432';
const LANE='f7e2d008ed497d85554b2aa88801f4d86177f873';
const MAIN='8352d3abb6f3c73b07db2fed1357566aa17f74b2';
const MERGE='d4025428dcb79cfd273a16a66ff828cd2288eb54';
const MARKER='<!-- nession-convergence-batch:v1 branch=staging main='+MAIN+
  ' lane='+LANE+' head='+HEAD+' -->';
const WORKFLOWS=Object.freeze({
  quality: ['CI / Quality Gate','.github/workflows/ci-quality.yml'],
  case: ['Acceptance / Case Smoke','.github/workflows/acceptance-case-smoke.yml'],
  e2e: ['E2E / Tests','.github/workflows/e2e-tests.yml'],
  pages: ['CI / Pages','.github/workflows/ci-pages.yml'],
});
const EXPECTED_JOBS=Object.freeze({
  quality:['scope','workflow-check','tooling-check','rust-check','web-tests','web-check'],
  case:['case-smoke'],
  e2e:['e2e'],
  pages:['Pages unit, security and static build','Pages browser smoke (Chromium only)'],
});
function fail(msg){throw Error('staging original PR proof: '+msg);}
function successfulStep(job,name){
  return (job.steps??[]).some(s=>s.name===name&&s.conclusion==='success');
}
function validRun(run,kind){
  const [name,path]=WORKFLOWS[kind];
  return run?.repository?.full_name===REPO &&
    run?.head_repository?.full_name===REPO &&
    run.name===name && String(run.path).split('@')[0]===path &&
    run.head_sha===HEAD && run.event==='pull_request' &&
    run.head_branch!==null && run.status==='completed' &&
    run.conclusion==='success' &&
    Number.isSafeInteger(run.id)&&run.id>0 &&
    Number.isSafeInteger(run.run_attempt)&&run.run_attempt>0;
}
export async function verifySourceBoundOriginalPr({issue,pr,runs,comments,headCommit,mergeCommit,get}){
  if(issue?.number!==ISSUE||issue?.state!=='open'||!issue.body?.includes(MARKER)||
      pr?.number!==PR||pr?.head?.sha!==HEAD||pr?.base?.ref!=='staging'||
      pr?.base?.sha!==LANE||pr?.merged!==true||pr?.merge_commit_sha!==MERGE||
      pr?.head?.repo?.full_name!==REPO||pr?.base?.repo?.full_name!==REPO||
      headCommit?.sha!==HEAD ||
      JSON.stringify((headCommit.parents??[]).map(p=>p.sha))!==JSON.stringify([LANE,MAIN])||
      mergeCommit?.sha!==MERGE ||
      JSON.stringify((mergeCommit.parents??[]).map(p=>p.sha))!==JSON.stringify([LANE,HEAD])) {
    fail('wrong Issue, GitHub PR, native merge or exact source parent');
  }
  const contract=auditIssue(issue);
  if(!contract.ok)fail('Issue Audit contract is invalid: '+contract.errors.join('; '));
  const e2e=parseIssueE2E(issue.body,{requireDeclaration:true});
  if(e2e.errors.length||e2e.selectedIds.length!==0||!e2e.newNone||!e2e.regressionNone)
    fail('unexpected or unaudited E2E obligations');
  if(!Array.isArray(comments)||!comments.some(c=>c?.user?.login==='BestNathan' &&
      c?.body?.trim()==='/approve-staging-convergence '+HEAD+' '+e2e.digest))
    fail('missing exact-head and Issue E2E-digest owner approval');
  if(!Array.isArray(runs)||runs.length>50||typeof get!=='function')
    fail('unbounded or invalid Run selection');
  const checks={};
  for(const kind of Object.keys(WORKFLOWS)){
    const matches=runs.filter(r=>validRun(r,kind));
    if(matches.length!==1)fail('missing or ambiguous exact-head '+kind+' GitHub workflow');
    const run=matches[0];
    if(Date.parse(run.created_at)>Date.parse(pr.merged_at) ||
       !Number.isFinite(Date.parse(run.created_at)))
      fail('workflow was not completed for the original merge-time PR');
    const response=await get('/repos/'+REPO+'/actions/runs/'+run.id+
      '/attempts/'+run.run_attempt+'/jobs?per_page=100');
    const jobs=response?.jobs;
    if(!Array.isArray(jobs)||jobs.length>100)fail('unbounded source Job set');
    const byName=new Map();
    for(const job of jobs){
      if(byName.has(job.name)||job.run_id!==run.id||job.conclusion==='failure'||
         job.conclusion==='cancelled')fail('duplicate or failed source Job');
      byName.set(job.name,job);
    }
    for(const name of EXPECTED_JOBS[kind]){
      if(byName.get(name)?.conclusion!=='success')fail('missing successful '+kind+' Job '+name);
    }
    if(kind==='quality'&&!successfulStep(byName.get('tooling-check'),'Verify repository tooling Gates'))
      fail('Quality tooling Gates did not execute');
    if(kind==='case'&&!successfulStep(byName.get('case-smoke'),'Select PR-linked Case-method proofs (trusted main policy)'))
      fail('Case-method selection did not execute');
    if(kind==='e2e'&&(!successfulStep(byName.get('e2e'),'Resolve linked Issue E2E obligations')||
       !successfulStep(byName.get('e2e'),'Enforce authenticated selected-E2E execution result')))
      fail('selected E2E obligations were not evaluated');
    checks[kind]={run_id:run.id,run_attempt:run.run_attempt,source_sha:HEAD,
      workflow:WORKFLOWS[kind][0],conclusion:'success',
      selected_e2e_ids:e2e.selectedIds};
  }
  return Object.freeze({
    schema_version:1,kind:'verified_original_staging_integration_pr',
    issue_number:ISSUE,pr_number:PR,pr_head_sha:HEAD,merge_sha:MERGE,
    source_main_sha:MAIN,source_lane_sha:LANE,
    issue_e2e_digest:e2e.digest,owner_approval:'exact_head_and_digest_verified',
    issue_audit:'contract_valid',e2e_selected_ids:[],
    e2e_scope:'zero selected runnable IDs, owner-approved for this exact batch; not an E2E browser Pass',
    case_scope:'successful Case selector, not an invented executed Case',
    checks,
    conclusion:'authenticated PR facts for read-only Agent assessment; not an SC Pass',
  });
}

async function selfTest(){
  const body=[
    '## Requirements: exact batch',MARKER,'',
    '### Success Criteria','- [ ] SC-01 required','- [x] SC-02 required',
    '## Acceptance Plan','', 'xxx', // Replaced with valid Plan below.
    '## Acceptance Report','| Criterion | Result | Evidence |','|---|---|---|',
    '| SC-01 | Pending | cannot verify PR yet |',
    '| SC-02 | Pass | independently attested exact SHA |',
    '## E2E Verification','### New','- none: no changed IDs',
    '### Regression','- none: no changed IDs',
    '## E2E Report','| ID | Type | Result | Evidence |','|---|---|---|',
    '## Knowledge Impact','- Decision: Read',
    '- Related knowledge: nession-cicd',
    '- Reason: existing E2E obligations',
    '- Owner and timing: owner before merge',
    '- Evidence: exact checked integration head',
    '## Product alignment','- [x] preserves contract',
  ].join('\n').replace('xxx','');
  // Test only helper scope rejection without constructing fake trusted Runs.
  const digest=parseIssueE2E(body,{requireDeclaration:true}).digest;
  assert.match(digest,/^[a-f0-9]{64}$/);
  const pr={number:PR,head:{sha:HEAD,repo:{full_name:REPO}},
    base:{sha:LANE,ref:'staging',repo:{full_name:REPO}},merged:true,
    merge_commit_sha:MERGE,merged_at:'2026-11-08T13:33:39Z'};
  const commits=[
    {sha:HEAD,parents:[{sha:LANE},{sha:MAIN}]},
    {sha:MERGE,parents:[{sha:LANE},{sha:HEAD}]},
  ];
  const issue={number:ISSUE,state:'open',title:'Requirement: Staging integration',
    labels:[{name:'requirement'}],body};
  await assert.rejects(()=>verifySourceBoundOriginalPr({
    issue,pr:{...pr,head:{...pr.head,sha:'a'.repeat(40)}},
    headCommit:commits[0],mergeCommit:commits[1],runs:[],comments:[],get:async()=>null,
  }),/wrong Issue/);
  await assert.rejects(()=>verifySourceBoundOriginalPr({
    issue:{...issue,body:body.replace(MARKER,'')},pr,
    headCommit:commits[0],mergeCommit:commits[1],runs:[],comments:[],get:async()=>null,
  }),/wrong Issue/);
  await assert.rejects(()=>verifySourceBoundOriginalPr({
    issue,pr,headCommit:commits[0],mergeCommit:commits[1],
    runs:[],comments:[],get:async()=>null,
  }),/missing exact-head and Issue E2E-digest owner approval|Issue Audit/);
  console.log('original staging integration PR source proof: wrong PR, wrong SHA, unsigned approval fail closed');
}
async function api(path){
  const token=process.env.GITHUB_TOKEN||process.env.GH_TOKEN;
  if(!token)fail('authenticated GitHub token required');
  const response=await fetch('https://api.github.com'+path,{headers:{
    'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28',
    'User-Agent':'nession-acceptance-original-pr-proof',
  },signal:AbortSignal.timeout(30000)});
  if(!response.ok)fail('GitHub API '+response.status+' for '+path);
  return response.json();
}
async function main(){
  if(process.argv[2]==='self-test'){await selfTest();return;}
  const [, , mode, target, output]=process.argv;
  if(mode!=='collect'||target!==HEAD||!output)fail('usage: collect ORIGINAL_HEAD_SHA OUTPUT');
  const [issue,pr,headCommit,mergeCommit,comments,runData]=await Promise.all([
    api('/repos/'+REPO+'/issues/'+ISSUE),
    api('/repos/'+REPO+'/pulls/'+PR),
    api('/repos/'+REPO+'/commits/'+HEAD),
    api('/repos/'+REPO+'/commits/'+MERGE),
    api('/repos/'+REPO+'/issues/'+ISSUE+'/comments?per_page=100'),
    api('/repos/'+REPO+'/actions/runs?head_sha='+HEAD+'&per_page=100'),
  ]);
  const result=await verifySourceBoundOriginalPr({
    issue,pr,headCommit,mergeCommit,comments,runs:runData.workflow_runs,get:api,
  });
  fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
  console.log('Collected exact source-bound PR #'+PR+' Quality/Case/E2E/Pages evidence for Issue #'+ISSUE);
}
if(process.argv[1]?.endsWith('acceptance-staging-batch-pr-evidence.mjs'))
  main().catch(e=>{console.error(e);process.exitCode=2;});
